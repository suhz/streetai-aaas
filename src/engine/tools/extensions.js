import fs from 'fs';
import path from 'path';
import { readJson } from '../../utils/workspace.js';
import { logError } from '../../utils/errlog.js';

/**
 * Call an external API extension (or another agent) registered in the workspace.
 *
 * Two ways to call an API extension:
 *
 *   1. Operation-based (preferred): pass `operation: "<op_name>"`. The runtime
 *      reads path/method/async/output_type from the registered operation. The
 *      agent only needs to supply `data` (the body).
 *
 *   2. Free-form (legacy, still supported): pass `method`, `path`, `data`.
 *      The runtime sends the request as-is.
 *
 * Schema additions (all optional, all backwards-compatible):
 *
 *   extension.operations[]:
 *     - name: identifier the agent uses
 *     - description: one-liner shown in the prompt
 *     - method: HTTP method
 *     - path: relative path; supports `{placeholder}` filled from `data`
 *     - body: example/schema body (documentation for the agent — not enforced)
 *     - returns: example response shape (documentation)
 *     - output_type: 'json' (default) | 'text' | 'binary'
 *     - async: { poll_path, ready_field, ready_values[], failure_values[],
 *               result_field?, interval_s?, max_wait_s? }
 *
 *   extension.{endpoint, headers, auth.apiKey, body fields, paths}:
 *     - Support `{{ENV_VAR}}` substitution from process.env at call time.
 */
export async function callExtension(paths, args) {
  const { name } = args || {};
  const registry = readJson(paths.extensions);
  const extensions = registry?.extensions || (Array.isArray(registry) ? registry : []);

  const ext = lookupExtension(extensions, name);
  if (!ext) {
    const available = extensions.map(e => e.name);
    return JSON.stringify({
      error: `Extension "${name}" not found.`,
      available,
      hint: suggestName(name, available),
    });
  }
  return await callWithExtension(paths, ext, args);
}

/**
 * Run an extension call against a specific extension config (already resolved).
 * Used both by callExtension after lookup, and by the dashboard test endpoint
 * to exercise a draft (unsaved) extension config.
 */
export async function callWithExtension(paths, ext, args) {
  const { operation, method: rawMethod, path: rawPath, data: rawData } = args || {};

  // Agent-to-agent: send a natural language message to another AaaS agent.
  if (ext.type === 'agent') {
    return await callAgentExtension(ext, rawData, rawPath);
  }

  if (ext.type !== 'api' || !ext.endpoint) {
    return JSON.stringify({
      error: `Extension "${ext.name}" is type "${ext.type}" and cannot be called via HTTP.`,
      extension: { name: ext.name, type: ext.type, address: ext.address },
    });
  }

  // ── Resolve operation (if given) ──
  let op = null;
  if (operation) {
    op = (ext.operations || []).find(o =>
      (o.name || '').toLowerCase() === String(operation).toLowerCase()
    );
    if (!op) {
      const available = (ext.operations || []).map(o => o.name);
      return JSON.stringify({
        error: `Operation "${operation}" not found on extension "${ext.name}".`,
        available,
      });
    }
  }

  const method = (op?.method || rawMethod || 'GET').toUpperCase();
  const opPath = op?.path ?? rawPath ?? '';
  const data = rawData;

  // ── Env-var + placeholder substitution ──
  let endpoint, headers, auth, resolvedPath, resolvedBody;
  try {
    endpoint = substituteEnvVars(ext.endpoint);
    headers = substituteEnvVars(ext.headers || {});
    // Op-level headers (with {placeholder} fill from data) — e.g. a deterministic
    // Idempotency-Key derived from the booking's own values.
    if (op?.headers) headers = { ...headers, ...substituteEnvVars(fillTemplate(op.headers, data)) };
    auth = substituteEnvVars(ext.auth || null);
    resolvedPath = substituteEnvVars(fillPathPlaceholders(opPath, data));
    // If the op defines a body template, the structure (e.g. a FHIR resource) is
    // fixed in config and code fills it from the flat `data` — deterministic, the
    // model only supplies scalar values. Otherwise the data IS the body (legacy).
    resolvedBody = substituteEnvVars(op?.body ? fillTemplate(op.body, data) : data);
  } catch (err) {
    return JSON.stringify({
      error: `Extension "${ext.name}" could not resolve environment variables: ${err.message}`,
    });
  }

  const url = joinUrl(endpoint, resolvedPath);
  const outputType = (op?.output_type || ext.output_type || 'json').toLowerCase();

  // ── Initial request ──
  let initial;
  try {
    initial = await sendRequest({
      url,
      method,
      headers,
      auth,
      body: methodHasBody(method) ? resolvedBody : undefined,
      timeoutMs: (op?.timeout_s ?? 30) * 1000,
      outputType: op?.async ? 'json' : outputType,
      ext,
      operation: op,
      paths,
    });
  } catch (err) {
    logError(paths?.root, `extension:${ext.name}`, err, { operation: op?.name, method });
    if (err.name === 'AbortError') {
      return JSON.stringify({ error: `Extension "${ext.name}" timed out.` });
    }
    return JSON.stringify({ error: `Extension "${ext.name}" call failed: ${err.message}` });
  }

  // ── Async polling ──
  if (op?.async && initial.ok) {
    const polled = await pollOperation({
      ext,
      op,
      initialResponse: initial.data,
      endpoint,
      headers,
      auth,
      paths,
    });
    if (!polled.ok) {
      return JSON.stringify({ status: initial.status, ok: false, ...polled });
    }
    initial = polled;
  }

  // ── Binary handling ──
  if (outputType === 'binary' && initial.ok) {
    try {
      const saved = await saveBinary(initial.rawBody, initial.contentType, ext, op, paths);
      return JSON.stringify({ status: initial.status, ok: true, ...saved });
    } catch (err) {
      return JSON.stringify({ status: initial.status, ok: false, error: `Failed to save binary: ${err.message}` });
    }
  }

  return JSON.stringify({ status: initial.status, ok: initial.ok, data: initial.data });
}

// ─── Lookup ─────────────────────────────────────────────────────

function lookupExtension(extensions, name) {
  if (!name) return null;
  const lower = String(name).toLowerCase();
  // Exact match wins
  const exact = extensions.find(e => (e.name || '').toLowerCase() === lower);
  if (exact) return exact;
  // Then prefix
  const prefix = extensions.find(e => (e.name || '').toLowerCase().startsWith(lower));
  if (prefix) return prefix;
  // Then substring (current behavior, kept as fallback)
  return extensions.find(e => (e.name || '').toLowerCase().includes(lower)) || null;
}

function suggestName(query, available) {
  if (!available?.length) return null;
  const q = String(query || '').toLowerCase();
  const scored = available.map(n => ({
    name: n,
    score: levenshtein(q, n.toLowerCase()),
  }));
  scored.sort((a, b) => a.score - b.score);
  return scored[0].score <= Math.max(2, Math.ceil(q.length / 3))
    ? `Did you mean "${scored[0].name}"?`
    : null;
}

function levenshtein(a, b) {
  if (!a) return b.length;
  if (!b) return a.length;
  const m = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
  for (let i = 0; i <= a.length; i++) m[i][0] = i;
  for (let j = 0; j <= b.length; j++) m[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      m[i][j] = Math.min(m[i - 1][j] + 1, m[i][j - 1] + 1, m[i - 1][j - 1] + cost);
    }
  }
  return m[a.length][b.length];
}

// ─── Substitution ──────────────────────────────────────────────

function substituteEnvVars(value) {
  if (typeof value === 'string') {
    return value.replace(/\{\{(\w+)\}\}/g, (match, varName) => {
      const v = process.env[varName];
      if (v === undefined) {
        throw new Error(`environment variable not set: ${varName}`);
      }
      return v;
    });
  }
  if (Array.isArray(value)) return value.map(substituteEnvVars);
  if (value && typeof value === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(value)) out[k] = substituteEnvVars(v);
    return out;
  }
  return value;
}

function fillPathPlaceholders(template, source) {
  if (!template) return template;
  if (!source || typeof source !== 'object') return template;
  return template.replace(/\{([^{}]+)\}/g, (match, key) => {
    if (key.startsWith('{')) return match; // env-var, leave for substituteEnvVars
    const val = getNestedValue(source, key.trim());
    return val !== undefined && val !== null ? String(val) : match;
  });
}

function getNestedValue(obj, dottedKey) {
  return dottedKey.split('.').reduce(
    (acc, k) => (acc != null && acc[k] !== undefined ? acc[k] : undefined),
    obj,
  );
}

const isEmptyObj = (x) => x && typeof x === 'object' && !Array.isArray(x) && Object.keys(x).length === 0;

/**
 * Deterministically fill a template (object/array/string) from the call's flat
 * `data`, so the agent only supplies scalar VALUES and the structure (e.g. a
 * FHIR resource) is fixed in config — not generated by the model.
 *
 * - A whole-string placeholder `"{slotId}"` → the raw value (keeps numbers/objects).
 * - An embedded placeholder `"Slot/{slotId}"` → string-substituted (unknown keys
 *   and `{{ENV}}` are left for substituteEnvVars).
 * - Objects/arrays fill recursively; keys/items resolving to undefined or empty
 *   are pruned (optional fields drop out cleanly).
 */
function fillTemplate(tpl, data) {
  if (typeof tpl === 'string') {
    const whole = /^\{([^{}]+)\}$/.exec(tpl);
    if (whole) return getNestedValue(data, whole[1].trim()); // raw value (may be undefined)
    return tpl.replace(/\{([^{}]+)\}/g, (m, key) => {
      const v = getNestedValue(data, key.trim());
      return v !== undefined && v !== null ? String(v) : m; // leave {{ENV}} / unknown
    });
  }
  if (Array.isArray(tpl)) {
    const arr = tpl.map((x) => fillTemplate(x, data)).filter((x) => x !== undefined && !isEmptyObj(x));
    return arr.length ? arr : undefined;
  }
  if (tpl && typeof tpl === 'object') {
    const out = {};
    for (const [k, v] of Object.entries(tpl)) {
      const filled = fillTemplate(v, data);
      if (filled !== undefined && !isEmptyObj(filled)) out[k] = filled;
    }
    return Object.keys(out).length ? out : undefined;
  }
  return tpl; // number / boolean / null
}

function joinUrl(base, rel) {
  if (!rel) return base;
  if (/^https?:\/\//i.test(rel)) return rel; // absolute override
  const left = base.replace(/\/+$/, '');
  const right = rel.replace(/^\/+/, '');
  return `${left}/${right}`;
}

function methodHasBody(method) {
  return method === 'POST' || method === 'PUT' || method === 'PATCH';
}

// ─── HTTP ──────────────────────────────────────────────────────

// OAuth2 client-credentials for extensions (e.g. FHIR / hospital APIs). Tokens
// are cached per (tokenUrl, clientId, scope) and refreshed ~30s before expiry.
// Config shape on the extension:
//   "auth": { "type":"oauth2", "tokenUrl", "clientId", "clientSecret",
//             "scope"?, "clientAuth": "body"(default) | "basic" }
// Secrets may use {{ENV_VAR}} — already substituted before this runs.
const oauthTokenCache = new Map();
async function getOAuthToken(auth) {
  const cacheKey = `${auth.tokenUrl}|${auth.clientId}|${auth.scope || ''}`;
  const cached = oauthTokenCache.get(cacheKey);
  if (cached && cached.expiresAt > Date.now() + 30_000) return cached.token;
  if (!auth.tokenUrl || !auth.clientId || !auth.clientSecret) {
    throw new Error('oauth2 auth requires tokenUrl, clientId and clientSecret');
  }
  const headers = { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' };
  const params = new URLSearchParams({ grant_type: 'client_credentials' });
  if (auth.scope) params.set('scope', auth.scope);
  if ((auth.clientAuth || 'body') === 'basic') {
    headers.Authorization = `Basic ${Buffer.from(`${auth.clientId}:${auth.clientSecret}`).toString('base64')}`;
  } else {
    params.set('client_id', auth.clientId);
    params.set('client_secret', auth.clientSecret);
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);
  let res, json = {};
  try {
    res = await fetch(auth.tokenUrl, { method: 'POST', headers, body: params.toString(), signal: controller.signal });
    const text = await res.text();
    try { json = JSON.parse(text); } catch { /* non-JSON token response */ }
  } finally { clearTimeout(timeout); }
  if (!res?.ok || !json.access_token) {
    throw new Error(`oauth2 token request failed (HTTP ${res?.status}): ${json.error || 'no access_token in response'}`);
  }
  const ttlSec = Number(json.expires_in) > 0 ? Number(json.expires_in) : 3600;
  oauthTokenCache.set(cacheKey, { token: json.access_token, expiresAt: Date.now() + ttlSec * 1000 });
  return json.access_token;
}

async function sendRequest({ url, method, headers, auth, body, timeoutMs, outputType, ext, operation, paths }) {
  const finalHeaders = { ...(headers || {}) };
  let finalUrl = url;

  // Default Content-Type for JSON bodies
  if (body !== undefined && !finalHeaders['Content-Type'] && !finalHeaders['content-type']) {
    finalHeaders['Content-Type'] = 'application/json';
  }

  // Auth
  if (auth?.type === 'oauth2') {
    finalHeaders['Authorization'] = `Bearer ${await getOAuthToken(auth)}`;
  } else if (auth?.apiKey) {
    const authType = auth.type || 'bearer';
    if (authType === 'header') {
      finalHeaders[auth.header || 'X-API-Key'] = auth.apiKey;
    } else if (authType === 'query') {
      const paramName = auth.header || 'key';
      const sep = finalUrl.includes('?') ? '&' : '?';
      finalUrl = `${finalUrl}${sep}${paramName}=${encodeURIComponent(auth.apiKey)}`;
    } else if (authType === 'basic') {
      finalHeaders['Authorization'] = `Basic ${Buffer.from(auth.apiKey).toString('base64')}`;
    } else {
      finalHeaders['Authorization'] = `Bearer ${auth.apiKey}`;
    }
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs ?? 30_000);
  const startedAt = Date.now();

  let res, parsed, rawBody, contentType;
  try {
    const init = { method, headers: finalHeaders, signal: controller.signal };
    if (body !== undefined) init.body = typeof body === 'string' ? body : JSON.stringify(body);
    res = await fetch(finalUrl, init);
    contentType = res.headers.get('content-type') || '';

    if (outputType === 'binary') {
      rawBody = Buffer.from(await res.arrayBuffer());
      parsed = `[binary ${rawBody.length} bytes]`;
    } else if (contentType.includes('json') || outputType === 'json') {
      const text = await res.text();
      try { parsed = JSON.parse(text); } catch { parsed = text; }
    } else {
      parsed = await res.text();
    }
  } finally {
    clearTimeout(timeout);
  }

  logCall({
    paths,
    extName: ext?.name,
    operationName: operation?.name,
    method,
    url: finalUrl,
    status: res?.status,
    durationMs: Date.now() - startedAt,
    error: null,
  });

  return {
    ok: res.ok,
    status: res.status,
    data: parsed,
    rawBody,
    contentType,
  };
}

// ─── Async polling ─────────────────────────────────────────────

async function pollOperation({ ext, op, initialResponse, endpoint, headers, auth, paths }) {
  const cfg = op.async || {};
  const interval = (cfg.interval_s ?? 3) * 1000;
  const maxWait = Math.min((cfg.max_wait_s ?? 120) * 1000, 300_000); // hard ceiling 5 min
  const readyValues = (cfg.ready_values || ['completed', 'success', 'succeeded', 'done']).map(s => String(s).toLowerCase());
  const failureValues = (cfg.failure_values || ['failed', 'error', 'cancelled']).map(s => String(s).toLowerCase());
  const readyField = cfg.ready_field || 'status';
  const pollPathTemplate = cfg.poll_path;
  if (!pollPathTemplate) {
    return { ok: false, error: `Operation "${op.name}" has async config but no poll_path.` };
  }

  // Initial sleep so we don't hammer the API immediately
  await sleep(Math.min(interval, 5000));

  const startedAt = Date.now();
  let lastResponse = initialResponse;

  while (Date.now() - startedAt < maxWait) {
    const filledPath = fillPathPlaceholders(pollPathTemplate, lastResponse);
    const pollUrl = joinUrl(endpoint, filledPath);
    let pollRes;
    try {
      pollRes = await sendRequest({
        url: pollUrl,
        method: 'GET',
        headers,
        auth,
        body: undefined,
        timeoutMs: 15_000,
        outputType: 'json',
        ext,
        operation: op,
        paths,
      });
    } catch (err) {
      // Single transient hiccup — wait and try again
      await sleep(interval);
      continue;
    }

    if (!pollRes.ok) {
      return { ok: false, error: `Polling returned HTTP ${pollRes.status}.`, last: pollRes.data };
    }
    lastResponse = pollRes.data;

    const status = String(getNestedValue(pollRes.data, readyField) ?? '').toLowerCase();
    if (readyValues.includes(status)) {
      const data = cfg.result_field
        ? { [cfg.result_field.split('.').pop()]: getNestedValue(pollRes.data, cfg.result_field), full: pollRes.data }
        : pollRes.data;
      return { ok: true, status: pollRes.status, data, rawBody: pollRes.rawBody, contentType: pollRes.contentType };
    }
    if (failureValues.includes(status)) {
      return { ok: false, error: `Operation reached failure state: ${status}.`, last: pollRes.data };
    }

    await sleep(interval);
  }

  return {
    ok: false,
    error: `Polling timed out after ${Math.round((Date.now() - startedAt) / 1000)}s. Last response retained.`,
    last: lastResponse,
    pending: true,
  };
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ─── Binary download ───────────────────────────────────────────

async function saveBinary(buffer, contentType, ext, op, paths) {
  if (!buffer) throw new Error('no body');
  const dir = path.join(paths.data, 'extensions', sanitize(ext.name));
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const opName = op?.name ? sanitize(op.name) : 'response';
  const extGuess = guessExtension(contentType);
  const filename = `${stamp}_${opName}${extGuess}`;
  const fullPath = path.join(dir, filename);
  fs.writeFileSync(fullPath, buffer);

  const rel = path.relative(paths.root, fullPath).split(path.sep).join('/');
  return {
    file_path: rel,
    mime: contentType || 'application/octet-stream',
    size: buffer.length,
  };
}

function sanitize(s) {
  return String(s || 'file').replace(/[^a-zA-Z0-9._-]/g, '_').slice(0, 64);
}

function guessExtension(contentType) {
  if (!contentType) return '';
  const ct = contentType.split(';')[0].trim().toLowerCase();
  const map = {
    'audio/mpeg': '.mp3', 'audio/wav': '.wav', 'audio/x-wav': '.wav', 'audio/ogg': '.ogg',
    'audio/mp4': '.m4a', 'audio/aac': '.aac', 'audio/webm': '.webm', 'audio/flac': '.flac',
    'image/png': '.png', 'image/jpeg': '.jpg', 'image/webp': '.webp', 'image/gif': '.gif',
    'video/mp4': '.mp4', 'video/webm': '.webm', 'video/quicktime': '.mov',
    'application/pdf': '.pdf', 'application/zip': '.zip', 'application/json': '.json',
    'text/plain': '.txt', 'text/csv': '.csv',
  };
  return map[ct] || '';
}

// ─── Logging ───────────────────────────────────────────────────

function logCall({ paths, extName, operationName, method, url, status, durationMs, error }) {
  try {
    const date = new Date().toISOString().slice(0, 10);
    const dir = path.join(paths.root, '.aaas', 'logs', 'extensions');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${date}.log`);
    const line = JSON.stringify({
      ts: new Date().toISOString(),
      ext: extName,
      op: operationName || null,
      method,
      url,
      status: status ?? null,
      ms: durationMs ?? null,
      error: error || null,
    }) + '\n';
    fs.appendFileSync(file, line);
  } catch {
    // Logging is best-effort; never fail the call because of it.
  }
}

// ─── Agent-to-agent ────────────────────────────────────────────

async function callAgentExtension(ext, data, fallbackMessage) {
  const agentUrl = ext.address || ext.endpoint;
  if (!agentUrl) {
    return JSON.stringify({ error: `Extension "${ext.name}" has no address configured.` });
  }
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (ext.auth?.apiKey) {
      const key = substituteEnvVars(ext.auth.apiKey);
      headers['Authorization'] = `Bearer ${key}`;
    }
    const message = data?.message || fallbackMessage || '';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 30_000);
    const res = await fetch(substituteEnvVars(agentUrl), {
      method: 'POST',
      headers,
      body: JSON.stringify({ message }),
      signal: controller.signal,
    });
    clearTimeout(timeout);
    const body = await res.json().catch(() => res.text());
    return JSON.stringify({ status: res.status, ok: res.ok, reply: body });
  } catch (err) {
    if (err.name === 'AbortError') {
      return JSON.stringify({ error: `Agent "${ext.name}" timed out (30s).` });
    }
    return JSON.stringify({ error: `Agent "${ext.name}" call failed: ${err.message}` });
  }
}
