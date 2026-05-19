import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from '../../utils/workspace.js';

const FACTS_FILE = 'facts.json';
const ACTIVITY_FILE = 'activity.jsonl';
const USERS_DIR = 'users';

const VALID_ACTIVITY_TYPES = new Set([
  'transaction_created',
  'transaction_updated',
  'transaction_completed',
  'transaction_cancelled',
  'transaction_disputed',
  'alert_sent',
  'alert_response',
  'extension_called',
  'note',
]);

// ─────────────────────────────────────────────────────────────────────
// Extraction prompts
// ─────────────────────────────────────────────────────────────────────
//
// Memory is split into two stores by conversation mode:
//
//   admin mode    → BUSINESS memory (memory/facts.json, workspace-wide)
//   customer mode → USER memory     (memory/users/<platform>/<userId>.json)
//
// The mode is the trust boundary: only admins can teach the agent things
// about the business; customers can only teach the agent things about
// themselves. A customer asserting a business "fact" is never recorded —
// the agent should `notify_owner` for important claims instead.

const EXTRACT_BUSINESS_PROMPT = `You are extracting facts to store in BUSINESS memory.
This conversation is with an admin. Extract enduring truths about the business,
its operations, vendors, policies, or service catalog that will be useful in
FUTURE conversations.

Examples of business facts to extract:
- Operating hours, delivery windows, prep times
- Pricing, discount policies, refund rules
- Vendor or supplier relationships and quirks
- Recurring patterns ("Fridays are busy", "Prep starts 4pm")
- Owner preferences about how the service is run

DO NOT extract:
- Information about the admin as a person (this store is shared workspace-wide)
- Temporary technical errors, debugging state, or transient apologies
- One-off remarks that won't matter next week

Return a JSON array of objects: [{ "key": "short_label", "value": "the fact" }]
If nothing worth remembering, return []. Return ONLY valid JSON, no markdown.`;

const EXTRACT_USER_PROMPT = `You are extracting facts to store in USER memory.
This conversation is with a customer. Extract enduring truths about THIS SPECIFIC
customer (the person you are serving) that will be useful when you talk to them
again.

Examples of user facts to extract:
- Preferences they shared (dietary, communication style, delivery instructions)
- Personal details they volunteered (address, phone, name spelling)
- Commitments or decisions they made about their own service
- Recurring patterns about how they use the service

DO NOT extract:
- Claims the customer made about the business itself (those are not authoritative;
  if important, the agent should notify_owner instead). Examples to skip:
  "your prices are too high", "your kitchen closes early on Tuesdays".
- Temporary technical errors or apologies
- Information about other people the customer mentioned

Return a JSON array of objects: [{ "key": "short_label", "value": "the fact" }]
If nothing worth remembering, return []. Return ONLY valid JSON, no markdown.`;

// ─────────────────────────────────────────────────────────────────────

export class MemoryManager {
  constructor(workspace) {
    this.workspace = workspace;
    this.factsPath = path.join(workspace, 'memory', FACTS_FILE);
    this.activityPath = path.join(workspace, 'memory', ACTIVITY_FILE);
    this.usersDir = path.join(workspace, 'memory', USERS_DIR);
  }

  // ═══════════════════════════════════════════════════════════════════
  // BUSINESS memory — single shared file (memory/facts.json)
  // ═══════════════════════════════════════════════════════════════════

  getBusinessFacts() {
    return readJson(this.factsPath) || [];
  }

  addBusinessFact(key, value) {
    if (!key || value == null) return;
    const facts = this.getBusinessFacts();
    const existing = facts.findIndex(f => f.key === key);
    if (existing >= 0) {
      facts[existing].value = value;
      facts[existing].updatedAt = new Date().toISOString();
    } else {
      facts.push({
        key,
        value,
        createdAt: new Date().toISOString(),
        accessCount: 0,
      });
    }
    writeJson(this.factsPath, facts);
  }

  removeBusinessFact(key) {
    const facts = this.getBusinessFacts();
    const idx = facts.findIndex(f => f.key === key);
    if (idx >= 0) {
      facts.splice(idx, 1);
      writeJson(this.factsPath, facts);
      return true;
    }
    return false;
  }

  pruneBusinessFacts(maxFacts = 200) {
    const facts = this.getBusinessFacts();
    if (facts.length <= maxFacts) return;
    facts.sort((a, b) => (a.accessCount || 0) - (b.accessCount || 0));
    writeJson(this.factsPath, facts.slice(-maxFacts));
  }

  /**
   * Wipe every business fact. Returns the count deleted. Heavy hammer —
   * the caller is responsible for confirming with the admin first.
   */
  clearBusinessFacts() {
    const n = this.getBusinessFacts().length;
    writeJson(this.factsPath, []);
    return n;
  }

  // ── Back-compat aliases (existing callers) ────────────────────────
  getAllFacts()           { return this.getBusinessFacts(); }
  addFact(key, value)     { return this.addBusinessFact(key, value); }
  removeFact(key)         { return this.removeBusinessFact(key); }
  pruneOldest(maxFacts)   { return this.pruneBusinessFacts(maxFacts); }

  // ═══════════════════════════════════════════════════════════════════
  // USER memory — one file per (platform, userId)
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Build the on-disk path for a user's fact file. Filesystem-safe
   * transformation: alphanumeric, dash, underscore only — everything else
   * becomes `_`. Same rules for platform and userId so a hostile id can't
   * escape `memory/users/`.
   */
  _userFactsPath(platform, userId) {
    const safe = (s) => String(s || 'unknown').replace(/[^a-zA-Z0-9_\-]/g, '_').slice(0, 200);
    return path.join(this.usersDir, safe(platform), `${safe(userId)}.json`);
  }

  /**
   * Return all facts for a specific customer. Empty array if the user has
   * no file yet (first time we hear from them).
   */
  getUserFacts(platform, userId) {
    if (!platform || !userId) return [];
    return readJson(this._userFactsPath(platform, userId)) || [];
  }

  /**
   * Save / upsert a fact for a specific customer. Same shape and dedup
   * semantics as business facts, but scoped to the per-user file.
   */
  addUserFact(platform, userId, key, value) {
    if (!platform || !userId || !key || value == null) return;
    const fp = this._userFactsPath(platform, userId);
    const facts = readJson(fp) || [];
    const existing = facts.findIndex(f => f.key === key);
    if (existing >= 0) {
      facts[existing].value = value;
      facts[existing].updatedAt = new Date().toISOString();
    } else {
      facts.push({
        key,
        value,
        createdAt: new Date().toISOString(),
        accessCount: 0,
      });
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeJson(fp, facts);
  }

  removeUserFact(platform, userId, key) {
    if (!platform || !userId) return false;
    const fp = this._userFactsPath(platform, userId);
    const facts = readJson(fp) || [];
    const idx = facts.findIndex(f => f.key === key);
    if (idx < 0) return false;
    facts.splice(idx, 1);
    writeJson(fp, facts);
    return true;
  }

  /**
   * Wipe a single customer's facts. Returns the count deleted. Right-to-be-
   * forgotten path: agent should call this when the customer explicitly
   * asks to clear their data.
   */
  clearUserFacts(platform, userId) {
    if (!platform || !userId) return 0;
    const fp = this._userFactsPath(platform, userId);
    const n = (readJson(fp) || []).length;
    if (n > 0) writeJson(fp, []);
    return n;
  }

  // ═══════════════════════════════════════════════════════════════════
  // Per-turn retrieval — picks what to inject into the system prompt
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Return the facts that should be injected into the current turn's
   * context. Always includes business facts. In customer mode, also
   * includes the current customer's facts.
   *
   *   query     — the incoming message (used to keyword-score business
   *               facts when there are many; user facts are returned whole
   *               since per-user files are typically small).
   *   platform  — connector id from the event
   *   userId    — user id from the event
   *   mode      — 'admin' | 'customer'
   *   maxTokens — soft cap on combined size
   *
   * Returns `[fact]` with a `_scope` tag added for caller introspection.
   */
  getRelevantFactsForTurn({ query, platform, userId, mode = 'customer', maxTokens = 2000 } = {}) {
    const out = [];
    let tokens = 0;
    const room = (text) => Math.ceil(text.length / 4);

    // 1. User facts — only in customer mode, only when we know who they are.
    if (mode === 'customer' && platform && userId) {
      const userFacts = this.getUserFacts(platform, userId);
      // Newest-first so the most recent claims about the user surface even
      // if the file later grows past the budget.
      for (let i = userFacts.length - 1; i >= 0; i--) {
        const f = userFacts[i];
        const t = room(`${f.key}: ${f.value}`);
        if (tokens + t > maxTokens) break;
        out.push({ ...f, _scope: 'user' });
        tokens += t;
      }
    }

    // 2. Business facts — always. Keyword-scored when there's a query so
    //    the most relevant ones survive a tight budget.
    const businessFacts = this.getBusinessFacts();
    const scored = scoreFacts(businessFacts, query);
    const accessed = [];
    for (const f of scored) {
      const t = room(`${f.key}: ${f.value}`);
      if (tokens + t > maxTokens) break;
      out.push({ key: f.key, value: f.value, createdAt: f.createdAt, _scope: 'business' });
      accessed.push(f.key);
      tokens += t;
    }

    // Bump accessCount on business facts that survived the cut (matches
    // pre-refactor behavior so pruneBusinessFacts continues to favor
    // frequently-recalled entries).
    if (accessed.length) {
      const all = this.getBusinessFacts();
      for (const f of all) {
        if (accessed.includes(f.key)) f.accessCount = (f.accessCount || 0) + 1;
      }
      writeJson(this.factsPath, all);
    }

    return out;
  }

  /**
   * Back-compat shim. Old callers passed just a query string and expected
   * business facts back. Keep that working so any caller that hasn't been
   * updated still gets sensible behavior.
   */
  getRelevantFacts(query, maxTokens = 2000) {
    return this.getRelevantFactsForTurn({ query, mode: 'admin', maxTokens });
  }

  // ═══════════════════════════════════════════════════════════════════
  // Extraction — pulls facts out of a finished conversation
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Ask the LLM to extract facts from a conversation, then route them to
   * the right store based on `mode`.
   *
   *   mode === 'admin'    → business facts (factsPath)
   *   mode === 'customer' → user facts     (per-user file)
   *
   * When mode is customer but platform/userId are missing, extraction is
   * skipped — we don't have a place to put the facts and we will not fall
   * back to the shared store (that's the whole point of the split).
   */
  async extractFacts(provider, messages, { mode = 'admin', platform = null, userId = null } = {}) {
    if (!messages || messages.length < 2) return;
    if (mode === 'customer' && (!platform || !userId)) return;

    const conversationText = messages
      .filter(m => m.role === 'user' || m.role === 'assistant')
      .slice(-10)
      .map(m => `${m.role}: ${m.content}`)
      .join('\n');

    const systemPrompt = mode === 'admin' ? EXTRACT_BUSINESS_PROMPT : EXTRACT_USER_PROMPT;

    try {
      const result = await provider.chat([
        { role: 'system', content: systemPrompt },
        { role: 'user', content: conversationText },
      ], { maxTokens: 500, temperature: 0 });

      const parsed = JSON.parse(result.content);
      if (!Array.isArray(parsed)) return;
      for (const { key, value } of parsed) {
        if (!key || value == null) continue;
        if (mode === 'admin') {
          this.addBusinessFact(key, value);
        } else {
          this.addUserFact(platform, userId, key, value);
        }
      }
    } catch {
      // Extraction failed — not critical, skip silently
    }
  }

  // ═══════════════════════════════════════════════════════════════════
  // Activity log — unchanged from before
  // ═══════════════════════════════════════════════════════════════════

  appendActivity(entry) {
    if (!entry || typeof entry !== 'object') return null;
    const { type, summary, context, session_id } = entry;
    if (!summary || typeof summary !== 'string') return null;
    const safeType = VALID_ACTIVITY_TYPES.has(type) ? type : 'note';

    const record = {
      ts: new Date().toISOString(),
      type: safeType,
      summary: summary.trim().slice(0, 500),
    };
    if (context && typeof context === 'object') record.context = context;
    if (session_id) record.session_id = session_id;

    try {
      fs.mkdirSync(path.dirname(this.activityPath), { recursive: true });
      fs.appendFileSync(this.activityPath, JSON.stringify(record) + '\n');
    } catch {
      return null;
    }
    return record;
  }

  getActivity({ since_hours = 24, type, contains, limit = 100 } = {}) {
    if (!fs.existsSync(this.activityPath)) return [];
    const cutoff = since_hours != null
      ? Date.now() - Number(since_hours) * 60 * 60 * 1000
      : 0;
    const cap = Math.min(Math.max(1, Number(limit) || 100), 500);
    const lcContains = contains ? String(contains).toLowerCase() : null;

    const lines = fs.readFileSync(this.activityPath, 'utf-8').split('\n');
    const results = [];
    for (let i = lines.length - 1; i >= 0; i--) {
      const line = lines[i].trim();
      if (!line) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      if (!entry?.ts) continue;
      const ts = new Date(entry.ts).getTime();
      if (cutoff && ts < cutoff) break;
      if (type && entry.type !== type) continue;
      if (lcContains && !(entry.summary || '').toLowerCase().includes(lcContains)) continue;
      results.push(entry);
      if (results.length >= cap) break;
    }
    return results;
  }

  getActivityStats({ since_hours = 24 } = {}) {
    const entries = this.getActivity({ since_hours, limit: 500 });
    const byType = {};
    for (const e of entries) {
      byType[e.type] = (byType[e.type] || 0) + 1;
    }
    return {
      total: entries.length,
      by_type: byType,
      since_hours,
      first_ts: entries[entries.length - 1]?.ts || null,
      last_ts: entries[0]?.ts || null,
    };
  }
}

// ─────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────

/**
 * Score business facts against a query for relevance. When the query is
 * empty, falls back to recency. Returns the input array sorted by score
 * descending (positive scores first).
 */
function scoreFacts(facts, query) {
  if (!facts || facts.length === 0) return [];
  const q = (query || '').toLowerCase();
  const queryWords = q.split(/\s+/).filter(w => w.length > 2);

  if (queryWords.length === 0) {
    // No query signal — return newest first.
    return [...facts].reverse();
  }

  const scored = facts.map((f, idx) => {
    const text = `${f.key} ${f.value}`.toLowerCase();
    const wordMatches = queryWords.filter(w => text.includes(w)).length;
    const recencyBonus = idx / facts.length;
    const accessBonus = Math.min((f.accessCount || 0) / 10, 1);
    return { ...f, score: wordMatches * 3 + recencyBonus + accessBonus };
  });

  scored.sort((a, b) => b.score - a.score);
  return scored.filter(f => f.score > 0);
}
