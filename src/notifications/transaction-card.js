// Renders a transaction into a mobile-friendly "card" for owner push
// notifications (Telegram / WhatsApp / Email). Config-driven: it uses the
// workspace's transaction_view labels/formats so each business shows its own
// relevant fields. Returns per-channel strings (so bold renders natively on
// each) plus the action buttons for non-terminal transactions.

const EVENTS = {
  created:   { emoji: '🆕', verb: 'New' },
  updated:   { emoji: '✏️', verb: 'Updated' },
  cancelled: { emoji: '❌', verb: 'Cancelled' },
  completed: { emoji: '✅', verb: 'Completed' },
};

// Fields never shown as a line (either in the header, internal, or noisy).
const SKIP_FIELDS = new Set([
  'service', 'id', 'display_index', 'user_id', 'user', 'client', 'status',
  'currency', 'created_at', 'updated_at', 'completed_at', 'cancelled_at',
  'archived', 'archived_at', 'session_platform', '_file',
]);

const TERMINAL = new Set(['completed', 'cancelled']);

function prettifyKey(k) {
  return String(k).replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
}

function htmlEscape(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function formatValue(key, value, viewConfig, currency) {
  if (value === null || value === undefined || value === '') return null;
  const fmt = viewConfig?.formats?.[key];

  if (fmt === 'currency' || key === 'cost') {
    const n = Number(value);
    return Number.isFinite(n) ? `${currency || ''} ${n.toFixed(2)}`.trim() : String(value);
  }
  if (fmt === 'date' || fmt === 'datetime' || /_at$|date/.test(key)) {
    const d = new Date(value);
    return isNaN(d) ? String(value) : d.toLocaleDateString();
  }
  // Items / array of objects → "2× Name"
  if (Array.isArray(value)) {
    if (value.length === 0) return null;
    if (value.every(v => v && typeof v === 'object')) {
      return value
        .map(it => {
          const qty = it.quantity || it.qty;
          const name = it.name || it.item || JSON.stringify(it);
          return qty ? `${qty}× ${name}` : `${name}`;
        })
        .join(', ');
    }
    return value.join(', ');
  }
  if (typeof value === 'object') return null; // skip nested blobs
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  return String(value);
}

/** Ordered field keys to show as lines, from the view config (minus header/internal). */
function cardFields(viewConfig) {
  const fromDetail = viewConfig?.detail_sections?.[0]?.fields;
  const list = Array.isArray(fromDetail) && fromDetail.length
    ? fromDetail
    : (Array.isArray(viewConfig?.table_columns) ? viewConfig.table_columns : []);
  return list.filter(k => !SKIP_FIELDS.has(k));
}

/**
 * @returns {{ telegramHtml, whatsappText, plainText, buttons }}
 *  buttons: [{ id, title }] for non-terminal transactions, else [].
 */
export function renderTransactionCard(txn, event, viewConfig) {
  const ev = EVENTS[event] || EVENTS.created;
  const id = txn.id ?? txn.display_index ?? '';
  const currency = txn.currency && txn.currency !== '$' ? txn.currency : (txn.currency || '');
  const service = txn.service || 'transaction';

  // Header
  const headerPlain = `${ev.emoji} ${ev.verb} ${service} · #${id}`;

  // Body lines
  const lines = []; // { label, value }
  const customer = txn.user_name || txn.user || txn.client;
  if (customer && customer !== txn.user_id) lines.push({ label: 'Customer', value: String(customer) });

  for (const key of cardFields(viewConfig)) {
    if (key in txn) {
      const val = formatValue(key, txn[key], viewConfig, currency);
      if (val != null && String(val).trim() !== '') {
        lines.push({ label: viewConfig?.labels?.[key] || prettifyKey(key), value: val });
      }
    }
  }
  if (event === 'cancelled' && txn.cancellation_reason) {
    lines.push({ label: 'Reason', value: String(txn.cancellation_reason) });
  }
  const when = txn.updated_at || txn.created_at;
  if (when) {
    const d = new Date(when);
    if (!isNaN(d)) lines.push({ label: 'When', value: d.toLocaleString() });
  }

  // Per-channel rendering
  const whatsappText = [`${headerPlain}`, '', ...lines.map(l => `*${l.label}:* ${l.value}`)].join('\n');
  const telegramHtml = [`${htmlEscape(headerPlain)}`, '', ...lines.map(l => `<b>${htmlEscape(l.label)}:</b> ${htmlEscape(l.value)}`)].join('\n');
  const plainText = [`${headerPlain}`, '', ...lines.map(l => `${l.label}: ${l.value}`)].join('\n');

  // Buttons (only for non-terminal transactions)
  const buttons = TERMINAL.has(txn.status)
    ? []
    : [
        { id: `txn:complete:${id}`, title: '✅ Complete' },
        { id: `txn:cancel:${id}`, title: '❌ Cancel' },
      ];

  return { telegramHtml, whatsappText, plainText, buttons };
}
