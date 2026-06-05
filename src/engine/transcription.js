import fs from 'fs';
import path from 'path';
import { getProviderCredential } from '../auth/credentials.js';

// Speech-to-text for inbound customer voice messages.
//
// Provider-agnostic: any service that exposes an OpenAI-compatible
// `/audio/transcriptions` endpoint works by adding one entry to STT_PROVIDERS
// (or by passing an explicit `endpoint` for a custom host). The API key is
// resolved from the normal credentials store keyed by provider name — the
// same place LLM keys live — so a voice key is added like any other API key.

const MAX_AUDIO_BYTES = 25 * 1024 * 1024; // keep well under common 25–40 MB limits

const STT_PROVIDERS = {
  groq:   { url: 'https://api.groq.com/openai/v1/audio/transcriptions', defaultModel: 'whisper-large-v3-turbo' },
  openai: { url: 'https://api.openai.com/v1/audio/transcriptions',      defaultModel: 'whisper-1' },
};

/** Provider keys we ship with built-in endpoints. */
export function sttProviderList() {
  return Object.keys(STT_PROVIDERS);
}

/** Default model for a provider, if known. */
export function sttDefaultModel(provider) {
  return STT_PROVIDERS[provider]?.defaultModel || '';
}

/**
 * Transcribe an audio file to text.
 *
 * @param {object} opts
 * @param {string} opts.filePath  Absolute path to the audio file.
 * @param {string} opts.provider  Credential/provider name (e.g. 'groq', 'openai').
 * @param {string} [opts.model]   Override model; falls back to the provider default.
 * @param {string} [opts.language] Optional ISO-639-1 hint (e.g. 'en'); omit to auto-detect.
 * @param {string} [opts.endpoint] Override URL for a custom OpenAI-compatible host.
 * @returns {Promise<string>} The transcript (may be empty if speech wasn't detected).
 */
export async function transcribeAudio({ filePath, provider = 'groq', model, language, endpoint } = {}) {
  const spec = STT_PROVIDERS[provider];
  const url = endpoint || spec?.url;
  if (!url) throw new Error(`Unknown transcription provider "${provider}" and no endpoint given.`);

  const cred = getProviderCredential(provider);
  if (!cred?.apiKey) {
    throw new Error(`No API key for "${provider}". Add it in Settings → Add API Key.`);
  }
  if (!fs.existsSync(filePath)) throw new Error(`Audio file not found: ${filePath}`);

  const stat = fs.statSync(filePath);
  if (stat.size > MAX_AUDIO_BYTES) {
    throw new Error(`Audio file is too large (${Math.round(stat.size / 1048576)} MB).`);
  }

  const buffer = fs.readFileSync(filePath);
  const form = new FormData();
  form.append('file', new Blob([buffer]), path.basename(filePath));
  form.append('model', model || spec?.defaultModel || 'whisper-1');
  form.append('response_format', 'json');
  if (language) form.append('language', language);

  const res = await fetch(url, {
    method: 'POST',
    headers: { Authorization: `Bearer ${cred.apiKey}` },
    body: form,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Transcription failed (${res.status}): ${body.slice(0, 200)}`);
  }
  const data = await res.json().catch(() => ({}));
  return (data.text || '').trim();
}
