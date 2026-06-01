import fs from 'fs';
import path from 'path';
import { WebSocket } from 'ws';
import { BaseConnector } from './index.js';
import { readFileBuffer } from './media.js';
import { writePlatformSkill } from '../utils/workspace.js';
import { loadConnection } from '../auth/connections.js';

const SLACK_API_BASE = 'https://slack.com/api';
const SLACK_MAX_DOWNLOAD_BYTES = 100 * 1024 * 1024; // Conservative cap (Slack allows up to 1 GB)

const SLACK_SKILL = `---
name: slack
description: Sending files to users via the Slack connector
---

# Slack Connector — Sending Files

You can upload images, audio, video, and arbitrary files to Slack channels and
DMs. The connector handles the upload via Slack's \`files.upload\` API — you
just embed the file in your reply as markdown using a **workspace-relative**
path.

## How to send a file

1. Place (or generate) the file inside your workspace, e.g. \`data/photos/foo.png\`.
2. Embed it in your reply using markdown:

   - Image:    \`![caption](data/photos/foo.png)\`
   - Audio:    \`[song.mp3](data/audio/song.mp3)\`
   - Video:    \`[clip.mp4](data/video/clip.mp4)\`
   - File:     \`[notes.pdf](data/files/notes.pdf)\`

3. The connector strips the markdown ref out of the text and uploads each file
   to the same channel/DM the message is going to. Images preview inline in
   Slack; other files appear as file cards. The markdown alt / link text is
   used as the file's title.

## Rules

- **Paths must be workspace-relative.** Absolute or out-of-workspace paths are
  silently dropped.
- Slack file size limit: **1 GB per file** (workspace-wide storage may apply).
- You can upload multiple files in one reply.
- Text messages use Slack's \`mrkdwn\` formatting (similar to but not identical
  to standard markdown — bold is \`*bold*\`, italic is \`_italic_\`).
- Threaded replies preserve the parent thread when applicable.
`;

/**
 * Slack connector — connects the agent to a Slack bot.
 * Uses Socket Mode (WebSocket) for real-time messages.
 * No external dependencies beyond ws (already used by the project).
 *
 * Requires two tokens:
 * - Bot Token (xoxb-...) — for sending messages via Web API
 * - App-Level Token (xapp-...) — for Socket Mode WebSocket connection
 */
export default class SlackConnector extends BaseConnector {
  constructor(config, engine) {
    super(config, engine);
    this.botToken = config.botToken;
    this.appToken = config.appToken;
    this.apiBase = SLACK_API_BASE;
    this.ws = null;
    this.botUserId = null;
    this.botInfo = null;
  }

  get platformName() { return 'slack'; }

  async connect() {
    this.status = 'connecting';
    writePlatformSkill(this.engine?.workspace, 'slack', SLACK_SKILL);

    // Verify the bot token
    try {
      const resp = await fetch(`${this.apiBase}/auth.test`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${this.botToken}` },
      });
      const data = await resp.json();
      if (!data.ok) throw new Error(data.error || 'Invalid bot token');
      this.botUserId = data.user_id;
      this.botInfo = { userId: data.user_id, teamId: data.team_id, botName: data.user };
      console.log(`[slack] Verified bot: ${data.user} (team: ${data.team})`);
    } catch (err) {
      this.status = 'error';
      this.error = err.message;
      throw err;
    }

    // Open Socket Mode connection
    await this._connectWebSocket();
  }

  async _connectWebSocket() {
    // Get a WebSocket URL via apps.connections.open
    const resp = await fetch(`${this.apiBase}/apps.connections.open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${this.appToken}` },
    });
    const data = await resp.json();
    if (!data.ok) throw new Error(`Socket Mode failed: ${data.error}`);

    return new Promise((resolve, reject) => {
      this.ws = new WebSocket(data.url);

      this.ws.on('open', () => {
        console.log('[slack] Socket Mode connected');
      });

      this.ws.on('message', (raw) => {
        const payload = JSON.parse(raw.toString());
        this._handlePayload(payload, resolve);
      });

      this.ws.on('close', (code) => {
        console.log(`[slack] WebSocket closed: ${code}`);
        if (this.status === 'connected') {
          this.status = 'reconnecting';
          setTimeout(() => this._reconnect(), 5000);
        }
      });

      this.ws.on('error', (err) => {
        console.error('[slack] WebSocket error:', err.message);
      });

      // Timeout
      setTimeout(() => {
        if (this.status === 'connecting') {
          this.status = 'error';
          this.error = 'Connection timeout';
          reject(new Error('Connection timeout'));
        }
      }, 30000);
    });
  }

  _handlePayload(payload, connectResolve) {
    const { type, envelope_id } = payload;

    // Acknowledge all envelopes immediately
    if (envelope_id) {
      this.ws.send(JSON.stringify({ envelope_id }));
    }

    switch (type) {
      case 'hello':
        this.status = 'connected';
        this.error = null;
        console.log('[slack] Socket Mode ready');
        if (connectResolve) connectResolve();
        break;

      case 'events_api':
        this._handleEvent(payload.payload);
        break;

      case 'disconnect':
        console.log('[slack] Server requested disconnect, reconnecting...');
        this._reconnect();
        break;
    }
  }

  _handleEvent(payload) {
    const event = payload?.event;
    if (!event) return;

    // Handle message events (plain text or with files via file_share subtype)
    const isMessage = event.type === 'message'
      && (!event.subtype || event.subtype === 'file_share')
      && event.user !== this.botUserId;

    if (isMessage) {
      // DMs (im) or mentions in channels
      const isDM = event.channel_type === 'im';
      const isMentioned = event.text?.includes(`<@${this.botUserId}>`);
      const hasFiles = Array.isArray(event.files) && event.files.length > 0;

      if (isDM || isMentioned || (hasFiles && isDM)) {
        // Strip bot mention
        let textPart = event.text || '';
        if (isMentioned) {
          textPart = textPart.replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
        }
        if (!textPart && !hasFiles) return;

        this._dispatchMessage(event, textPart, isDM);
      }
    }

    // Handle app_mention events (for channels where the bot is mentioned)
    if (event.type === 'app_mention' && event.user !== this.botUserId) {
      const textPart = (event.text || '').replace(new RegExp(`<@${this.botUserId}>`, 'g'), '').trim();
      const hasFiles = Array.isArray(event.files) && event.files.length > 0;
      if (!textPart && !hasFiles) return;

      this._dispatchMessage(event, textPart, false);
    }
  }

  /**
   * Build content (text + downloaded files) and dispatch via handleEvent.
   * Runs async; downloads happen after the envelope ack so we don't block Slack.
   */
  _dispatchMessage(event, textPart, isDM) {
    (async () => {
      try {
        let content = textPart || '';
        const files = Array.isArray(event.files) ? event.files : [];
        if (files.length > 0) {
          const safeUser = String(event.user || 'user').replace(/[^a-zA-Z0-9._-]/g, '_');
          const savedFiles = await this._downloadMedia(files, safeUser);
          if (savedFiles.length > 0) {
            const fileList = savedFiles.map(f => `${f.type}: ${f.path}`).join(', ');
            content = content
              ? `${content}\n\n[Attached files: ${fileList}]`
              : `[Attached files: ${fileList}]`;
          }
        }

        if (!content) return;

        await this.handleEvent({
          platform: 'slack',
          userId: event.user,
          userName: event.user,
          type: 'message',
          content,
          metadata: {
            channelId: event.channel,
            threadTs: event.thread_ts || event.ts,
            ts: event.ts,
            isDM,
          },
        });
      } catch (err) {
        console.error('[slack] Error processing message:', err.message);
      }
    })();
  }

  async send(event, response, result, files = []) {
    const channelId = event.metadata?.channelId;
    if (!channelId) return;

    const threadTs = event.metadata?.threadTs;

    // Upload files via Slack's 3-step flow (with retry)
    for (const file of files) {
      for (let attempt = 1; attempt <= 3; attempt++) {
        try {
          const buffer = await readFileBuffer(file);

          // Step 1: Get an upload URL
          const urlResp = await fetch(`${this.apiBase}/files.getUploadURLExternal`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.botToken}`,
              'Content-Type': 'application/x-www-form-urlencoded',
            },
            body: new URLSearchParams({
              filename: file.filename,
              length: String(buffer.length),
            }),
          });
          const urlData = await urlResp.json();
          if (!urlData.ok) throw new Error(`getUploadURLExternal: ${urlData.error}`);

          // Step 2: Upload file to the presigned URL
          const uploadResp = await fetch(urlData.upload_url, {
            method: 'POST',
            body: buffer,
            headers: { 'Content-Type': file.mimeType },
          });
          if (!uploadResp.ok) throw new Error(`File upload: HTTP ${uploadResp.status}`);

          // Step 3: Complete the upload and share to channel
          const completeBody = {
            files: [{ id: urlData.file_id, title: file.alt || file.filename }],
            channel_id: channelId,
          };
          if (threadTs) completeBody.thread_ts = threadTs;

          await fetch(`${this.apiBase}/files.completeUploadExternal`, {
            method: 'POST',
            headers: {
              Authorization: `Bearer ${this.botToken}`,
              'Content-Type': 'application/json',
            },
            body: JSON.stringify(completeBody),
          });
          break; // success
        } catch (err) {
          console.warn(`[slack] File upload attempt ${attempt}/3 failed for ${file.filename}: ${err.message}`);
          if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          else console.error(`[slack] Failed to upload file ${file.filename} after 3 attempts`);
        }
      }
    }

    // Send text response with retry
    if (response) {
      const chunks = this._splitMessage(response, 4000);
      for (const chunk of chunks) {
        const body = {
          channel: channelId,
          text: formatForSlack(chunk),
        };
        if (threadTs) body.thread_ts = threadTs;

        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(`${this.apiBase}/chat.postMessage`, {
              method: 'POST',
              headers: {
                Authorization: `Bearer ${this.botToken}`,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify(body),
            });
            if (resp.ok) break;
            console.warn(`[slack] Send attempt ${attempt}/3 failed: HTTP ${resp.status}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            else console.error('[slack] Failed to send message after 3 attempts');
          } catch (err) {
            console.warn(`[slack] Send attempt ${attempt}/3 failed: ${err.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
            else console.error('[slack] Failed to send message after 3 attempts');
          }
        }
      }
    }
  }

  async _reconnect() {
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
    if (this.status === 'disconnected') return;

    console.log('[slack] Reconnecting...');
    this.status = 'reconnecting';

    try {
      await this._connectWebSocket();
    } catch (err) {
      console.error('[slack] Reconnect failed:', err.message);
      setTimeout(() => this._reconnect(), 10000);
    }
  }

  async disconnect() {
    if (this.ws) {
      try { this.ws.close(1000); } catch { /* ignore */ }
      this.ws = null;
    }
    await super.disconnect();
  }

  getStatus() {
    return {
      ...super.getStatus(),
      botUserId: this.botUserId || null,
      botName: this.botInfo?.botName || null,
    };
  }

  _typeFromMime(mime) {
    if (!mime) return 'file';
    if (mime.startsWith('image/')) return 'image';
    if (mime.startsWith('audio/')) return 'audio';
    if (mime.startsWith('video/')) return 'video';
    return 'file';
  }

  /**
   * Download Slack file objects into the workspace inbox.
   * Mirrors truuze.js _downloadMedia: writes to data/inbox/<user>_<ts>_<safeName>
   * and returns [{type, path}] with workspace-relative paths.
   *
   * Slack file objects include url_private_download which requires the bot
   * token in an Authorization header.
   */
  async _downloadMedia(slackFiles, username) {
    const inboxDir = path.join(this.engine.workspace, 'data', 'inbox');
    fs.mkdirSync(inboxDir, { recursive: true });

    const saved = [];
    for (const f of slackFiles) {
      try {
        const downloadUrl = f.url_private_download || f.url_private;
        if (!downloadUrl) {
          console.error('[slack] file has no download url:', f.id);
          continue;
        }
        if (f.size && f.size > SLACK_MAX_DOWNLOAD_BYTES) {
          console.warn(`[slack] Skipping ${f.name}: ${f.size} bytes exceeds limit`);
          continue;
        }

        let buffer;
        for (let attempt = 1; attempt <= 3; attempt++) {
          try {
            const resp = await fetch(downloadUrl, {
              headers: { Authorization: `Bearer ${this.botToken}` },
              signal: AbortSignal.timeout(60_000),
            });
            if (!resp.ok) {
              console.warn(`[slack] Download attempt ${attempt}/3 failed for ${f.id}: HTTP ${resp.status}`);
              if (attempt < 3) { await new Promise(r => setTimeout(r, 2000)); continue; }
              break;
            }
            buffer = Buffer.from(await resp.arrayBuffer());
            break;
          } catch (fetchErr) {
            console.warn(`[slack] Download attempt ${attempt}/3 failed for ${f.id}: ${fetchErr.message}`);
            if (attempt < 3) await new Promise(r => setTimeout(r, 2000));
          }
        }
        if (!buffer) {
          console.error('[slack] Failed to download file after 3 attempts:', f.id);
          continue;
        }

        const type = this._typeFromMime(f.mimetype);
        const originalName = f.name || `file_${f.id || Date.now()}`;
        const safeName = originalName.replace(/[^a-zA-Z0-9._-]/g, '_');
        const filename = `${username}_${Date.now()}_${safeName}`;
        const filePath = path.join(inboxDir, filename);
        fs.writeFileSync(filePath, buffer);

        const relativePath = `data/inbox/${filename}`;
        saved.push({ type, path: relativePath });
        console.log('[slack] Downloaded file:', type, relativePath, buffer.length, 'bytes');
      } catch (err) {
        console.error('[slack] File download error:', f.id, err.message);
      }
    }
    return saved;
  }

  _splitMessage(text, maxLen) {
    return splitSlackText(text, maxLen);
  }
}

/**
 * Split text into chunks no longer than maxLen, preferring to break on a
 * newline. Module-level so the connector instance and the static sendDirect
 * path share it.
 */
function splitSlackText(text, maxLen) {
  if (text.length <= maxLen) return [text];
  const chunks = [];
  let remaining = text;
  while (remaining.length > 0) {
    if (remaining.length <= maxLen) {
      chunks.push(remaining);
      break;
    }
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < maxLen * 0.3) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  return chunks;
}

/**
 * Send plain text to a Slack user by opening a DM (conversations.open) and
 * posting there, applying the same mrkdwn formatting, chunking, and 3x retry
 * the live send() path uses. Static so it works from the dashboard process.
 *
 * Slack returns HTTP 200 even on logical errors, so success is gated on the
 * response body's `ok` field, not the HTTP status. Returns
 * { ok, message_id } / { ok:false, error }.
 */
async function postSlackDM({ botToken, apiBase = SLACK_API_BASE }, userId, text) {
  // 1. Open (or reuse) the DM channel with the user.
  let channelId;
  try {
    const resp = await fetch(`${apiBase}/conversations.open`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ users: userId }),
    });
    const data = await resp.json().catch(() => ({}));
    if (!data.ok || !data.channel?.id) {
      return { ok: false, error: data.error || `Could not open DM (HTTP ${resp.status})` };
    }
    channelId = data.channel.id;
  } catch (err) {
    return { ok: false, error: err.message };
  }

  // 2. Post the message in chunks with retry.
  const chunks = splitSlackText(text, 3500);
  let lastTs;
  for (const chunk of chunks) {
    let sent = false;
    let lastError = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const resp = await fetch(`${apiBase}/chat.postMessage`, {
          method: 'POST',
          headers: { Authorization: `Bearer ${botToken}`, 'Content-Type': 'application/json' },
          body: JSON.stringify({ channel: channelId, text: formatForSlack(chunk) }),
        });
        const data = await resp.json().catch(() => ({}));
        if (data.ok) {
          lastTs = data.ts || lastTs;
          sent = true;
          break;
        }
        lastError = data.error || `HTTP ${resp.status}`;
      } catch (err) {
        lastError = err.message;
      }
      if (attempt < 3) await new Promise((r) => setTimeout(r, 2000));
    }
    if (!sent) return { ok: false, error: lastError || 'Failed to send Slack message.' };
  }
  return { ok: true, message_id: lastTs };
}

/**
 * Static "send arbitrary text to a Slack customer" helper, mirroring the
 * Telegram/WhatsApp/Discord sendDirect exports. Used by the dashboard's admin-
 * intervention path (sendDirectToCustomer). The recipient is the customer's
 * Slack user id (how Slack sessions are keyed); the message is delivered as a
 * direct message. Reads the bot token from the workspace connection config.
 */
export async function sendDirect(workspace, recipient, text) {
  const conn = loadConnection(workspace, 'slack');
  if (!conn?.botToken) {
    return { ok: false, error: 'Slack is not connected for this workspace.' };
  }
  if (!recipient || !String(recipient).trim()) {
    return { ok: false, error: 'recipient user id is required.' };
  }
  if (!text || !String(text).trim()) {
    return { ok: false, error: 'text is required.' };
  }
  return postSlackDM({ botToken: conn.botToken, apiBase: conn.apiBase }, String(recipient), String(text));
}

/**
 * Translate agent-emitted GitHub-flavored markdown into Slack's mrkdwn.
 * Slack uses `*bold*` (single asterisk), `_italic_`, `~strike~`, single- and
 * triple-backtick code, `<url|text>` links, and native `>` blockquotes — but
 * has NO heading syntax, NO `[text](url)` markdown links, and renders
 * `**bold**` / `***x***` / tables / `#` headings as literal characters. This
 * pass rewrites or strips the unsupported markdown.
 *
 * Mirrors the WhatsApp formatter, with three Slack-specific differences:
 * inline code is kept (Slack renders it), links become `<url|text>`, and
 * blockquotes are left intact. Bold and italic are resolved through control-
 * char sentinels (convert bold first, then italic, then restore) to avoid the
 * single-asterisk ambiguity. Code spans are stashed up front so their contents
 * are never touched.
 */
function formatForSlack(text) {
  if (!text) return text;

  const BOLD = String.fromCharCode(1);
  const ITALIC = String.fromCharCode(2);
  const CODE = String.fromCharCode(0);
  const codeSpans = [];
  const stash = (m) => { codeSpans.push(m); return CODE + (codeSpans.length - 1) + CODE; };

  let out = text;

  // 1. Protect fenced AND inline code — Slack renders both, so keep verbatim.
  out = out.replace(/```[\s\S]*?```/g, stash);
  out = out.replace(/`[^`\n]+`/g, stash);

  // 2. Markdown tables → readable lines (Slack has no tables).
  out = out
    .replace(/^[ \t]*\|?[ \t:|-]*-{2,}[ \t:|-]*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.+?)\|?[ \t]*$/gm, (_, row) =>
      row.split('|').map((c) => c.trim()).filter(Boolean).join(' — '));

  // 3. Images / links → Slack syntax.
  out = out
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')          // ![alt](url) → alt
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<$2|$1>');     // [text](url) → <url|text>

  // 4. Bold (incl. bold-italic) → sentinel. Allow inner single `*` via [^\n].
  out = out
    .replace(/\*\*\*([^\n]+?)\*\*\*/g, BOLD + '$1' + BOLD) // ***x*** → bold
    .replace(/\*\*([^\n]+?)\*\*/g, BOLD + '$1' + BOLD)     // **x**
    .replace(/___([^\n]+?)___/g, BOLD + '$1' + BOLD)
    .replace(/__([^\n]+?)__/g, BOLD + '$1' + BOLD);        // __x__

  // 5. Remaining single * / _ → italic sentinel. Guard snake_case / arithmetic.
  out = out
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1' + ITALIC + '$2' + ITALIC)
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1' + ITALIC + '$2' + ITALIC);

  // 6. Strikethrough.
  out = out.replace(/~~([^\n]+?)~~/g, '~$1~');             // ~~x~~ → ~x~

  // 7. Headings → bold line (Slack has no headings).
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, BOLD + '$1' + BOLD);

  // 8. Horizontal rules (---, ***, ___ on their own line) → drop.
  out = out.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');

  // 9. Bullets → • (Slack doesn't reliably render markdown bullets).
  //    Blockquotes (> ) are intentionally left intact — Slack renders them.
  out = out.replace(/^([ \t]*)[*\-+][ \t]+/gm, '$1• ');

  // Restore sentinels to mrkdwn syntax, then code spans.
  out = out
    .replace(new RegExp(BOLD, 'g'), '*')
    .replace(new RegExp(ITALIC, 'g'), '_')
    .replace(new RegExp(CODE + '(\\d+)' + CODE, 'g'), (_, i) => codeSpans[Number(i)]);

  return out;
}
