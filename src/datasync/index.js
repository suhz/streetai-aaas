import fs from 'fs';
import path from 'path';
import { getWorkspacePaths, readJson, writeJson } from '../utils/workspace.js';

/**
 * Data Sources — keep a workspace's service data fresh from the business's own
 * system. A source pulls a CSV (or JSON) from a `url` (incl. published Google
 * Sheets / authed export endpoints) or a `folder` (a local / cloud-synced path)
 * on a schedule, and writes it into the agent's queryable store: SQLite (large/
 * volatile catalogs) or a JSON file (small sets). The agent reads those live via
 * search_data / run_query, so a sync takes effect with no restart.
 *
 * Config lives in `.aaas/data-sources.json`. If that file is absent the whole
 * feature is a no-op — existing workspaces are completely unaffected.
 *
 * This module has no server/engine deps so the dashboard boot hook, the CLI
 * (`aaas data sync`), and the daemon tick can all call it.
 */

const MAX_FEED_BYTES = 30 * 1024 * 1024; // guard against runaway downloads

function sourcesPath(paths) {
  return path.join(path.dirname(paths.config), 'data-sources.json');
}

/** Read `.aaas/data-sources.json` (or null if not configured). */
export function loadSources(paths) {
  return readJson(sourcesPath(paths));
}

/** Persist the config (used to stamp last_synced_at / last_status). */
export function saveSources(paths, cfg) {
  const fp = sourcesPath(paths);
  fs.mkdirSync(path.dirname(fp), { recursive: true });
  writeJson(fp, cfg);
}

// ─── Helpers ────────────────────────────────────────────────────

function substituteEnv(value) {
  return String(value).replace(/\{\{(\w+)\}\}/g, (_m, name) => {
    const v = process.env[name];
    if (v === undefined) throw new Error(`environment variable not set: ${name}`);
    return v;
  });
}

/** Make a string safe to use as a SQLite table/column identifier. */
function sanitizeIdent(s) {
  let x = String(s).trim().replace(/[^A-Za-z0-9_]/g, '_');
  if (!x) x = 'col';
  if (/^[0-9]/.test(x)) x = '_' + x;
  return x;
}

/**
 * Minimal RFC-4180 CSV parser → array of row objects keyed by header.
 * Handles quoted fields, embedded commas/newlines, "" escapes, and CRLF/LF.
 */
export function parseCsv(text) {
  const s = String(text || '').replace(/^﻿/, ''); // strip BOM
  const rows = [];
  let field = '', row = [], inQuotes = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inQuotes) {
      if (c === '"') {
        if (s[i + 1] === '"') { field += '"'; i++; }
        else inQuotes = false;
      } else field += c;
    } else if (c === '"') {
      inQuotes = true;
    } else if (c === ',') {
      row.push(field); field = '';
    } else if (c === '\n') {
      row.push(field); rows.push(row); field = ''; row = [];
    } else if (c !== '\r') {
      field += c;
    }
  }
  if (field.length > 0 || row.length > 0) { row.push(field); rows.push(row); }
  if (!rows.length) return [];

  const headers = rows[0].map((h) => h.trim());
  const out = [];
  for (let r = 1; r < rows.length; r++) {
    const cells = rows[r];
    if (cells.length === 1 && cells[0].trim() === '') continue; // blank line
    const obj = {};
    headers.forEach((h, idx) => { obj[h] = cells[idx] !== undefined ? cells[idx] : ''; });
    out.push(obj);
  }
  return out;
}

/** Rename columns per the mapping (csvCol → field); pass through the rest. */
function applyMapping(rows, mapping) {
  if (!mapping || !Object.keys(mapping).length) return rows;
  return rows.map((r) => {
    const o = {};
    for (const [k, v] of Object.entries(r)) o[mapping[k] || k] = v;
    return o;
  });
}

/** Accept an array, or an object wrapping one (items/data/rows/records). */
function coerceRows(parsed) {
  if (Array.isArray(parsed)) return parsed;
  if (parsed && typeof parsed === 'object') {
    for (const k of ['items', 'data', 'rows', 'records']) {
      if (Array.isArray(parsed[k])) return parsed[k];
    }
  }
  throw new Error('JSON feed is not an array of records');
}

// ─── Fetchers ───────────────────────────────────────────────────

async function fetchUrl(source) {
  const headers = {};
  let url = source.location;
  const auth = source.auth;
  if (auth?.apiKey) {
    const key = substituteEnv(auth.apiKey);
    const type = auth.type || 'bearer';
    if (type === 'header') headers[auth.header || 'X-API-Key'] = key;
    else if (type === 'query') {
      const sep = url.includes('?') ? '&' : '?';
      url = `${url}${sep}${encodeURIComponent(auth.param || auth.header || 'key')}=${encodeURIComponent(key)}`;
    } else headers['Authorization'] = `Bearer ${key}`;
  }
  const res = await fetch(url, { headers, signal: AbortSignal.timeout(30000) });
  if (!res.ok) throw new Error(`fetch failed (${res.status})`);
  const text = await res.text();
  if (text.length > MAX_FEED_BYTES) throw new Error('feed too large (>30MB)');
  return text;
}

function fetchFolder(source) {
  const loc = source.location;
  if (!loc || !fs.existsSync(loc)) throw new Error(`path not found: ${loc}`);
  let file = loc;
  if (fs.statSync(loc).isDirectory()) {
    const ext = (source.format || 'csv') === 'json' ? '.json' : '.csv';
    const candidates = fs.readdirSync(loc)
      .filter((f) => f.toLowerCase().endsWith(ext))
      .map((f) => ({ f, m: fs.statSync(path.join(loc, f)).mtimeMs }))
      .sort((a, b) => b.m - a.m);
    if (!candidates.length) throw new Error(`no ${ext} files in ${loc}`);
    file = path.join(loc, candidates[0].f);
  }
  const buf = fs.readFileSync(file);
  if (buf.length > MAX_FEED_BYTES) throw new Error('file too large (>30MB)');
  return buf.toString('utf8');
}

// ─── Writers (atomic) ───────────────────────────────────────────

function writeJsonTarget(paths, file, rows) {
  fs.mkdirSync(paths.data, { recursive: true });
  const safe = String(file).replace(/[^A-Za-z0-9._-]/g, '_');
  const dest = path.join(paths.data, safe);
  const tmp = `${dest}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(rows, null, 2));
  fs.renameSync(tmp, dest); // atomic swap on the same volume
  return rows.length;
}

async function writeSqliteTarget(paths, table, rows, { mode = 'replace', key } = {}) {
  let Database;
  try { Database = (await import('better-sqlite3')).default; }
  catch { throw new Error('SQLite (better-sqlite3) is not available'); }
  if (!rows.length) return 0; // nothing to write → leave existing table intact

  fs.mkdirSync(paths.data, { recursive: true });
  const db = new Database(path.join(paths.data, 'database.sqlite'));
  try {
    db.pragma('journal_mode = WAL');
    const t = sanitizeIdent(table);

    // Columns = union of (sanitized) keys across all rows.
    const cols = [];
    const seen = new Set();
    for (const r of rows) {
      for (const k of Object.keys(r)) {
        const col = sanitizeIdent(k);
        if (!seen.has(col)) { seen.add(col); cols.push({ orig: k, col }); }
      }
    }
    const typeOf = ({ orig }) => {
      let any = false;
      for (const r of rows) {
        const v = r[orig];
        if (v === '' || v == null) continue;
        any = true;
        if (!Number.isFinite(Number(v))) return 'TEXT';
      }
      return any ? 'REAL' : 'TEXT';
    };
    const defs = cols.map((c) => `"${c.col}" ${typeOf(c)}`);
    const insertCols = cols.map((c) => `"${c.col}"`).join(', ');
    const placeholders = cols.map(() => '?').join(', ');
    const valuesOf = (r) => cols.map((c) => (r[c.orig] === undefined ? null : r[c.orig]));
    const keyCol = key ? sanitizeIdent(key) : null;

    if (mode === 'upsert' && keyCol) {
      db.exec(`CREATE TABLE IF NOT EXISTS "${t}" (${defs.join(', ')}, PRIMARY KEY ("${keyCol}"))`);
      const updates = cols.filter((c) => c.col !== keyCol).map((c) => `"${c.col}"=excluded."${c.col}"`).join(', ');
      const stmt = db.prepare(`INSERT INTO "${t}" (${insertCols}) VALUES (${placeholders}) ON CONFLICT("${keyCol}") DO UPDATE SET ${updates}`);
      db.transaction((rs) => { for (const r of rs) stmt.run(valuesOf(r)); })(rows);
    } else {
      // Full replace — drop/create/insert in one transaction so concurrent
      // readonly readers (search_data) see either the old or the new table.
      db.transaction((rs) => {
        db.exec(`DROP TABLE IF EXISTS "${t}"`);
        db.exec(`CREATE TABLE "${t}" (${defs.join(', ')})`);
        const stmt = db.prepare(`INSERT INTO "${t}" (${insertCols}) VALUES (${placeholders})`);
        for (const r of rs) stmt.run(valuesOf(r));
      })(rows);
    }
    return rows.length;
  } finally {
    db.close();
  }
}

// ─── Sync ───────────────────────────────────────────────────────

/**
 * Sync one source: fetch → parse → map → write. Never throws.
 * @returns {{ name, synced, rows?, target?, error? }}
 */
export async function syncOneSource(paths, source) {
  try {
    if (!source?.name) return { name: source?.name || '?', synced: false, error: 'invalid source' };
    let text;
    if (source.type === 'url') text = await fetchUrl(source);
    else if (source.type === 'folder') text = fetchFolder(source);
    else throw new Error(`unknown source type: ${source.type}`);

    let rows = (source.format || 'csv') === 'json' ? coerceRows(JSON.parse(text)) : parseCsv(text);
    rows = applyMapping(rows, source.mapping);

    const target = source.target || 'json';
    const n = target === 'sqlite'
      ? await writeSqliteTarget(paths, source.table || sanitizeIdent(source.name), rows, { mode: source.mode || 'replace', key: source.key })
      : writeJsonTarget(paths, source.file || `${source.name}.json`, rows);
    return { name: source.name, synced: true, rows: n, target };
  } catch (e) {
    return { name: source?.name || '?', synced: false, error: e.message };
  }
}

/**
 * Run all due data sources for a workspace. A source is "due" when it has no
 * last_synced_at or it's older than its interval_minutes (default 15). `force`
 * runs all; `only` targets a single named source (and runs it regardless of
 * due/enabled). Stamps last_synced_at / last_status back to the config.
 * Never throws; returns a results array. No config file → returns [].
 */
export async function syncDueDataSources(workspace, { force = false, only = null } = {}) {
  let paths;
  try { paths = getWorkspacePaths(workspace); } catch { return []; }
  const cfg = loadSources(paths);
  if (!cfg || !Array.isArray(cfg.sources) || !cfg.sources.length) return [];

  const now = Date.now();
  const results = [];
  let changed = false;

  for (const src of cfg.sources) {
    if (only && src.name !== only) continue;
    const explicit = force || (only && src.name === only);
    if (!explicit) {
      if (src.enabled === false) { results.push({ name: src.name, skipped: true, reason: 'disabled' }); continue; }
      const intervalMs = (Number(src.interval_minutes) > 0 ? Number(src.interval_minutes) : 15) * 60000;
      const last = src.last_synced_at ? Date.parse(src.last_synced_at) : 0;
      if (last && (now - last) < intervalMs) { results.push({ name: src.name, skipped: true, reason: 'not due' }); continue; }
    }
    const r = await syncOneSource(paths, src);
    src.last_synced_at = new Date().toISOString();
    src.last_status = r.synced ? 'ok' : `error: ${r.error || 'unknown'}`;
    changed = true;
    results.push(r);
  }

  if (changed) { try { saveSources(paths, cfg); } catch { /* best-effort stamp */ } }
  return results;
}
