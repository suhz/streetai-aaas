import fs from 'fs';
import path from 'path';
import { readText, readJson, writeJson } from '../../utils/workspace.js';

/**
 * Transaction view configuration: parser + reconciler + merger.
 *
 * SKILL.md may contain a `## Transaction Fields` block that declares which
 * fields the agent captures per transaction and how the dashboard should
 * render them. The block is the source of truth for the *derived* config.
 * The owner can rearrange/rename/hide via the dashboard, which writes an
 * *overrides* layer. The effective config exposed at the top level of
 * `.aaas/transaction_view.json` is the merge of derived + overrides.
 *
 * File shape:
 *   {
 *     "_skill_derived":   { table_columns, detail_sections, labels, formats },
 *     "_owner_overrides": { column_order?, hidden?, labels?, formats? },
 *     // merged effective config (what the dashboard reads):
 *     "table_columns":   [...],
 *     "detail_sections": [...],
 *     "labels":          {...},
 *     "formats":         {...}
 *   }
 *
 * Backwards compatibility: workspaces with a flat config (just the merged
 * fields, no _skill_derived) are read as-is. The first reconcile call after
 * an upgrade will rebuild _skill_derived from SKILL.md if a block exists,
 * otherwise the flat config is preserved untouched.
 */

const FORMAT_KEYS = new Set(['currency', 'percentage', 'rating', 'date', 'datetime', 'boolean', 'list']);
const DEFAULT_COLUMN_CAP = 4;

/**
 * Parse the `## Transaction Fields` block from SKILL.md.
 *
 * Block format (one field per line, all parts after the key are optional):
 *   - field_key (type, column) — Display Label
 *   - field_key (type) — Display Label
 *   - field_key (column)
 *   - field_key
 *
 * `type` is one of: text, number, currency, percentage, date, datetime,
 * rating, boolean, list. Only the formatting types are written to `formats`;
 * `text` and `number` are accepted but produce no format entry.
 *
 * The `column` flag marks a field as a table column. Fields appear in the
 * table in the order listed. If no field carries the flag, the first
 * DEFAULT_COLUMN_CAP fields become columns.
 *
 * Returns:
 *   { found: boolean, fields: [{ key, type, isColumn, label }] }
 */
export function parseTransactionFieldsBlock(skillText) {
  return parseBlockBy(skillText, /(^|\n)##\s+Transaction\s+Fields\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i);
}

/**
 * Parse the `## Item Fields` block. Same line syntax as Transaction Fields.
 * Used when a transaction field is declared as `object_list` — the agent then
 * captures each item as an object whose shape is defined here.
 *
 *   ## Item Fields
 *   - name (text, required)
 *   - quantity (number, required)
 *   - price (currency)
 *   - notes (text, optional)
 */
export function parseItemFieldsBlock(skillText) {
  return parseBlockBy(skillText, /(^|\n)##\s+Item\s+Fields\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i);
}

/**
 * Shared parser for `## <heading>` blocks whose body is a bulleted list of
 * field declarations. Used by both Transaction Fields and Item Fields.
 */
function parseBlockBy(skillText, headingRe) {
  if (!skillText || typeof skillText !== 'string') {
    return { found: false, fields: [] };
  }
  const m = skillText.match(headingRe);
  if (!m) return { found: false, fields: [] };

  const body = m[2];
  const lineRe = /^\s*[-*]\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*(?:\(([^)]*)\))?\s*(?:[—–-]\s*(.+?))?\s*$/;
  const fields = [];
  const seen = new Set();

  for (const raw of body.split('\n')) {
    const lm = raw.match(lineRe);
    if (!lm) continue;

    const key = lm[1];
    if (seen.has(key)) continue;
    seen.add(key);

    const parens = (lm[2] || '').toLowerCase();
    const label = (lm[3] || '').trim() || null;

    let type = null;
    let isColumn = false;
    let isRequired = false;
    let isOptional = false;
    if (parens) {
      const parts = parens.split(',').map(s => s.trim()).filter(Boolean);
      for (const p of parts) {
        if (p === 'column') isColumn = true;
        else if (p === 'required') isRequired = true;
        else if (p === 'optional') isOptional = true;
        else if (!type) type = p; // first non-flag token is the type
      }
    }
    void isOptional; // required wins when both are present

    fields.push({ key, type, isColumn, isRequired, label });
  }

  return { found: fields.length > 0, fields };
}

/**
 * Type mapping used when generating a JSON schema for create_transaction /
 * update_transaction from the parsed block. Anything not listed here
 * defaults to "string" so unknown / free-text types still work safely.
 */
const TYPE_TO_JSON_SCHEMA = {
  currency:   { type: 'number', description_suffix: 'Numeric amount, no currency symbol; e.g. 24.50.' },
  percentage: { type: 'number' },
  rating:     { type: 'number' },
  number:     { type: 'number' },
  boolean:    { type: 'boolean' },
  date:       { type: 'string', format: 'date' },
  datetime:   { type: 'string', format: 'date-time' },
  list:       { type: 'array', items: { type: 'string' } },
  text:       { type: 'string' },
};

/**
 * Build the JSON-schema fragment to merge into the create_transaction
 * tool definition for this workspace.
 *
 * Returns { properties: {...}, required: [...] }. Empty objects when no
 * block is parsed — caller can safely spread without conditionals.
 *
 * Field names are kept exactly as declared in SKILL.md so the agent's
 * payload lands as top-level keys on the saved transaction, matching what
 * the dashboard renders.
 */
export function buildToolFieldSchema(parsed, parsedItems) {
  const out = { properties: {}, required: [] };
  if (!parsed || !parsed.fields || parsed.fields.length === 0) return out;

  // Pre-build the item object schema once if Item Fields are declared. Used
  // wherever a transaction field has type `object_list` to constrain the
  // per-item shape (e.g. items: [{ name, quantity, price }]).
  const itemObjectSchema = buildItemObjectSchema(parsedItems);

  for (const f of parsed.fields) {
    const desc = f.label || prettyKey(f.key);
    let property;
    if (f.type === 'object_list') {
      property = itemObjectSchema
        ? { type: 'array', items: { ...itemObjectSchema } }
        : { type: 'array', items: { type: 'object' } };
      property.description = `${desc}. Each entry is an object — populate the declared sub-fields.`;
    } else {
      const mapped = TYPE_TO_JSON_SCHEMA[f.type] || { type: 'string' };
      property = { ...mapped };
      delete property.description_suffix;
      property.description = mapped.description_suffix
        ? `${desc}. ${mapped.description_suffix}`
        : desc;
    }
    out.properties[f.key] = property;
    if (f.isRequired) out.required.push(f.key);
  }
  return out;
}

/**
 * Build the `items: { ... }` JSON-schema fragment for an `object_list` field
 * from the parsed `## Item Fields` block. Returns null if no Item Fields are
 * declared — caller falls back to a permissive `{ type: 'object' }`.
 */
function buildItemObjectSchema(parsedItems) {
  if (!parsedItems || !parsedItems.fields || parsedItems.fields.length === 0) return null;
  const properties = {};
  const required = [];
  for (const f of parsedItems.fields) {
    const mapped = TYPE_TO_JSON_SCHEMA[f.type] || { type: 'string' };
    const desc = f.label || prettyKey(f.key);
    const prop = { ...mapped };
    delete prop.description_suffix;
    prop.description = mapped.description_suffix ? `${desc}. ${mapped.description_suffix}` : desc;
    properties[f.key] = prop;
    if (f.isRequired) required.push(f.key);
  }
  const schema = { type: 'object', properties };
  if (required.length) schema.required = required;
  return schema;
}

function prettyKey(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

/**
 * Extract the list of declared services from SKILL.md's `## Service Catalog`
 * section. Each `### ...` subheading under that section becomes one entry.
 * A leading "Service N: " prefix from the template is stripped so the
 * canonical name is what the agent actually picks.
 *
 * Returns an array of names (deduped, order preserved). Empty when no
 * catalog section exists — caller treats that as "no enum, free-form."
 */
export function parseServiceCatalog(skillText) {
  if (!skillText || typeof skillText !== 'string') return [];
  const headingRe = /(^|\n)##\s+Service\s+Catalog\s*\n([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i;
  const m = skillText.match(headingRe);
  if (!m) return [];
  const body = m[2];
  const names = [];
  const seen = new Set();
  const subRe = /^###\s+(?:Service\s*\d+\s*:\s*)?(.+?)\s*$/gm;
  let sm;
  while ((sm = subRe.exec(body)) !== null) {
    const raw = sm[1].trim();
    if (!raw) continue;
    // Skip unfilled template placeholders like "[Name]".
    if (/^\[.+\]$/.test(raw)) continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    names.push(raw);
  }
  return names;
}

/**
 * Build a fresh derived config object from a parsed block. Pure function.
 * `parsedItems` is the optional `## Item Fields` parse — when present, the
 * config exposes `item_fields` so the dashboard can render an Items table
 * with the declared column order and labels.
 */
export function buildDerivedConfig(parsed, parsedItems) {
  if (!parsed || !parsed.fields || parsed.fields.length === 0) {
    return null;
  }

  const explicitColumns = parsed.fields.filter(f => f.isColumn).map(f => f.key);
  const tableColumns = explicitColumns.length
    ? explicitColumns
    : parsed.fields.slice(0, DEFAULT_COLUMN_CAP).map(f => f.key);

  const labels = {};
  const formats = {};
  for (const f of parsed.fields) {
    if (f.label) labels[f.key] = f.label;
    if (f.type && FORMAT_KEYS.has(f.type)) formats[f.key] = f.type;
    // Item Fields also contribute formats/labels for the items sub-shape — keep
    // them on the same maps so a single `format`/`label` lookup serves both
    // top-level fields and item columns. Item keys (e.g. `quantity`) are
    // unlikely to collide with top-level keys (e.g. `cost`); when they do,
    // the top-level field wins (already set above).
  }
  if (parsedItems && Array.isArray(parsedItems.fields)) {
    for (const f of parsedItems.fields) {
      if (f.label && !labels[f.key]) labels[f.key] = f.label;
      if (f.type && FORMAT_KEYS.has(f.type) && !formats[f.key]) formats[f.key] = f.type;
    }
  }

  const detailSections = [{
    title: 'Service Details',
    fields: parsed.fields.map(f => f.key),
  }];

  const out = {
    table_columns: tableColumns,
    detail_sections: detailSections,
    labels,
    formats,
  };

  if (parsedItems && Array.isArray(parsedItems.fields) && parsedItems.fields.length) {
    out.item_fields = parsedItems.fields.map(f => ({
      key: f.key,
      type: f.type || null,
      required: !!f.isRequired,
      label: f.label || null,
    }));
  }

  return out;
}

/**
 * Merge derived config with owner overrides into the effective top-level
 * fields that the dashboard reads. Pure function.
 *
 * Override semantics:
 *  - column_order: reorders table_columns. Unknown keys are dropped; derived
 *    columns not listed are appended (so new skill fields auto-appear).
 *  - hidden: keys removed from table_columns (NOT from detail_sections —
 *    to drop a field from the detail view, edit SKILL.md to remove it from
 *    the block).
 *  - labels / formats: shallow-merged on top of derived.
 */
export function mergeWithOverrides(derived, overrides) {
  const d = derived || {};
  const o = overrides || {};
  const hidden = new Set(Array.isArray(o.hidden) ? o.hidden : []);

  // ── table_columns ──
  const derivedCols = Array.isArray(d.table_columns) ? d.table_columns.filter(k => !hidden.has(k)) : [];
  let tableColumns;
  if (Array.isArray(o.column_order) && o.column_order.length) {
    const ordered = o.column_order.filter(k => derivedCols.includes(k));
    const orderedSet = new Set(ordered);
    const tail = derivedCols.filter(k => !orderedSet.has(k));
    tableColumns = [...ordered, ...tail];
  } else {
    tableColumns = derivedCols;
  }

  // ── detail_sections ──
  // Detail view always shows the full derived set. The owner removes fields
  // from the detail view by editing SKILL.md, not via overrides.
  const detailSections = Array.isArray(d.detail_sections) ? d.detail_sections : [];

  // ── labels / formats ──
  const labels = { ...(d.labels || {}), ...(o.labels || {}) };
  const formats = { ...(d.formats || {}), ...(o.formats || {}) };

  // ── item_fields ──
  // Pass-through from derived. Owner overrides do not currently touch item
  // field shape — the contract is "SKILL.md owns item structure." Future
  // enhancement could add per-item column hide/reorder overrides, mirroring
  // the table_columns/column_order pattern.
  const out = { table_columns: tableColumns, detail_sections: detailSections, labels, formats };
  if (Array.isArray(d.item_fields) && d.item_fields.length) {
    out.item_fields = d.item_fields;
  }
  return out;
}

/**
 * Read the on-disk config, normalize legacy flat shape into the new layered
 * shape (without overwriting anything), and return both layers.
 */
function loadLayered(paths) {
  const existing = readJson(paths.transactionView) || {};
  const hasLayers = '_skill_derived' in existing || '_owner_overrides' in existing;

  if (hasLayers) {
    return {
      derived: existing._skill_derived || null,
      overrides: existing._owner_overrides || {},
    };
  }

  // Legacy flat config: treat the whole thing as derived so the dashboard
  // keeps showing the same columns until the next reconcile or save.
  const hasAnyKey = ['table_columns', 'detail_sections', 'labels', 'formats']
    .some(k => existing[k] != null);
  return {
    derived: hasAnyKey ? {
      table_columns: existing.table_columns || [],
      detail_sections: existing.detail_sections || [],
      labels: existing.labels || {},
      formats: existing.formats || {},
    } : null,
    overrides: {},
  };
}

/**
 * Persist the layered config and the merged effective fields to disk.
 */
function persistLayered(paths, { derived, overrides }) {
  const merged = mergeWithOverrides(derived, overrides);
  const out = {
    _skill_derived: derived || null,
    _owner_overrides: overrides || {},
    ...merged,
  };
  fs.mkdirSync(path.dirname(paths.transactionView), { recursive: true });
  writeJson(paths.transactionView, out);
  return out;
}

/**
 * Reconcile transaction_view.json from the current SKILL.md content.
 *
 * Called by writeSkill (after writing) and by the dashboard when reading.
 * If the block is missing, leaves any existing derived config alone — we
 * never silently drop the owner's setup just because they re-saved a skill
 * that forgot the block.
 */
export function reconcileFromSkill(paths, skillText) {
  const parsed = parseTransactionFieldsBlock(skillText);
  const parsedItems = parseItemFieldsBlock(skillText);
  const { derived: prevDerived, overrides } = loadLayered(paths);

  let nextDerived = prevDerived;
  if (parsed.found) {
    nextDerived = buildDerivedConfig(parsed, parsedItems);
  }

  // If there's nothing on disk and no block in skill, do nothing — the
  // dashboard's frequency scanner handles this case.
  if (!nextDerived && !prevDerived && (!overrides || Object.keys(overrides).length === 0)) {
    return null;
  }

  return persistLayered(paths, { derived: nextDerived, overrides });
}

/**
 * Save owner overrides (called from the dashboard editor and from
 * saveTransactionView). Re-merges and writes the effective config.
 */
export function saveOwnerOverrides(paths, overrides) {
  const { derived } = loadLayered(paths);
  const clean = sanitizeOverrides(overrides);
  return persistLayered(paths, { derived, overrides: clean });
}

function sanitizeOverrides(o) {
  if (!o || typeof o !== 'object') return {};
  const out = {};
  if (Array.isArray(o.column_order)) {
    out.column_order = o.column_order.filter(k => typeof k === 'string');
  }
  if (Array.isArray(o.hidden)) {
    out.hidden = o.hidden.filter(k => typeof k === 'string');
  }
  if (o.labels && typeof o.labels === 'object') {
    out.labels = {};
    for (const [k, v] of Object.entries(o.labels)) {
      if (typeof k === 'string' && typeof v === 'string' && v.trim()) out.labels[k] = v.trim();
    }
  }
  if (o.formats && typeof o.formats === 'object') {
    out.formats = {};
    for (const [k, v] of Object.entries(o.formats)) {
      if (typeof k === 'string' && typeof v === 'string' && FORMAT_KEYS.has(v)) out.formats[k] = v;
    }
  }
  return out;
}

/**
 * Read the current layered state — used by the dashboard editor to show the
 * derived list separately from the overrides.
 */
export function readLayered(paths) {
  return loadLayered(paths);
}

/**
 * Exact field signature of the unmodified template block shipped with
 * `aaas init`. If a workspace's parsed block matches this signature, treat
 * it as "still scaffolding" — i.e. the admin has not customized the schema.
 *
 * Kept in sync with templates/workspace/skills/aaas/SKILL.md. If the template
 * changes, add the new signature to this list rather than replacing — older
 * workspaces should still be recognized.
 */
const TEMPLATE_DEFAULT_SIGNATURES = [
  // v1 — original template fields
  [
    { key: 'service',    isRequired: true,  isColumn: true,  type: null },
    { key: 'status',     isRequired: false, isColumn: true,  type: null },
    { key: 'cost',       isRequired: true,  isColumn: true,  type: 'currency' },
    { key: 'created_at', isRequired: false, isColumn: false, type: 'datetime' },
  ],
];

/**
 * Returns true if the parsed block is the unmodified template scaffolding.
 * Used by the seeding layer to decide whether to propose a real schema.
 */
export function isTemplateDefault(parsed) {
  if (!parsed || !parsed.found || !Array.isArray(parsed.fields)) return false;
  return TEMPLATE_DEFAULT_SIGNATURES.some(sig => signatureMatches(sig, parsed.fields));
}

function signatureMatches(sig, fields) {
  if (sig.length !== fields.length) return false;
  for (let i = 0; i < sig.length; i++) {
    const a = sig[i];
    const b = fields[i];
    if (a.key !== b.key) return false;
    if (!!a.isRequired !== !!b.isRequired) return false;
    if (!!a.isColumn !== !!b.isColumn) return false;
    if ((a.type || null) !== (b.type || null)) return false;
  }
  return true;
}

/**
 * Locate the `## Transaction Fields` block in SKILL.md and return its byte
 * span plus the body text. Returns null when no such heading exists.
 *
 * The span runs from the `##` line through (but not including) the next H2/H1
 * heading or EOF. Trailing horizontal-rule (`---`) lines are excluded so the
 * caller can replace the block cleanly without disturbing section separators.
 */
export function findTransactionFieldsSpan(skillText) {
  if (!skillText || typeof skillText !== 'string') return null;
  const headingRe = /(^|\n)(##\s+Transaction\s+Fields\s*\n)([\s\S]*?)(?=\n##\s+|\n#\s+|$)/i;
  const m = headingRe.exec(skillText);
  if (!m) return null;

  const leading = m[1] || '';
  const headingStart = m.index + leading.length;
  let blockEnd = m.index + m[0].length;

  // Trim trailing blank lines + horizontal rule so we replace only the
  // section content, not the separator that follows it.
  const tail = skillText.slice(headingStart, blockEnd);
  const trimmed = tail.replace(/\n+\s*-{3,}\s*$/, '').replace(/\s+$/, '');
  blockEnd = headingStart + trimmed.length;

  return {
    start: headingStart,
    end: blockEnd,
    body: m[3],
  };
}
