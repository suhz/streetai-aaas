import fs from 'fs';
import path from 'path';
import { readJson, writeJson } from '../utils/workspace.js';
import { loadConnection, saveConnection } from '../auth/connections.js';
import { newAlertId, saveAlert, defaultTtlMs } from './alerts.js';
import { renderTransactionCard } from './transaction-card.js';

/**
 * Owner notifications. The agent calls notifyOwner({...}) when something
 * needs the operator's attention. The orchestrator fans the message out to
 * every enabled channel: Telegram, WhatsApp, Email.
 *
 * Config shape (`.aaas/notifications.json`):
 *
 *   {
 *     telegram: { enabled: true, chat_id: "12345678" },
 *     whatsapp: { enabled: false, phone: "+1234567890" },
 *     email: {
 *       enabled: true,
 *       to: "you@example.com",
 *       from: "agent@example.com",
 *       smtp: { host, port, secure, user, pass }
 *     }
 *   }
 *
 * Strings may include {{ENV_VAR}} substitution.
 */

const SECRET_FIELDS = new Set(['pass', 'access_token']);

export function loadNotificationsConfig(paths) {
  return readJson(paths.notifications) || { telegram: {}, whatsapp: {}, email: {} };
}

export function saveNotificationsConfig(paths, config) {
  fs.mkdirSync(path.dirname(paths.notifications), { recursive: true });
  writeJson(paths.notifications, config || {});
}

/**
 * Return a copy of the config with secrets masked. For surfacing to the UI
 * without leaking the actual SMTP password (or {{ENV_VAR}} placeholder).
 */
export function maskNotificationsConfig(config) {
  const out = JSON.parse(JSON.stringify(config || {}));
  if (out.email?.smtp?.pass) {
    const v = out.email.smtp.pass;
    out.email.smtp.pass = v.startsWith('{{') ? v : '••••••••';
    out.email.smtp.passSet = true;
  }
  return out;
}

function substitute(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (m, name) => {
      const v = process.env[name];
      if (v === undefined) throw new Error(`environment variable not set: ${name}`);
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(substitute);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substitute(v);
    return out;
  }
  return value;
}

function buildText({ title, message, severity }) {
  const sev = severity ? `[${severity.toUpperCase()}] ` : '';
  if (title && message) return `${sev}${title}\n\n${message}`;
  return `${sev}${title || message || ''}`.trim();
}

// ─── Senders ───────────────────────────────────────────────────

/**
 * Resolve a Telegram target (whatever the owner typed) to a numeric chat
 * ID. Telegram's sendMessage cannot send to a `@username` for private
 * user chats — only for public channels/groups — so usernames have to be
 * resolved to numeric IDs before the API call.
 *
 * Resolution order:
 *   1. Numeric input (e.g. "12345678") → use as-is.
 *   2. Username + entry in conn.userMap (recorded by the connector when
 *      the user messages the bot) → use the cached chat ID.
 *   3. Username + conn.ownerId set (owner already did /admin) → call
 *      Telegram's getChat(ownerId) and confirm the username matches.
 *      Cache the result for future calls.
 *   4. Otherwise → clear, actionable error.
 *
 * Mutates `conn.userMap` (and saves it) when step 3 succeeds.
 */
async function resolveTelegramTarget(workspace, conn, raw) {
  const v = String(raw || '').trim();
  if (!v) return { ok: false, error: 'Telegram target (username or chat ID) is not set.' };

  // Step 1: numeric → done.
  if (/^-?\d+$/.test(v)) return { ok: true, target: v };

  // Step 2: cached username → done.
  const username = v.replace(/^@+/, '');
  const lower = username.toLowerCase();
  const cached = conn?.userMap?.[lower];
  if (cached) return { ok: true, target: String(cached), username };

  // Step 3: getChat fallback when ownerId is known.
  if (conn?.ownerId && conn.botToken) {
    try {
      const r = await fetch(`https://api.telegram.org/bot${conn.botToken}/getChat?chat_id=${encodeURIComponent(conn.ownerId)}`);
      const j = await r.json().catch(() => ({}));
      if (j.ok && j.result?.username && String(j.result.username).toLowerCase() === lower) {
        const id = String(conn.ownerId);
        try {
          const updated = {
            ...conn,
            userMap: { ...(conn.userMap || {}), [lower]: id },
          };
          saveConnection(workspace, 'telegram', updated);
        } catch { /* best-effort cache */ }
        return { ok: true, target: id, username, resolved_via: 'getChat' };
      }
    } catch { /* fall through to final error */ }
  }

  return {
    ok: false,
    error: `I don't know the chat ID for @${username} yet. Telegram requires the bot to receive a message from a user before it can send to them — the @username form only works for public channels, not private chats. Have @${username} DM your bot once, then try again. (After their first message, AaaS captures their chat ID automatically and the username will keep working.)`,
  };
}

async function sendTelegram(workspace, ownerCfg, payload) {
  const conn = loadConnection(workspace, 'telegram');
  if (!conn?.botToken) {
    throw new Error('Telegram bot is not connected. Connect a Telegram bot in the Deploy tab first.');
  }

  const resolved = await resolveTelegramTarget(workspace, conn, ownerCfg?.chat_id);
  if (!resolved.ok) throw new Error(resolved.error);
  const target = resolved.target;

  const url = `https://api.telegram.org/bot${conn.botToken}/sendMessage`;
  // payload.text overrides the default; payload.parse_mode and payload.buttons
  // (inline keyboard) are optional — used by transaction cards.
  const msgBody = { chat_id: target, text: payload.text || buildText(payload) };
  if (payload.parse_mode) msgBody.parse_mode = payload.parse_mode;
  if (Array.isArray(payload.buttons) && payload.buttons.length) {
    msgBody.reply_markup = {
      inline_keyboard: [payload.buttons.map(b => ({ text: b.title, callback_data: b.id }))],
    };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(msgBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.ok === false) {
    throw new Error(`Telegram API ${res.status}: ${body.description || 'unknown error'}`);
  }
  // Always prefer the actual numeric chat.id from the response — that's
  // the value incoming messages will carry, used for owner-reply routing.
  const numericChatId = body.result?.chat?.id ? String(body.result.chat.id) : target;
  const messageId = body.result?.message_id ? String(body.result.message_id) : null;

  // Auto-verify: link the numeric chat ID as the owner if not already set.
  try {
    if (!conn.ownerId) {
      const updated = { ...loadConnection(workspace, 'telegram'), ownerId: numericChatId };
      saveConnection(workspace, 'telegram', updated);
    }
  } catch { /* best-effort */ }
  // Auto-cache the username mapping if we resolved via getChat (or even
  // if the owner typed a username that was already in the cache — keeps
  // the cache fresh).
  try {
    if (resolved.username) {
      const fresh = loadConnection(workspace, 'telegram') || conn;
      const userMap = { ...(fresh.userMap || {}), [resolved.username.toLowerCase()]: numericChatId };
      saveConnection(workspace, 'telegram', { ...fresh, userMap });
    }
  } catch { /* best-effort */ }

  return {
    channel: 'telegram',
    ok: true,
    channel_message_id: messageId,
    sent_to: numericChatId,
  };
}

async function sendWhatsapp(workspace, ownerCfg, payload) {
  if (!ownerCfg?.phone) {
    throw new Error('WhatsApp phone number is not set.');
  }
  const conn = loadConnection(workspace, 'whatsapp');
  if (!conn?.accessToken || !conn?.phoneNumberId) {
    throw new Error('WhatsApp is not connected. Connect WhatsApp in the Deploy tab first.');
  }
  const accessToken = substitute(conn.accessToken);
  const url = `https://graph.facebook.com/v21.0/${conn.phoneNumberId}/messages`;
  const phone = String(ownerCfg.phone).replace(/[^\d+]/g, '');
  const text = payload.text || buildText(payload);
  // With buttons → interactive reply-button message (one tap, no confirm).
  // Up to 3 buttons; titles capped at 20 chars per WhatsApp limits.
  let messageBody;
  if (Array.isArray(payload.buttons) && payload.buttons.length) {
    messageBody = {
      messaging_product: 'whatsapp',
      to: phone,
      type: 'interactive',
      interactive: {
        type: 'button',
        body: { text },
        action: {
          buttons: payload.buttons.slice(0, 3).map(b => ({
            type: 'reply',
            reply: { id: b.id, title: b.title.slice(0, 20) },
          })),
        },
      },
    };
  } else {
    messageBody = { messaging_product: 'whatsapp', to: phone, type: 'text', text: { body: text } };
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${accessToken}`,
    },
    body: JSON.stringify(messageBody),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok || body.error) {
    throw new Error(`WhatsApp API ${res.status}: ${body.error?.message || 'unknown error'}. Note: WhatsApp only allows free-form messages within 24h of the recipient's last message — for older windows you need a pre-approved template.`);
  }
  // Auto-verify: link the configured WhatsApp phone as owner if not set.
  // For WhatsApp, ownerId is the phone number (digits only, no '+').
  try {
    if (!conn.ownerId) {
      const ownerPhone = phone.replace(/[^\d]/g, '');
      const updated = { ...conn, ownerId: ownerPhone };
      saveConnection(workspace, 'whatsapp', updated);
    }
  } catch { /* best-effort */ }
  return {
    channel: 'whatsapp',
    ok: true,
    channel_message_id: body.messages?.[0]?.id || null,
    sent_to: phone,
  };
}

async function sendEmail(ownerCfg, payload) {
  if (!ownerCfg?.to) {
    throw new Error('Email recipient is not set.');
  }
  const smtp = ownerCfg.smtp || {};
  if (!smtp.host || !smtp.user || !smtp.pass) {
    throw new Error('SMTP host, user, and pass are required.');
  }
  // nodemailer is loaded lazily so the dependency is only required when
  // email notifications are actually used.
  let nodemailer;
  try {
    nodemailer = (await import('nodemailer')).default;
  } catch {
    throw new Error('nodemailer is not installed. Run: npm install nodemailer');
  }
  const transport = nodemailer.createTransport({
    host: substitute(smtp.host),
    port: Number(smtp.port) || 587,
    secure: smtp.secure === true || Number(smtp.port) === 465,
    auth: {
      user: substitute(smtp.user),
      pass: substitute(smtp.pass),
    },
  });
  const info = await transport.sendMail({
    from: substitute(ownerCfg.from || ownerCfg.to),
    to: substitute(ownerCfg.to),
    subject: payload.title || 'Agent notification',
    text: buildText(payload),
  });
  return {
    channel: 'email',
    ok: true,
    channel_message_id: info?.messageId || null,
    sent_to: substitute(ownerCfg.to),
  };
}

// ─── Orchestrator ───────────────────────────────────────────────

/**
 * Send a notification to all enabled channels. Failures on one channel do
 * not block the others. Returns { alert_id, sent: [...], failed: [...] }.
 *
 * `context` (optional) records what conversation triggered this alert so
 * an owner reply can be routed back to the right customer session:
 *   { session_platform, session_user_id, session_user_name, transaction_id }
 */
export async function notifyOwner(workspace, paths, payload, context) {
  const config = loadNotificationsConfig(paths);
  const text = buildText(payload);
  if (!text) return { sent: [], failed: [{ channel: 'all', error: 'Empty notification.' }] };

  const tasks = [];
  if (config.telegram?.enabled) tasks.push(sendTelegram(workspace, config.telegram, payload));
  if (config.whatsapp?.enabled) tasks.push(sendWhatsapp(workspace, config.whatsapp, payload));
  if (config.email?.enabled) tasks.push(sendEmail(config.email, payload));

  if (tasks.length === 0) {
    return { sent: [], failed: [{ channel: 'none', error: 'No notification channels are enabled. Configure them in the dashboard Notifications tab.' }] };
  }

  const results = await Promise.allSettled(tasks);
  const sent = [], failed = [];
  for (const r of results) {
    if (r.status === 'fulfilled') sent.push(r.value);
    else failed.push({ channel: r.reason?.channel || 'unknown', error: r.reason?.message || String(r.reason) });
  }

  // Save a ledger entry so an owner reply on Telegram/WhatsApp can be routed
  // back to this conversation. Skip the ledger only when literally nothing
  // was sent — without channel_message_ids, there's nothing to match against.
  let alert_id = null;
  if (sent.length > 0) {
    alert_id = newAlertId();
    const now = new Date();
    saveAlert(paths, {
      alert_id,
      sent_at: now.toISOString(),
      expires_at: new Date(now.getTime() + defaultTtlMs()).toISOString(),
      status: 'pending',
      title: payload.title || '',
      message: payload.message || '',
      severity: payload.severity || 'info',
      channels: sent,
      failed,
      context: context || null,
      responses: [],
    });
  }

  return { alert_id, sent, failed };
}

/**
 * Send a single test message on one specific channel. Used by the dashboard
 * Test button so the operator gets instant feedback that their config works.
 */
export async function testChannel(workspace, paths, channel, payload) {
  const config = loadNotificationsConfig(paths);
  const ownerCfg = config[channel];
  if (!ownerCfg) throw new Error(`No config for channel "${channel}".`);
  const msg = payload || {
    title: 'Test from your agent',
    message: 'If you received this, owner notifications are working. Reply to keep the channel alive.',
  };
  if (channel === 'telegram') return await sendTelegram(workspace, ownerCfg, msg);
  if (channel === 'whatsapp') return await sendWhatsapp(workspace, ownerCfg, msg);
  if (channel === 'email') return await sendEmail(ownerCfg, msg);
  throw new Error(`Unknown channel "${channel}".`);
}

// ─── Transaction alerts ─────────────────────────────────────────
//
// Pushes a per-transaction card to the owner's enabled channels when
// `transaction_alerts.enabled` is set. Opt-in, off by default. Reuses the same
// recipients (telegram.chat_id / whatsapp.phone) and senders as owner alerts.
// WhatsApp sends that fail (e.g. closed 24h window) are queued and replayed on
// the owner's next inbound message — see flushPendingWhatsApp.

function pendingWhatsAppPath(paths) {
  return path.join(path.dirname(paths.notifications), 'pending_whatsapp.json');
}

function enqueuePendingWhatsApp(paths, item) {
  try {
    const fp = pendingWhatsAppPath(paths);
    const list = readJson(fp) || [];
    list.push({ ...item, queued_at: new Date().toISOString() });
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeJson(fp, list.slice(-100)); // cap to avoid unbounded growth
  } catch { /* best-effort */ }
}

// ─── Telegram "one live card per transaction" ───────────────────
//
// We remember the message we sent for each transaction so a later change can
// delete the stale card and post a fresh one — keeping a single, current card
// (no lingering buttons on a cancelled order). Telegram-only: WhatsApp can't
// delete or edit sent messages.

function txnCardsPath(paths) {
  return path.join(path.dirname(paths.notifications), 'txn_cards.json');
}

function getCardRef(paths, txnId) {
  try {
    const map = readJson(txnCardsPath(paths)) || {};
    return map[String(txnId)] || null;
  } catch { return null; }
}

function setCardRef(paths, txnId, ref) {
  try {
    const fp = txnCardsPath(paths);
    const map = readJson(fp) || {};
    if (ref) map[String(txnId)] = ref; else delete map[String(txnId)];
    // Prune oldest entries so the file can't grow without bound. Numeric
    // transaction-id keys sort ascending, so the first keys are the oldest.
    const keys = Object.keys(map);
    if (keys.length > 500) {
      for (const k of keys.slice(0, keys.length - 500)) delete map[k];
    }
    fs.mkdirSync(path.dirname(fp), { recursive: true });
    writeJson(fp, map);
  } catch { /* best-effort */ }
}

async function deleteTelegramMessage(workspace, chatId, messageId) {
  try {
    const conn = loadConnection(workspace, 'telegram');
    if (!conn?.botToken) return;
    await fetch(`https://api.telegram.org/bot${conn.botToken}/deleteMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, message_id: messageId }),
    });
  } catch { /* best-effort — Telegram won't delete messages older than ~48h */ }
}

/**
 * Send the owner a card for a transaction event ('created' | 'updated' |
 * 'cancelled' | 'completed'). Best-effort: never throws. No-op unless
 * `transaction_alerts.enabled`.
 */
export async function notifyTransaction(workspace, paths, txn, event) {
  let config;
  try { config = loadNotificationsConfig(paths); } catch { return; }
  if (!config?.transaction_alerts?.enabled) return;
  if (!txn) return;

  const viewConfig = (() => { try { return readJson(paths.transactionView) || {}; } catch { return {}; } })();
  const card = renderTransactionCard(txn, event, viewConfig);

  if (config.telegram?.enabled && config.telegram?.chat_id) {
    try {
      // Replace this transaction's previous card so only one current card
      // exists — the fresh one reflects the new state (and drops the buttons
      // once terminal). 'created' has no predecessor to remove.
      const prev = getCardRef(paths, txn.id)?.telegram;
      if (prev && event !== 'created') {
        await deleteTelegramMessage(workspace, prev.chat_id, prev.message_id);
      }
      const res = await sendTelegram(workspace, config.telegram, {
        text: card.telegramHtml, parse_mode: 'HTML', buttons: card.buttons,
      });
      if (res?.channel_message_id) {
        setCardRef(paths, txn.id, { telegram: { chat_id: res.sent_to, message_id: res.channel_message_id } });
      }
    } catch (e) { console.warn(`[txn-alert] telegram failed: ${e.message}`); }
  }

  if (config.whatsapp?.enabled && config.whatsapp?.phone) {
    try {
      await sendWhatsapp(workspace, config.whatsapp, { text: card.whatsappText, buttons: card.buttons });
    } catch (e) {
      // Likely a closed 24h window (or transient) — queue for replay on the
      // owner's next inbound message, which reopens the window.
      enqueuePendingWhatsApp(paths, { text: card.whatsappText, buttons: card.buttons });
    }
  }

  if (config.email?.enabled && config.email?.to) {
    try {
      await sendEmail(config.email, { title: `Transaction #${txn.id}`, message: card.plainText });
    } catch (e) { console.warn(`[txn-alert] email failed: ${e.message}`); }
  }
}

/**
 * Replay any queued WhatsApp cards, in order, when the owner's window reopens
 * (called from the WhatsApp connector on an owner inbound message). The window
 * is open at this point, so cards send with their buttons intact. Best-effort;
 * cards that still fail stay queued for next time.
 */
export async function flushPendingWhatsApp(workspace, paths) {
  const fp = pendingWhatsAppPath(paths);
  let list;
  try { list = readJson(fp); } catch { return; }
  if (!Array.isArray(list) || list.length === 0) return;

  let config;
  try { config = loadNotificationsConfig(paths); } catch { return; }
  if (!config?.whatsapp?.enabled || !config?.whatsapp?.phone) return;

  const remaining = [];
  for (const item of list) {
    try {
      await sendWhatsapp(workspace, config.whatsapp, { text: item.text, buttons: item.buttons });
    } catch {
      remaining.push(item); // still failing — keep for next time
    }
  }
  try { writeJson(fp, remaining); } catch { /* best-effort */ }
}
