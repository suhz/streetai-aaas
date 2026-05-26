#!/usr/bin/env node
/**
 * Truuze username → user_id migration for AaaS agent workspaces.
 *
 * Why this exists: the Truuze connector now keys sessions and memory by
 * the stable Truuze user_id instead of the username (which can change
 * during anonymous → signup transitions). Existing files keyed by
 * username need a one-time rename to user_id so agents don't "forget"
 * their customers on the first restart after the connector flip.
 *
 * Usage:
 *   node aaas/scripts/migrate-truuze-userid.js <workspace-path>
 *   node aaas/scripts/migrate-truuze-userid.js <workspace-path> --dry-run
 *
 * Safe to re-run. Idempotent. Files with usernames that can't be resolved
 * are logged as warnings and left in place.
 */

import fs from 'fs';
import path from 'path';

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const workspace = args.find(a => !a.startsWith('--'));

if (!workspace) {
  console.error('Usage: migrate-truuze-userid.js <workspace-path> [--dry-run]');
  process.exit(1);
}

if (!fs.existsSync(workspace)) {
  console.error(`Workspace not found: ${workspace}`);
  process.exit(1);
}

const sessionsDir = path.join(workspace, '.aaas', 'sessions');
const memoryDir = path.join(workspace, 'memory', 'users', 'truuze');
const connFile = path.join(workspace, '.aaas', 'connections', 'truuze.json');
const scheduledFile = path.join(workspace, '.aaas', 'scheduled-actions.json');

if (!fs.existsSync(connFile)) {
  console.error(`Missing Truuze connection: ${connFile}`);
  console.error('Has this workspace been connected to Truuze? Skipping.');
  process.exit(1);
}

const conn = JSON.parse(fs.readFileSync(connFile, 'utf8'));
const { agentKey, platformApiKey, baseUrl } = conn;
if (!agentKey || !platformApiKey || !baseUrl) {
  console.error('truuze.json missing required fields (agentKey, platformApiKey, baseUrl).');
  process.exit(1);
}

// Cache so we don't hit the API for the same username twice.
const lookupCache = new Map();

// Truuze pseudo-ids the connector intentionally writes for synthetic
// activity/platform events. Never migrate these — they aren't real users.
const SYNTHETIC_KEYS = new Set([
  'truuze-activity',
  'truuze-platform',
  'truuze_platform', // tolerate the underscore variant
  'system',
]);

async function lookupUserId(username) {
  if (SYNTHETIC_KEYS.has(username)) return null; // intentionally left alone
  if (lookupCache.has(username)) return lookupCache.get(username);
  try {
    const url = `${baseUrl}/search/user/?search=${encodeURIComponent(username)}`;
    const res = await fetch(url, {
      headers: {
        'X-Api-Key': platformApiKey,
        'X-Agent-Key': agentKey,
      },
    });
    if (!res.ok) {
      console.warn(`  [lookup] HTTP ${res.status} for @${username}`);
      lookupCache.set(username, null);
      return null;
    }
    const data = await res.json();
    const list = Array.isArray(data) ? data : (data.results || []);
    const match = list.find(u => u.username === username);
    const id = match ? match.id : null;
    lookupCache.set(username, id);
    return id;
  } catch (err) {
    console.warn(`  [lookup] error for @${username}: ${err.message}`);
    lookupCache.set(username, null);
    return null;
  }
}

function isUserIdKey(s) {
  return /^\d+$/.test(s);
}

async function migrateFile(dir, file, prefix = '') {
  const base = file.endsWith('.json') ? file.slice(0, -5) : file;
  const key = prefix ? base.slice(prefix.length) : base;

  if (!key) {
    console.warn(`  Skipped (empty key): ${file}`);
    return { skipped: true };
  }
  if (isUserIdKey(key)) {
    console.log(`  Already user_id: ${file}`);
    return { skipped: true };
  }
  if (SYNTHETIC_KEYS.has(key)) {
    console.log(`  Synthetic pseudo-id (keep): ${file}`);
    return { skipped: true };
  }

  const userId = await lookupUserId(key);
  if (!userId) {
    console.warn(`  Could not resolve @${key} — leaving as-is`);
    return { failed: true };
  }

  const newName = `${prefix}${userId}.json`;
  const oldPath = path.join(dir, file);
  const newPath = path.join(dir, newName);
  if (fs.existsSync(newPath)) {
    console.warn(`  Target exists, skipping: ${newName} (file ${file} kept)`);
    return { conflict: true };
  }

  if (dryRun) {
    console.log(`  [dry] would rename: ${file} → ${newName}`);
  } else {
    fs.renameSync(oldPath, newPath);
    console.log(`  Renamed: ${file} → ${newName}`);
  }
  return { migrated: true };
}

async function migrateDir(dir, prefix = '') {
  if (!fs.existsSync(dir)) {
    console.log(`(skip — not found: ${dir})`);
    return { count: 0, migrated: 0, failed: 0 };
  }
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  let migrated = 0;
  let failed = 0;
  let scanned = 0;
  for (const file of files) {
    if (prefix && !file.startsWith(prefix)) continue;
    scanned++;
    const res = await migrateFile(dir, file, prefix);
    if (res.migrated) migrated++;
    if (res.failed) failed++;
  }
  return { count: scanned, migrated, failed };
}

async function migrateOwnerId() {
  if (!conn.ownerId) {
    console.log('(no ownerId stored — skip)');
    return;
  }
  if (isUserIdKey(String(conn.ownerId))) {
    console.log(`ownerId already user_id: ${conn.ownerId}`);
    return;
  }
  const userId = await lookupUserId(String(conn.ownerId));
  if (!userId) {
    console.warn(`Could not resolve ownerId @${conn.ownerId} — leaving as-is`);
    return;
  }
  if (dryRun) {
    console.log(`[dry] would update ownerId: ${conn.ownerId} → ${userId}`);
  } else {
    conn.ownerId = String(userId);
    fs.writeFileSync(connFile, JSON.stringify(conn, null, 2));
    console.log(`Updated ownerId: → ${userId}`);
  }
}

async function migrateScheduledActions() {
  if (!fs.existsSync(scheduledFile)) {
    console.log('(no scheduled-actions.json — skip)');
    return;
  }
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(scheduledFile, 'utf8'));
  } catch (err) {
    console.warn(`Could not parse ${scheduledFile}: ${err.message}`);
    return;
  }
  const list = Array.isArray(raw) ? raw : (raw.pending || raw.actions || []);
  if (!Array.isArray(list) || list.length === 0) {
    console.log('(no pending scheduled actions)');
    return;
  }
  let changed = 0;
  for (const action of list) {
    const target = action?.session;
    if (!target || !target.user_id) continue;
    if (target.platform !== 'truuze') continue;
    const key = String(target.user_id);
    if (isUserIdKey(key) || SYNTHETIC_KEYS.has(key)) continue;
    const userId = await lookupUserId(key);
    if (!userId) {
      console.warn(`  Could not resolve scheduled action target @${key}`);
      continue;
    }
    target.user_id = String(userId);
    changed++;
    console.log(`  Updated schedule target: @${key} → ${userId}`);
  }
  if (changed === 0) {
    console.log('(nothing to update in scheduled actions)');
    return;
  }
  if (dryRun) {
    console.log(`[dry] would write back ${changed} updated action(s)`);
  } else {
    fs.writeFileSync(scheduledFile, JSON.stringify(raw, null, 2));
    console.log(`Wrote ${changed} updated action(s) back to scheduled-actions.json`);
  }
}

(async () => {
  console.log(`=== Truuze user_id migration ===`);
  console.log(`Workspace: ${workspace}`);
  console.log(`Mode: ${dryRun ? 'DRY RUN' : 'apply'}`);
  console.log(`API base: ${baseUrl}`);
  console.log('');

  console.log('--- Sessions ---');
  const s = await migrateDir(sessionsDir, 'truuze_');
  console.log(`Sessions: ${s.migrated} migrated, ${s.failed} failed, ${s.count} scanned`);
  console.log('');

  console.log('--- Memory ---');
  const m = await migrateDir(memoryDir);
  console.log(`Memory: ${m.migrated} migrated, ${m.failed} failed, ${m.count} scanned`);
  console.log('');

  console.log('--- ownerId ---');
  await migrateOwnerId();
  console.log('');

  console.log('--- Scheduled actions ---');
  await migrateScheduledActions();
  console.log('');

  console.log('=== Done ===');
  if (dryRun) {
    console.log('Re-run without --dry-run to apply changes.');
  } else {
    console.log('Restart the agent to pick up the renamed files.');
  }
})().catch(err => {
  console.error('Migration failed:', err);
  process.exit(1);
});
