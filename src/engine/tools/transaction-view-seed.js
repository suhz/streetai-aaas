import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { readText, readJson, writeJson } from '../../utils/workspace.js';
import {
  parseTransactionFieldsBlock,
  isTemplateDefault,
  findTransactionFieldsSpan,
  reconcileFromSkill,
} from './transaction-view.js';

/**
 * One-shot LLM seeding for the `## Transaction Fields` block.
 *
 * Goal: when a workspace's SKILL.md has either no Transaction Fields block,
 * or the unmodified template scaffolding, ask the LLM exactly once to infer
 * a sensible per-service schema from the rest of SKILL.md and write the
 * result back into SKILL.md as a real block.
 *
 * After seeding, the deterministic parser owns the schema forever — the LLM
 * is never consulted again unless the admin deliberately deletes the block.
 *
 * The seeding step is best-effort and fully isolated:
 *  - Failures never propagate to the caller (writeSkill, engine init, etc.).
 *  - Concurrent callers are deduped via the seed-state file.
 *  - Already-customized blocks are left untouched.
 */

const SEED_STATE_FILENAME = '_txn_fields_seed.json';
const MIN_RETRY_INTERVAL_MS = 5 * 60 * 1000; // 5 min cooldown on failure
const MAX_FIELDS = 12;
const KEY_RE = /^[a-z][a-z0-9_]*$/;
const VALID_TYPES = new Set([
  'text', 'number', 'currency', 'percentage', 'rating',
  'date', 'datetime', 'boolean', 'list', 'object_list',
]);
const VALID_ITEM_TYPES = new Set([
  'text', 'number', 'currency', 'percentage', 'rating',
  'date', 'datetime', 'boolean', 'list',
]);
const MAX_ITEM_FIELDS = 8;

function seedStatePath(paths) {
  return path.join(path.dirname(paths.transactionView), SEED_STATE_FILENAME);
}

function hashSkill(text) {
  return crypto.createHash('sha256').update(text || '').digest('hex').slice(0, 16);
}

function loadSeedState(paths) {
  return readJson(seedStatePath(paths)) || {};
}

function saveSeedState(paths, state) {
  fs.mkdirSync(path.dirname(seedStatePath(paths)), { recursive: true });
  writeJson(seedStatePath(paths), state);
}

/**
 * Decide whether the workspace currently needs a seeding pass.
 *
 * Returns one of:
 *   { needed: false, reason: '...' }
 *   { needed: true, parsed, mode: 'missing' | 'template' }
 */
export function evaluateSeedNeed(skillText) {
  if (!skillText || typeof skillText !== 'string') {
    return { needed: false, reason: 'skill_empty' };
  }
  const parsed = parseTransactionFieldsBlock(skillText);
  if (!parsed.found) {
    return { needed: true, parsed, mode: 'missing' };
  }
  if (isTemplateDefault(parsed)) {
    return { needed: true, parsed, mode: 'template' };
  }
  return { needed: false, reason: 'customized' };
}

/**
 * Public entry. Fire-and-forget friendly.
 *
 *   await maybeSeedTransactionFields({ paths, provider });
 *
 * Reads SKILL.md from disk, evaluates need, runs one LLM call if warranted,
 * writes the block back into SKILL.md, and reconciles the derived config.
 *
 * Returns a small status object. Never throws.
 */
export async function maybeSeedTransactionFields({ paths, provider, logger = null }) {
  try {
    if (!provider || typeof provider.chat !== 'function') {
      return { seeded: false, reason: 'no_provider' };
    }
    const skillText = readText(paths.skill);
    if (!skillText) return { seeded: false, reason: 'no_skill' };

    const need = evaluateSeedNeed(skillText);
    if (!need.needed) return { seeded: false, reason: need.reason };

    const skillHash = hashSkill(skillText);
    const state = loadSeedState(paths);

    // Already seeded successfully against this exact skill text — skip.
    if (state.lastSuccessHash === skillHash) {
      return { seeded: false, reason: 'already_seeded' };
    }
    // Recently attempted and failed — back off so we don't hammer the API.
    if (state.lastTriedHash === skillHash &&
        state.lastTriedAt &&
        Date.now() - state.lastTriedAt < MIN_RETRY_INTERVAL_MS) {
      return { seeded: false, reason: 'recent_failure_cooldown' };
    }

    // Mark attempt before the call so concurrent processes back off.
    saveSeedState(paths, {
      ...state,
      lastTriedHash: skillHash,
      lastTriedAt: Date.now(),
    });

    const proposed = await proposeFieldsFromSkill({ skillText, provider });
    if (!proposed || !proposed.fields || !proposed.fields.length) {
      return { seeded: false, reason: 'no_fields_returned' };
    }

    const blockText = renderBlock(proposed.fields, proposed.itemFields);
    const newSkill = applyBlockToSkill(skillText, blockText);
    if (!newSkill || newSkill === skillText) {
      return { seeded: false, reason: 'no_changes' };
    }

    fs.writeFileSync(paths.skill, newSkill, 'utf-8');
    try { reconcileFromSkill(paths, newSkill); } catch { /* non-fatal */ }

    saveSeedState(paths, {
      lastSuccessHash: hashSkill(newSkill),
      lastSuccessAt: Date.now(),
      lastTriedHash: skillHash,
      lastTriedAt: Date.now(),
      fieldCount: proposed.fields.length,
      itemFieldCount: proposed.itemFields.length,
    });

    if (logger) logger(`Transaction fields seeded (${proposed.fields.length} fields${proposed.itemFields.length ? `, ${proposed.itemFields.length} item fields` : ''})`);
    return { seeded: true, fields: proposed.fields, itemFields: proposed.itemFields, mode: need.mode };
  } catch (err) {
    if (logger) logger(`Transaction fields seeding failed: ${err.message}`);
    return { seeded: false, reason: 'error', error: err.message };
  }
}

/**
 * Ask the LLM for a list of field definitions. Returns a validated array of
 * `{ key, type, required, column, label }` records, or [] on any failure.
 */
async function proposeFieldsFromSkill({ skillText, provider }) {
  const system = [
    'You are a schema-design assistant for the AaaS (Agent as a Service) platform.',
    'You read a service description (SKILL.md) and propose the transaction fields the agent should capture.',
    '',
    'OUTPUT RULES — read carefully:',
    '- Reply with ONE JSON object on a single line. No prose. No markdown fences.',
    '- Shape: {"fields":[...], "item_fields":[...] }',
    '  - fields: [{"key":"...","type":"...","required":true|false,"column":true|false,"label":"..."}]',
    '  - item_fields: same shape, declares the structure of each entry when `fields` includes an `object_list` field. Omit (or empty array) when no field is object_list.',
    '- key: lowercase snake_case, starts with a letter, [a-z0-9_]. No spaces.',
    '- type: one of "text","number","currency","percentage","rating","date","datetime","boolean","list","object_list".',
    '  - Use "list" for a simple array of strings (e.g. tags, dietary restrictions).',
    '  - Use "object_list" when each entry needs sub-fields (e.g. ordered items with name + quantity + price). Pair it with `item_fields` describing the per-item shape.',
    '- required: mark TRUE only if a transaction is meaningless without it. Default to FALSE when in doubt.',
    '- column: TRUE if the field belongs in the main dashboard table. Aim for 3-6 columns total.',
    '- label: short human-friendly title (Title Case).',
    '- Max 12 transaction fields, max 8 item fields. Always include `service`, and include `cost` (currency) when the service involves payment.',
    '- Do NOT include status, created_at, id, user_id — the platform handles those automatically.',
    '- Pick fields appropriate for the actual service described:',
    '  - Restaurant / cafe: items (object_list with name, quantity, price), table_number, dine_in_or_takeout.',
    '  - E-commerce: items (object_list with name, quantity, price), shipping_address.',
    '  - Booking / appointment: date, time, party_size, location.',
    '  - Consulting / services: topic, scheduled_at, duration_minutes.',
    '  - Only use `object_list` when each entry actually has multiple meaningful sub-fields. For simple labels/tags use `list`.',
  ].join('\n');

  const user = [
    'Here is the SKILL.md content for this agent. Propose the transaction fields it should capture.',
    '',
    '--- SKILL.md ---',
    truncate(skillText, 8000),
    '--- end ---',
    '',
    'Respond with the JSON object only.',
  ].join('\n');

  const result = await provider.chat(
    [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    { temperature: 0.2, maxTokens: 1500 },
  );

  const text = (result && result.content) || '';
  return validateProposed(extractJson(text));
}

function validateItemFields(arr) {
  if (!Array.isArray(arr)) return [];
  const seen = new Set();
  const out = [];
  for (const f of arr) {
    if (!f || typeof f !== 'object') continue;
    const key = typeof f.key === 'string' ? f.key.trim().toLowerCase() : '';
    if (!KEY_RE.test(key)) continue;
    if (seen.has(key)) continue;
    seen.add(key);

    const type = typeof f.type === 'string' && VALID_ITEM_TYPES.has(f.type) ? f.type : 'text';
    const required = !!f.required;
    const label = typeof f.label === 'string' && f.label.trim()
      ? f.label.trim().slice(0, 60)
      : null;

    out.push({ key, type, required, label });
    if (out.length >= MAX_ITEM_FIELDS) break;
  }
  return out;
}

function truncate(s, max) {
  if (!s) return '';
  return s.length > max ? s.slice(0, max) + '\n[... truncated ...]' : s;
}

/**
 * Pull the first JSON object out of the model's reply. Tolerant of stray
 * prose or accidental code fences.
 */
function extractJson(text) {
  if (!text) return null;
  // Strip ```json ... ``` or ``` ... ``` fences if present.
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const body = fence ? fence[1] : text;
  // Greedy match the outermost {...}.
  const m = body.match(/\{[\s\S]*\}/);
  if (!m) return null;
  try { return JSON.parse(m[0]); } catch { return null; }
}

/**
 * Validate and sanitize the LLM's proposal. Returns a clean array, or [] if
 * the response is unusable.
 */
function validateProposed(obj) {
  if (!obj || !Array.isArray(obj.fields)) return { fields: [], itemFields: [] };
  const seen = new Set();
  const out = [];
  for (const f of obj.fields) {
    if (!f || typeof f !== 'object') continue;
    const key = typeof f.key === 'string' ? f.key.trim().toLowerCase() : '';
    if (!KEY_RE.test(key)) continue;
    if (seen.has(key)) continue;
    // Platform-managed keys: never let the LLM redeclare these.
    if (['id', 'user_id', 'status', 'created_at', 'completed_at', 'archived', 'archived_at'].includes(key)) continue;
    seen.add(key);

    const type = typeof f.type === 'string' && VALID_TYPES.has(f.type) ? f.type : 'text';
    const required = !!f.required;
    const column = !!f.column;
    const label = typeof f.label === 'string' && f.label.trim()
      ? f.label.trim().slice(0, 60)
      : null;

    out.push({ key, type, required, column, label });
    if (out.length >= MAX_FIELDS) break;
  }
  // Sanity floor: must contain at least `service`. If missing, prepend
  // (and trim from the tail to stay within MAX_FIELDS).
  if (!out.some(f => f.key === 'service')) {
    out.unshift({ key: 'service', type: 'text', required: true, column: true, label: 'Service' });
    if (out.length > MAX_FIELDS) out.length = MAX_FIELDS;
  }

  // Only keep item_fields when at least one field is declared as object_list —
  // otherwise the Item Fields block would be dangling and confuse the parser.
  const usesObjectList = out.some(f => f.type === 'object_list');
  const itemFields = usesObjectList ? validateItemFields(obj.item_fields) : [];
  return { fields: out, itemFields };
}

/**
 * Render the validated transaction fields as a `## Transaction Fields` block,
 * optionally followed by a `## Item Fields` sibling block when one or more
 * fields are declared `object_list`.
 */
function renderBlock(fields, itemFields) {
  const lines = ['## Transaction Fields', ''];
  for (const f of fields) {
    const flags = [];
    if (f.type && f.type !== 'text') flags.push(f.type);
    if (f.required) flags.push('required');
    if (f.column) flags.push('column');
    const parens = flags.length ? ` (${flags.join(', ')})` : '';
    const label = f.label ? ` — ${f.label}` : '';
    lines.push(`- ${f.key}${parens}${label}`);
  }
  if (Array.isArray(itemFields) && itemFields.length) {
    lines.push('', '---', '', '## Item Fields', '');
    for (const f of itemFields) {
      const flags = [];
      if (f.type && f.type !== 'text') flags.push(f.type);
      if (f.required) flags.push('required');
      const parens = flags.length ? ` (${flags.join(', ')})` : '';
      const label = f.label ? ` — ${f.label}` : '';
      lines.push(`- ${f.key}${parens}${label}`);
    }
  }
  return lines.join('\n');
}

/**
 * Splice the rendered block into SKILL.md. If a block already exists, its
 * span is replaced. Otherwise the block is appended at the end with a
 * horizontal-rule separator above it.
 */
function applyBlockToSkill(skillText, blockText) {
  // First strip any pre-existing `## Item Fields` block so the seeded version
  // (which may or may not include one) becomes the single source of truth.
  // Without this we could end up with two Item Fields sections after a re-seed.
  let working = stripItemFieldsBlock(skillText);

  const span = findTransactionFieldsSpan(working);
  if (span) {
    return working.slice(0, span.start) + blockText + working.slice(span.end);
  }
  // Append: ensure exactly one blank line and a separator before the new block.
  const trimmed = working.replace(/\s+$/, '');
  return `${trimmed}\n\n---\n\n${blockText}\n`;
}

function stripItemFieldsBlock(skillText) {
  const re = /(\n+\s*-{3,}\s*)?\n##\s+Item\s+Fields\s*\n[\s\S]*?(?=\n##\s+|\n#\s+|$)/i;
  return skillText.replace(re, '');
}
