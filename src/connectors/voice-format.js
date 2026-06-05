/**
 * Strip agent-emitted markdown/formatting down to plain spoken text for
 * text-to-speech (Telnyx voice). Unlike the WhatsApp/Slack formatters — which
 * *translate* markdown into a chat client's inline syntax — a phone call has no
 * visual surface, so anything non-verbal must be **removed**: a TTS engine
 * would otherwise read "asterisk asterisk", spell out URLs, or mangle headings,
 * tables, and list bullets.
 *
 * Shared by the direct `telnyx.js` connector and the relay client's
 * `telnyx:chat` handler — one source of truth, same pattern as
 * `formatForWhatsApp`.
 */

// Emoji, pictographs, dingbats, arrows, and the variation-selector / ZWJ glue.
// TTS reads these as nothing useful (or speaks their name mid-sentence).
const EMOJI = /[\u{1F000}-\u{1FAFF}\u{2600}-\u{27BF}\u{2190}-\u{21FF}\u{2B00}-\u{2BFF}\u{FE0F}\u{200D}]/gu;

export function formatForVoice(text) {
  if (!text) return text;

  let out = text;

  // 1. Code: drop fences/backticks, keep the inner words (they may be spoken).
  out = out.replace(/```[a-zA-Z0-9]*\n?([\s\S]*?)```/g, '$1');
  out = out.replace(/`([^`\n]+)`/g, '$1');

  // 2. Tables → "cell, cell" per row; drop separator rows.
  out = out
    .replace(/^[ \t]*\|?[ \t:|-]*-{2,}[ \t:|-]*\|?[ \t]*$/gm, '')
    .replace(/^[ \t]*\|(.+?)\|?[ \t]*$/gm, (_, row) =>
      row.split('|').map((c) => c.trim()).filter(Boolean).join(', '));

  // 3. Images / links → spoken text only (never read a URL aloud).
  out = out
    .replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');

  // 4. Emphasis markers — remove, keep the words. Bold/bold-italic first, then
  //    single * / _ / ~ guarded against snake_case and arithmetic.
  out = out
    .replace(/\*\*\*([^\n]+?)\*\*\*/g, '$1')
    .replace(/\*\*([^\n]+?)\*\*/g, '$1')
    .replace(/___([^\n]+?)___/g, '$1')
    .replace(/__([^\n]+?)__/g, '$1')
    .replace(/~~([^\n]+?)~~/g, '$1')
    .replace(/(^|[^\w*])\*(?!\s)([^*\n]+?)\*(?!\w)/g, '$1$2')
    .replace(/(^|[^\w_])_(?!\s)([^_\n]+?)_(?!\w)/g, '$1$2')
    .replace(/(^|[^\w~])~(?!\s)([^~\n]+?)~(?!\w)/g, '$1$2');

  // 5. Headings → plain text.
  out = out.replace(/^[ \t]{0,3}#{1,6}[ \t]+(.+?)[ \t]*#*[ \t]*$/gm, '$1');

  // 6. Blockquotes → drop the marker.
  out = out.replace(/^[ \t]*>[ \t]?/gm, '');

  // 7. Horizontal rules → drop the line.
  out = out.replace(/^[ \t]*([-*_])\1{2,}[ \t]*$/gm, '');

  // 8. List markers (bullets + numbered) → drop, keep the item text.
  out = out.replace(/^[ \t]*[*\-+][ \t]+/gm, '');
  out = out.replace(/^[ \t]*\d+[.)][ \t]+/gm, '');

  // 9. Strip emoji / variation selectors.
  out = out.replace(EMOJI, '');

  // 10. Normalise whitespace for clean prosody.
  out = out
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/^[ \t]+/gm, '')   // leading space (e.g. left by a stripped emoji)
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();

  return out;
}
