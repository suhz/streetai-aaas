import fs from 'fs';
import path from 'path';

/**
 * Delayed-event scheduler.
 *
 * A scheduled action is just an event the agent has asked to receive later.
 * When time comes, the engine emits it through the normal processEvent
 * pipeline — same session, same connector, same mode resolution — so the
 * agent acts on it exactly as if a new customer message arrived, except
 * the "speaker" is the system and the content is the agent's own past
 * instruction.
 *
 * Storage: a single append-only JSONL file at `<workspace>/.aaas/scheduled.jsonl`.
 * Each line is one pending action. Removing an action rewrites the file
 * without it (cheap — pending counts are small).
 *
 * Concurrency note: only the long-lived daemon (agent-worker) starts the
 * tick loop, so there's a single firing process per workspace. Short-lived
 * engines (chat, run, API calls) can still SCHEDULE actions; they just
 * don't fire them.
 */

const HARD_MAX_DELAY_MIN = 14 * 24 * 60;   // 14 days
const HARD_MIN_DELAY_MIN = 1;              // 1 minute
const MAX_INSTRUCTION_LEN = 1000;
const MAX_PENDING_PER_WORKSPACE = 100;

/**
 * Append a scheduled action to disk.
 *
 *   delayMinutes  — when to fire, in minutes from now
 *   instruction   — the text the agent will see when it wakes up
 *   session       — { platform, user_id } target session for the wake-up
 *   context       — optional structured fields the agent wants to carry
 *
 * Returns { id, fires_at } on success or { error } on validation failure.
 */
export function scheduleAction(paths, { delayMinutes, instruction, session, context } = {}) {
  if (!session || !session.platform || !session.user_id) {
    return { error: 'session.platform and session.user_id are required (default to the current event\'s session).' };
  }
  if (typeof instruction !== 'string' || !instruction.trim()) {
    return { error: 'instruction is required (the note the agent will read when the reminder fires).' };
  }
  const d = Number(delayMinutes);
  if (!Number.isFinite(d) || d < HARD_MIN_DELAY_MIN || d > HARD_MAX_DELAY_MIN) {
    return { error: `delay_minutes must be between ${HARD_MIN_DELAY_MIN} and ${HARD_MAX_DELAY_MIN} minutes.` };
  }
  const cleanedInstruction = instruction.trim().slice(0, MAX_INSTRUCTION_LEN);

  const pending = loadPending(paths);
  if (pending.length >= MAX_PENDING_PER_WORKSPACE) {
    return { error: `Cannot schedule more than ${MAX_PENDING_PER_WORKSPACE} pending actions for this workspace. Cancel some or wait for fires.` };
  }

  const fires_at = new Date(Date.now() + d * 60_000).toISOString();
  const id = nextScheduledId(pending);
  const entry = {
    id,
    fires_at,
    session: { platform: String(session.platform), user_id: String(session.user_id) },
    instruction: cleanedInstruction,
    context: context && typeof context === 'object' ? context : undefined,
    created_at: new Date().toISOString(),
  };

  fs.mkdirSync(path.dirname(paths.scheduled), { recursive: true });
  fs.appendFileSync(paths.scheduled, JSON.stringify(entry) + '\n');
  return { id, fires_at };
}

/**
 * Read every pending action from disk. Skips malformed lines silently.
 * Returns array sorted by `fires_at` ascending (soonest first).
 */
export function loadPending(paths) {
  if (!fs.existsSync(paths.scheduled)) return [];
  const lines = fs.readFileSync(paths.scheduled, 'utf-8').split('\n');
  const out = [];
  for (const line of lines) {
    const s = line.trim();
    if (!s) continue;
    try {
      const e = JSON.parse(s);
      if (e && e.id && e.fires_at) out.push(e);
    } catch { /* skip malformed */ }
  }
  out.sort((a, b) => new Date(a.fires_at) - new Date(b.fires_at));
  return out;
}

/**
 * Remove a single action by id. Rewrites the file atomically (writes to a
 * temp path, then renames). Returns true if the entry existed.
 */
export function removeAction(paths, id) {
  const pending = loadPending(paths);
  const next = pending.filter(e => e.id !== id);
  if (next.length === pending.length) return false;
  writeAll(paths, next);
  return true;
}

/**
 * Remove every action targeting a specific session — used when the owner
 * wants to clear scheduled wake-ups for one customer.
 */
export function removeActionsForSession(paths, { platform, user_id }) {
  const pending = loadPending(paths);
  const next = pending.filter(e => !(e.session?.platform === platform && e.session?.user_id === user_id));
  const removed = pending.length - next.length;
  if (removed > 0) writeAll(paths, next);
  return removed;
}

function writeAll(paths, list) {
  fs.mkdirSync(path.dirname(paths.scheduled), { recursive: true });
  const tmp = paths.scheduled + '.tmp';
  const body = list.map(e => JSON.stringify(e)).join('\n') + (list.length ? '\n' : '');
  fs.writeFileSync(tmp, body);
  fs.renameSync(tmp, paths.scheduled);
}

function nextScheduledId(pending) {
  let max = 0;
  for (const e of pending) {
    const m = /^s_(\d+)$/.exec(e.id || '');
    if (m) {
      const n = Number(m[1]);
      if (Number.isFinite(n) && n > max) max = n;
    }
  }
  return `s_${max + 1}`;
}
