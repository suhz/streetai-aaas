// Shared helpers for rendering transaction tables across pages.

const CORE_KEYS = new Set([
  'id', 'service', 'user', 'user_id', 'user_name', 'client', 'status', 'cost', 'currency',
  'created_at', 'updated_at', 'completed_at', '_file',
  'details', 'items', 'sub_transactions', 'delivery', 'payment',
  'dispute', 'dispute_reason', 'notes',
]);

const MAX_EXTRA_COLUMNS = 3;

export function prettyKey(k) {
  return k.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

export function getLabel(viewConfig, key) {
  if (viewConfig?.labels?.[key]) return viewConfig.labels[key];
  return prettyKey(key);
}

function detectExtraColumns(txns) {
  if (!txns || txns.length === 0) return [];
  const freq = {};
  for (const t of txns) {
    for (const [k, v] of Object.entries(t)) {
      if (CORE_KEYS.has(k) || k.startsWith('_')) continue;
      if (v === null || v === undefined || typeof v === 'object') continue;
      freq[k] = (freq[k] || 0) + 1;
    }
  }
  return Object.entries(freq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_EXTRA_COLUMNS)
    .map(([k]) => k);
}

export function getTableColumns(viewConfig, txns) {
  if (viewConfig?.table_columns?.length) {
    const fixed = new Set(['service', 'user', 'user_name', 'client', 'status', 'cost', 'created_at', 'date']);
    return viewConfig.table_columns.filter(k => !fixed.has(k)).slice(0, MAX_EXTRA_COLUMNS);
  }
  return detectExtraColumns(txns);
}

/**
 * Render a monetary amount consistently across the dashboard:
 *   "$ 24.50", "TK 100", etc.
 * Always inserts a space between the currency token and the amount.
 * Numeric values are rounded to 2 decimals so weird floating-point
 * artifacts like 24.500000000001 don't leak into the UI.
 */
export function formatCurrency(value, currency) {
  const n = Number(value);
  const amount = Number.isFinite(n) ? n.toFixed(2) : String(value);
  return currency ? `${currency} ${amount}` : amount;
}

export function formatCellWithConfig(value, key, viewConfig, currency) {
  if (value === null || value === undefined) return '';
  const fmt = viewConfig?.formats?.[key];
  if (fmt === 'currency') return formatCurrency(value, currency);
  if (fmt === 'percentage') return `${value}%`;
  if (fmt === 'rating') return '★'.repeat(Math.min(Number(value) || 0, 5));
  if (fmt === 'boolean') return value ? 'Yes' : 'No';
  if (fmt === 'date' || fmt === 'datetime') {
    const d = new Date(value);
    return isNaN(d) ? String(value) : d.toLocaleDateString();
  }
  if (fmt === 'list' && Array.isArray(value)) return value.join(', ');
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  const s = String(value);
  return s.length > 40 ? s.slice(0, 37) + '...' : s;
}
