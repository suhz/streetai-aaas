import { MemoryManager } from '../memory/index.js';

/**
 * Tool-side facade over MemoryManager. The agent calls `read_memory` /
 * `save_memory` without specifying a store — routing happens here based on
 * the current event context (mode + platform + user id).
 *
 *   customer mode  → user facts (per-customer file)
 *   admin / local  → business facts (shared workspace file)
 *
 * Agent can override by passing an explicit `scope: 'business' | 'user'`
 * argument, but that's optional and rarely needed.
 */

function pickScope(args, ctx) {
  const explicit = args && typeof args.scope === 'string' ? args.scope.toLowerCase() : null;
  if (explicit === 'business' || explicit === 'user') return explicit;
  // Default by mode: customer conversations save to the current customer's
  // file; everything else (admin, local owner chat) saves to business.
  if (ctx && ctx.mode === 'customer' && ctx.platform && ctx.userId) return 'user';
  return 'business';
}

function buildManager(workspace) {
  return new MemoryManager(workspace);
}

/**
 * Read memory facts, optionally filtered by topic substring.
 * Returns whichever scope is active for the current event context.
 */
export function readMemory(workspace, args = {}, ctx = {}) {
  const { topic } = args || {};
  const scope = pickScope(args, ctx);
  const mgr = buildManager(workspace);

  const facts = scope === 'user'
    ? mgr.getUserFacts(ctx.platform, ctx.userId)
    : mgr.getBusinessFacts();

  if (facts.length === 0) {
    return JSON.stringify({ scope, message: 'No facts stored in memory yet.' });
  }

  let filtered = facts;
  if (topic) {
    const t = topic.toLowerCase();
    filtered = facts.filter(f =>
      f.key.toLowerCase().includes(t) || String(f.value).toLowerCase().includes(t)
    );
  }

  // Most recent first, capped at 30.
  const results = filtered.slice(-30).reverse();
  return JSON.stringify({ scope, count: results.length, total: facts.length, facts: results });
}

/**
 * Save a fact to memory. Deduplicates by key within its scope.
 */
export function saveMemory(workspace, args = {}, ctx = {}) {
  const { key, value } = args || {};
  if (!key || value == null) {
    return JSON.stringify({ error: 'Both key and value are required.' });
  }

  const scope = pickScope(args, ctx);
  const mgr = buildManager(workspace);

  if (scope === 'user') {
    if (!ctx.platform || !ctx.userId) {
      return JSON.stringify({ error: 'No customer in context — cannot save to user memory.' });
    }
    mgr.addUserFact(ctx.platform, ctx.userId, key, value);
  } else {
    mgr.addBusinessFact(key, value);
  }

  return JSON.stringify({ ok: true, scope, message: `Saved: ${key}` });
}

/**
 * Forget one or more facts from memory.
 *
 *   { key }            → delete a single fact by exact key
 *   { topic }          → delete facts whose key/value contains the substring;
 *                        requires `confirm: true` when more than 1 would match
 *   { all: true }      → wipe the entire active scope; requires confirm: true
 *
 * Routing mirrors save_memory/read_memory: customer mode operates on the
 * current customer's user memory; admin mode operates on business memory.
 *
 * Hard rule: customers can never reach business memory, even via an explicit
 * scope override. The mode boundary is enforced regardless of args.
 */
export function forgetMemory(workspace, args = {}, ctx = {}) {
  const { key, topic, all, confirm } = args || {};
  if (!key && !topic && !all) {
    return JSON.stringify({ error: 'Specify one of: key, topic, or all.' });
  }

  // Customers cannot delete from business memory under any circumstance.
  // Without this, an agent in customer mode could be tricked by a customer
  // into wiping business facts via `scope: 'business'`.
  let scope = pickScope(args, ctx);
  if (ctx?.mode === 'customer' && scope === 'business') {
    return JSON.stringify({ error: 'Business memory can only be modified in admin mode.' });
  }

  const mgr = buildManager(workspace);
  const isUser = scope === 'user';
  if (isUser && (!ctx.platform || !ctx.userId)) {
    return JSON.stringify({ error: 'No customer in context — cannot modify user memory.' });
  }

  const getFacts = () => isUser ? mgr.getUserFacts(ctx.platform, ctx.userId) : mgr.getBusinessFacts();
  const removeFact = (k) => isUser
    ? mgr.removeUserFact(ctx.platform, ctx.userId, k)
    : mgr.removeBusinessFact(k);

  // Case 1: wipe all
  if (all === true) {
    if (!confirm) {
      const n = getFacts().length;
      return JSON.stringify({
        ok: false,
        scope,
        needs_confirm: true,
        would_delete: n,
        message: `This would clear all ${n} facts in ${scope} memory. Re-call with confirm: true to proceed.`,
      });
    }
    const n = isUser ? mgr.clearUserFacts(ctx.platform, ctx.userId) : mgr.clearBusinessFacts();
    return JSON.stringify({ ok: true, scope, deleted: n, message: `Cleared ${n} facts from ${scope} memory.` });
  }

  // Case 2: single key
  if (key) {
    const existed = removeFact(key);
    if (!existed) {
      return JSON.stringify({ ok: false, scope, message: `No fact with key "${key}".` });
    }
    return JSON.stringify({ ok: true, scope, deleted: 1, keys: [key], message: `Forgot: ${key}` });
  }

  // Case 3: topic substring — preview when broad, delete when confirmed
  const t = topic.toLowerCase();
  const matched = getFacts().filter(f =>
    f.key.toLowerCase().includes(t) || String(f.value).toLowerCase().includes(t)
  );
  if (matched.length === 0) {
    return JSON.stringify({ ok: false, scope, message: `No facts matching "${topic}".` });
  }
  if (matched.length > 1 && !confirm) {
    return JSON.stringify({
      ok: false,
      scope,
      needs_confirm: true,
      would_delete: matched.length,
      keys: matched.map(f => f.key),
      message: `${matched.length} facts match "${topic}". Re-call with confirm: true to delete all of them.`,
    });
  }
  for (const f of matched) removeFact(f.key);
  return JSON.stringify({
    ok: true, scope,
    deleted: matched.length,
    keys: matched.map(f => f.key),
    message: `Forgot ${matched.length} fact(s): ${matched.map(f => f.key).join(', ')}`,
  });
}
