import fs from 'fs';
import path from 'path';
import { readJson, listFiles } from '../../utils/workspace.js';

let Database = null;
try { Database = (await import('better-sqlite3')).default; } catch {}

/**
 * Search data files and SQLite tables for records matching a query.
 */
export async function searchData(paths, { query, file, field, value, table, sql }) {
  const results = [];
  const maxResults = 20;

  // ── SQLite query ──
  if (table || sql) {
    return searchSqlite(paths, { query, table, field, value, sql });
  }

  // ── JSON file search ──
  const dataDir = paths.data;
  const files = file ? [file] : listFiles(dataDir, '.json');

  for (const f of files) {
    const fp = path.join(dataDir, f);
    const data = readJson(fp);
    const recordSets = collectRecordArrays(data);

    for (const { records } of recordSets) {
      for (const record of records) {
        if (results.length >= maxResults) break;
        if (!record || typeof record !== 'object') continue;

        let matches = false;

        // Field-specific match
        if (field && value) {
          const fieldVal = String(record[field] || '').toLowerCase();
          matches = fieldVal.includes(value.toLowerCase());
        }

        // Full-text search across all string fields
        if (query && !matches) {
          const q = query.toLowerCase();
          matches = Object.values(record).some(v => {
            if (typeof v === 'string') return v.toLowerCase().includes(q);
            if (Array.isArray(v)) return v.some(item => String(item).toLowerCase().includes(q));
            return false;
          });
        }

        if (matches) {
          results.push({ _source: f, ...record });
        }
      }
      if (results.length >= maxResults) break;
    }
  }

  // ── Also search SQLite if it exists and no specific JSON file was requested ──
  if (!file && Database) {
    const dbPath = path.join(paths.data, 'database.sqlite');
    if (fs.existsSync(dbPath)) {
      try {
        const db = new Database(dbPath, { readonly: true });
        const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'").all();

        for (const t of tables) {
          if (results.length >= maxResults) break;
          const cols = db.prepare(`PRAGMA table_info("${t.name}")`).all();
          const textCols = cols.filter(c => ['TEXT', 'VARCHAR', 'CHAR'].some(type => (c.type || '').toUpperCase().includes(type)));

          if (query && textCols.length > 0) {
            const where = textCols.map(c => `"${c.name}" LIKE ?`).join(' OR ');
            const params = textCols.map(() => `%${query}%`);
            const rows = db.prepare(`SELECT * FROM "${t.name}" WHERE ${where} LIMIT ${maxResults - results.length}`).all(...params);
            for (const row of rows) {
              results.push({ _source: `db:${t.name}`, ...row });
            }
          } else if (field && value) {
            const rows = db.prepare(`SELECT * FROM "${t.name}" WHERE "${field}" LIKE ? LIMIT ${maxResults - results.length}`).all(`%${value}%`);
            for (const row of rows) {
              results.push({ _source: `db:${t.name}`, ...row });
            }
          }
        }
        db.close();
      } catch { /* skip if db issues */ }
    }
  }

  if (results.length === 0) {
    return JSON.stringify({ message: 'No records found matching the query.', query, file: file || 'all' });
  }

  return JSON.stringify({ count: results.length, results });
}

function searchSqlite(paths, { query, table, field, value, sql }) {
  if (!Database) return JSON.stringify({ error: 'SQLite not available.' });

  const dbPath = path.join(paths.data, 'database.sqlite');
  if (!fs.existsSync(dbPath)) return JSON.stringify({ error: 'No database found.' });

  try {
    const db = new Database(dbPath, { readonly: true });

    // If raw SQL provided (SELECT only for safety)
    if (sql) {
      const trimmed = sql.trim().toUpperCase();
      if (!trimmed.startsWith('SELECT')) {
        db.close();
        return JSON.stringify({ error: 'Only SELECT queries allowed in search mode.' });
      }
      const rows = db.prepare(sql).all();
      db.close();
      return JSON.stringify({ count: rows.length, rows: rows.slice(0, 100) });
    }

    // Search specific table
    if (table) {
      const cols = db.prepare(`PRAGMA table_info("${table}")`).all();
      if (cols.length === 0) {
        db.close();
        return JSON.stringify({ error: `Table "${table}" not found.` });
      }

      let rows;
      if (field && value) {
        rows = db.prepare(`SELECT * FROM "${table}" WHERE "${field}" LIKE ? LIMIT 100`).all(`%${value}%`);
      } else if (query) {
        const textCols = cols.filter(c => ['TEXT', 'VARCHAR', 'CHAR'].some(type => (c.type || '').toUpperCase().includes(type)));
        if (textCols.length === 0) {
          rows = db.prepare(`SELECT * FROM "${table}" LIMIT 100`).all();
        } else {
          const where = textCols.map(c => `"${c.name}" LIKE ?`).join(' OR ');
          const params = textCols.map(() => `%${query}%`);
          rows = db.prepare(`SELECT * FROM "${table}" WHERE ${where} LIMIT 100`).all(...params);
        }
      } else {
        rows = db.prepare(`SELECT * FROM "${table}" LIMIT 100`).all();
      }

      db.close();
      return JSON.stringify({ count: rows.length, rows });
    }

    db.close();
    return JSON.stringify({ error: 'Provide a table name or sql query.' });
  } catch (err) {
    return JSON.stringify({ error: err.message });
  }
}

/**
 * Collect searchable record arrays from a parsed JSON value.
 *
 * - Top-level array → returned as-is (preserves existing behavior).
 * - Top-level object → returns any array-valued property whose elements
 *   are objects (e.g. `menu.json` → `items`, `products.json` → `items`).
 *   Reference dicts like `category_images: {}` are ignored.
 * - Top-level object with no record arrays → treated as a single record
 *   so settings/config files remain searchable.
 * - Anything else → empty (skip the file).
 */
function collectRecordArrays(data) {
  if (Array.isArray(data)) return [{ key: '', records: data }];
  if (!data || typeof data !== 'object') return [];

  const sets = [];
  for (const [key, val] of Object.entries(data)) {
    if (!Array.isArray(val) || val.length === 0) continue;
    const first = val[0];
    if (first && typeof first === 'object' && !Array.isArray(first)) {
      sets.push({ key, records: val });
    }
  }
  if (sets.length === 0) sets.push({ key: '', records: [data] });
  return sets;
}
