import fs from 'fs';
import path from 'path';
import { readJson, writeJson, listFiles } from '../../utils/workspace.js';

// Base parameter names that should NOT be folded into the saved transaction
// as custom fields — they are already handled explicitly.
const BASE_TXN_PARAMS = new Set([
  'id', 'user_id', 'user_name', 'service', 'cost', 'currency', 'details',
]);

// ─────────────────────────────────────────────────────────────────────
// Status lifecycle (universal across all transactional services)
// ─────────────────────────────────────────────────────────────────────
//
//   pending → in_progress → completed
//          ↘             ↘
//            cancelled    disputed
//
// `pending`     — just created. Customer can freely change or cancel.
// `in_progress` — work has started (by the agent autonomously or by the
//                 admin/human fulfilling). Customer changes require care;
//                 cancellation requires owner approval (notify_owner).
// `completed`   — done successfully. Terminal.
// `cancelled`   — stopped before completion. Terminal.
// `disputed`    — customer raised an issue. Resolvable to completed/cancelled.
//
// The agent moves status forward when IT is doing the work. The admin moves
// it when humans are fulfilling. Either way the same transitions apply.

export const TXN_STATUSES = ['pending', 'in_progress', 'completed', 'cancelled', 'disputed'];
export const TERMINAL_STATUSES = new Set(['completed', 'cancelled']);

// Structural transitions allowed by the state machine. Both the admin (via
// the dashboard's status endpoint) and the validator use this map. The
// agent's own `cancel_transaction` tool adds a stricter rule on top — it
// refuses `in_progress → cancelled` because customer-mode cancellation of
// in-flight work needs out-of-band owner approval, not a chat request.
const ALLOWED_TRANSITIONS = {
  pending:     new Set(['in_progress', 'completed', 'cancelled', 'disputed']),
  in_progress: new Set(['completed', 'cancelled', 'disputed']),
  disputed:    new Set(['completed', 'cancelled']),
  completed:   new Set(),                            // terminal
  cancelled:   new Set(),                            // terminal
};

/**
 * Validate a status transition. Returns `{ ok: true }` or
 * `{ ok: false, reason: '...' }` with an LLM-readable explanation.
 */
export function validateStatusTransition(from, to) {
  if (!TXN_STATUSES.includes(to)) {
    return { ok: false, reason: `Unknown status "${to}". Valid statuses: ${TXN_STATUSES.join(', ')}.` };
  }
  if (from === to) {
    return { ok: false, reason: `Transaction is already "${from}".` };
  }
  const allowed = ALLOWED_TRANSITIONS[from];
  if (!allowed) {
    return { ok: false, reason: `Cannot transition from unknown status "${from}".` };
  }
  if (!allowed.has(to)) {
    if (TERMINAL_STATUSES.has(from)) {
      return { ok: false, reason: `Transaction is already ${from} (terminal). It cannot be changed.` };
    }
    return { ok: false, reason: `Cannot transition from "${from}" to "${to}".` };
  }
  return { ok: true };
}

/** Treat a value as a numeric sequence id when it's a non-negative integer
 *  (either as a number or a digits-only string). */
function asNumericId(v) {
  if (typeof v === 'number' && Number.isFinite(v) && v >= 0) return v;
  if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
  return null;
}

/**
 * Round numeric currency-like values to 2 decimals so the dashboard stops
 * showing things like 24.50000000000001. Touches `cost` and any
 * agent-supplied custom field whose value is a finite number with more
 * than 2 fractional digits. Leaves integers, strings, and arrays alone.
 */
function normalizeAmounts(obj) {
  for (const [k, v] of Object.entries(obj)) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      const rounded = Math.round(v * 100) / 100;
      if (rounded !== v) obj[k] = rounded;
    }
  }
  return obj;
}

/**
 * Scan all on-disk transactions and return the next sequence number to
 * assign. Per-workspace sequence: max existing + 1, starting at 1.
 *
 * The sequence number is now also the transaction's id — short and
 * human-friendly so the agent can quote it ("your order is #47"). Legacy
 * rows that pre-date this scheme have a `display_index` field instead;
 * we consider both when computing the max so the sequence never collides.
 */
export function nextDisplayIndex(paths) {
  let max = 0;
  if (!fs.existsSync(paths.activeTransactions)) return 1;
  for (const f of listFiles(paths.activeTransactions, '.json')) {
    const data = readJson(path.join(paths.activeTransactions, f));
    if (!data) continue;
    const idNum = asNumericId(data.id);
    if (idNum != null && idNum > max) max = idNum;
    if (Number.isFinite(data.display_index) && data.display_index > max) {
      max = data.display_index;
    }
  }
  return max + 1;
}

export function createTransaction(paths, args) {
  const safe = { ...(args || {}) };
  // The platform owns the transaction number. Any id the agent supplied is
  // discarded — keeping the agent out of identifier assignment eliminates
  // collisions and gives the customer a short, memorable reference.
  delete safe.id;
  delete safe.display_index;
  const { user_id, user_name, service, cost, currency, details, ...customFields } = safe;

  fs.mkdirSync(paths.activeTransactions, { recursive: true });
  const id = String(nextDisplayIndex(paths));
  const fp = path.join(paths.activeTransactions, `${id}.json`);

  if (fs.existsSync(fp)) {
    // Should be unreachable — nextDisplayIndex always returns max+1.
    return JSON.stringify({ error: `Transaction "${id}" already exists.` });
  }

  // Custom fields are declared per-workspace in SKILL.md's `## Transaction
  // Fields` block; the LLM passes them as top-level args via the
  // workspace-aware tool schema, alongside the legacy `details` blob.
  const txn = normalizeAmounts({
    id,
    user_id,
    user_name: user_name || user_id,
    service,
    cost: cost || 0,
    currency: currency || '$',
    status: 'pending',
    created_at: new Date().toISOString(),
    updated_at: new Date().toISOString(),
    ...details,
    ...customFields,
  });

  writeJson(fp, txn);
  return JSON.stringify({
    ok: true,
    id,
    message: `Transaction #${id} created. The reference number is ${id} — use it in any follow-up tool calls for this order, and quote it to the customer when relevant.`,
    transaction: txn,
  });
}

export function updateTransaction(paths, args) {
  const { id, updates, ...customFields } = args || {};
  const fp = path.join(paths.activeTransactions, `${id}.json`);

  if (!fs.existsSync(fp)) {
    return JSON.stringify({ error: `Transaction "${id}" not found in active transactions.` });
  }

  const txn = readJson(fp);

  // Block edits on terminal rows — completed / cancelled transactions are
  // closed. Reopening them must go through a deliberate path (today: none;
  // owner can edit the file directly if absolutely needed).
  if (TERMINAL_STATUSES.has(txn.status)) {
    return JSON.stringify({
      error: `Transaction "${id}" is ${txn.status} and cannot be modified. Closed transactions are immutable.`,
    });
  }

  // If the caller is trying to change `status`, validate the transition.
  // `status` can land via `updates.status` (legacy path) or via customFields
  // (workspaces with a declared `status` field in `## Transaction Fields`).
  const proposedStatus = (updates && updates.status) || customFields.status;
  if (proposedStatus && proposedStatus !== txn.status) {
    const v = validateStatusTransition(txn.status, proposedStatus);
    if (!v.ok) {
      return JSON.stringify({ error: v.reason, current_status: txn.status });
    }
    if (proposedStatus === 'cancelled') {
      // Cancellation is its own tool — keep that path canonical so we capture
      // reason/refund signal and the activity log entry has the right type.
      return JSON.stringify({
        error: `Use cancel_transaction to cancel a transaction (not update_transaction). It records the reason and triggers the right side-effects.`,
      });
    }
  }

  // Top-level declared fields and legacy `updates` are merged; declared
  // fields win when both paths specify the same key.
  Object.assign(txn, updates || {}, customFields, { updated_at: new Date().toISOString() });
  normalizeAmounts(txn);
  writeJson(fp, txn);

  return JSON.stringify({ ok: true, message: `Transaction "${id}" updated.`, transaction: txn });
}

export function completeTransaction(paths, { id, rating }) {
  const fp = path.join(paths.activeTransactions, `${id}.json`);

  if (!fs.existsSync(fp)) {
    return JSON.stringify({ error: `Transaction "${id}" not found.` });
  }

  const txn = readJson(fp);
  const v = validateStatusTransition(txn.status, 'completed');
  if (!v.ok) {
    return JSON.stringify({ error: v.reason, current_status: txn.status });
  }

  txn.status = 'completed';
  txn.completed_at = new Date().toISOString();
  txn.updated_at = new Date().toISOString();
  if (rating) txn.rating = rating;

  // No file move — completed transactions stay visible in the dashboard
  // until the owner archives them explicitly.
  writeJson(fp, txn);

  return JSON.stringify({ ok: true, message: `Transaction "${id}" marked completed.`, transaction: txn });
}

/**
 * Cancel a transaction. Allowed from `pending` (customer-initiated) and from
 * `disputed` (dispute resolution). Refused from `in_progress` to avoid the
 * agent autonomously dropping work that someone is committed to — the agent
 * should escalate via `notify_owner` instead.
 */
export function cancelTransaction(paths, { id, reason }, ctx = {}) {
  const fp = path.join(paths.activeTransactions, `${id}.json`);

  if (!fs.existsSync(fp)) {
    return JSON.stringify({ error: `Transaction "${id}" not found.` });
  }

  const txn = readJson(fp);

  // Customer-mode safety: cancelling work that's already in_progress requires
  // the owner's deliberate decision. The state machine permits this transition
  // structurally (so the admin can do it from the dashboard OR from chat in
  // admin mode), but a customer-mode chat request must escalate via
  // notify_owner so a human decides.
  if (txn.status === 'in_progress' && ctx.mode !== 'admin') {
    return JSON.stringify({
      error: `Cannot cancel a transaction that is in_progress via this tool in customer mode. Use notify_owner to escalate; the owner can authorize the cancellation from the dashboard or from admin chat.`,
      current_status: txn.status,
    });
  }

  const v = validateStatusTransition(txn.status, 'cancelled');
  if (!v.ok) {
    return JSON.stringify({ error: v.reason, current_status: txn.status });
  }

  txn.status = 'cancelled';
  txn.cancelled_at = new Date().toISOString();
  txn.updated_at = txn.cancelled_at;
  if (reason && typeof reason === 'string') txn.cancellation_reason = reason.trim().slice(0, 500);
  writeJson(fp, txn);

  return JSON.stringify({ ok: true, message: `Transaction "${id}" cancelled.`, transaction: txn });
}

export function attachFileToTransaction(paths, { id, file_path }) {
  if (!id || !file_path) {
    return JSON.stringify({ error: 'id and file_path are required.' });
  }

  const txnPath = path.join(paths.activeTransactions, `${id}.json`);
  if (!fs.existsSync(txnPath)) {
    return JSON.stringify({ error: `Transaction "${id}" not found.` });
  }

  // Normalize path — must be workspace-relative and live under data/
  const rel = file_path.replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(rel) || rel.includes('..')) {
    return JSON.stringify({ error: 'file_path must be a workspace-relative path under data/.' });
  }
  const relUnderData = rel.startsWith('data/') ? rel.slice(5) : rel;
  const absPath = path.resolve(paths.data, relUnderData);
  if (!absPath.startsWith(path.resolve(paths.data))) {
    return JSON.stringify({ error: 'file_path must resolve under data/.' });
  }
  if (!fs.existsSync(absPath)) {
    return JSON.stringify({ error: `File not found: ${file_path}` });
  }

  const stat = fs.statSync(absPath);
  const filename = path.basename(absPath);
  const ext = path.extname(filename).slice(1).toLowerCase();
  const imageExts = ['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'];
  const audioExts = ['mp3', 'wav', 'ogg', 'flac', 'aac', 'm4a'];
  const videoExts = ['mp4', 'webm', 'ogv', 'mov', 'avi', 'mkv'];
  let kind = 'file';
  if (imageExts.includes(ext)) kind = 'image';
  else if (audioExts.includes(ext)) kind = 'audio';
  else if (videoExts.includes(ext)) kind = 'video';

  const fileEntry = {
    name: filename,
    path: `data/${relUnderData}`,
    size: stat.size,
    kind,
    attached_at: new Date().toISOString(),
  };

  const txn = readJson(txnPath);
  if (!Array.isArray(txn.files)) txn.files = [];
  // Avoid duplicate entries for the same path
  if (!txn.files.some(f => f.path === fileEntry.path)) {
    txn.files.push(fileEntry);
    txn.updated_at = new Date().toISOString();
    writeJson(txnPath, txn);
  }

  return JSON.stringify({
    ok: true,
    message: `File "${filename}" attached to transaction "${id}".`,
    file: fileEntry,
    file_count: txn.files.length,
  });
}

export function listTransactions(paths, { status, include_archived } = {}) {
  const txns = [];

  for (const f of listFiles(paths.activeTransactions, '.json')) {
    const data = readJson(path.join(paths.activeTransactions, f));
    if (data) txns.push(data);
  }

  let filtered = txns;
  if (!include_archived) filtered = filtered.filter(t => t.archived !== true);
  if (status) filtered = filtered.filter(t => t.status === status);

  filtered.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

  return JSON.stringify({ count: filtered.length, transactions: filtered.slice(0, 50) });
}

/**
 * Set or unset the `archived` flag on a transaction. The file stays in the
 * same folder — only the flag changes. Used by the dashboard archive button
 * and (optionally) by the agent if it ever needs to clean up the view.
 */
export function setTransactionArchived(paths, { id, archived }) {
  const fp = path.join(paths.activeTransactions, `${id}.json`);
  if (!fs.existsSync(fp)) {
    return JSON.stringify({ error: `Transaction "${id}" not found.` });
  }
  const txn = readJson(fp);
  txn.archived = !!archived;
  txn.updated_at = new Date().toISOString();
  if (archived) txn.archived_at = new Date().toISOString();
  else delete txn.archived_at;
  writeJson(fp, txn);
  return JSON.stringify({ ok: true, transaction: txn });
}
