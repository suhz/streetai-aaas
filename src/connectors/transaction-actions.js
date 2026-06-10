import { completeTransaction, cancelTransaction } from '../engine/tools/transactions.js';

// Shared handler for transaction-card button taps, used by every channel that
// can receive them (Telegram callback_query, direct WhatsApp interactive,
// relay-forwarded WhatsApp interactive). One place defines the button id format
// and the action → so all channels behave identically and stay in sync.

export const TXN_BUTTON_RE = /^txn:(complete|cancel):(.+)$/;

/** True if a button/callback id is one of our transaction actions. */
export function isTxnButton(id) {
  return TXN_BUTTON_RE.test(id || '');
}

/**
 * Apply a transaction-card button action. Owner authority is assumed to have
 * been checked by the caller (each channel verifies the tapper).
 *
 * @returns {null} if `btnId` isn't a transaction button, otherwise
 *   { ok: true,  event, transaction } on success, or
 *   { ok: false, event, error }       on failure (not found / invalid transition).
 */
export function applyTxnButtonAction(paths, btnId) {
  const m = (btnId || '').match(TXN_BUTTON_RE);
  if (!m) return null;
  const [, action, id] = m;

  let resultStr, event;
  if (action === 'complete') {
    resultStr = completeTransaction(paths, { id });
    event = 'completed';
  } else {
    resultStr = cancelTransaction(paths, { id, reason: 'Cancelled by owner' }, { mode: 'admin' });
    event = 'cancelled';
  }

  let parsed = null;
  try { parsed = JSON.parse(resultStr); } catch { /* ignore */ }
  if (!parsed || parsed.error) {
    return { ok: false, event, error: parsed?.error || 'Could not update that transaction.' };
  }
  return { ok: true, event, transaction: parsed.transaction };
}
