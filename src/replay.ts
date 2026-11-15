/**
 * Replay engine and auto-forward proxy.
 * Sends a captured request (method, filtered headers, raw body) to a target URL
 * with fetch and records status, headers, body and latency in milliseconds.
 */
import { decodeBody, encodeBody } from './body.js';
import type { CapturedRequest, ForwardResult } from './types.js';

/** Headers that must not be copied to the target (hop-by-hop or recomputed by fetch). */
const SKIP_HEADERS = new Set([
  'host',
  'connection',
  'keep-alive',
  'proxy-connection',
  'proxy-authenticate',
  'proxy-authorization',
  'te',
  'trailer',
  'transfer-encoding',
  'upgrade',
  'content-length',
  'expect',
  'accept-encoding',
  'http2-settings',
]);

export const DEFAULT_TIMEOUT_MS = 30_000;

export function validateTarget(target: unknown): URL {
  if (typeof target !== 'string' || !target.trim()) {
    throw new Error('A target URL is required, e.g. {"target":"http://localhost:3000/api/webhooks"}');
  }
  let url: URL;
  try {
    url = new URL(target.trim());
  } catch {
    throw new Error(`Invalid target URL: ${target}`);
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error(`Target must use http or https, got ${url.protocol}`);
  }
  return url;
}

export function buildForwardHeaders(req: CapturedRequest, kind: ForwardResult['kind']): Headers {
  const headers = new Headers();
  for (const [name, value] of Object.entries(req.headers)) {
    const lower = name.toLowerCase();
    if (SKIP_HEADERS.has(lower) || lower.startsWith(':')) continue;
    const values = Array.isArray(value) ? value : [value];
    for (const v of values) {
      try {
        headers.append(lower, v);
      } catch {
        /* skip headers that fetch rejects */
      }
    }
  }
  headers.set('x-hookbox-request-id', req.id);
  headers.set('x-hookbox-mode', kind);
  return headers;
}

/**
 * Forwards a captured request to `target`. Never throws; network errors are
 * reported in the result's `error` field with ok=false.
 */
export async function forwardRequest(
  req: CapturedRequest,
  target: string,
  kind: ForwardResult['kind'],
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<ForwardResult> {
  const started = performance.now();
  const at = new Date().toISOString();
  const base: ForwardResult = {
    target,
    kind,
    ok: false,
    status: null,
    statusText: '',
    headers: {},
    body: '',
    bodyEncoding: 'utf8',
    size: 0,
    durationMs: 0,
    error: null,
    at,
  };
  let url: URL;
  try {
    url = validateTarget(target);
  } catch (err) {
    return { ...base, error: (err as Error).message };
  }
  const method = req.method.toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD' && req.size > 0;
  try {
    const res = await fetch(url, {
      method,
      headers: buildForwardHeaders(req, kind),
      body: hasBody ? decodeBody(req.body, req.bodyEncoding) : undefined,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const headers: Record<string, string> = {};
    res.headers.forEach((v, k) => {
      headers[k] = v;
    });
    const { body, bodyEncoding } = encodeBody(buf, res.headers.get('content-type'));
    return {
      ...base,
      ok: res.ok,
      status: res.status,
      statusText: res.statusText,
      headers,
      body,
      bodyEncoding,
      size: buf.length,
      durationMs,
    };
  } catch (err) {
    const durationMs = Math.round((performance.now() - started) * 100) / 100;
    const e = err as Error & { cause?: { code?: string; message?: string } };
    let message = e.message;
    if (e.name === 'TimeoutError') message = `Timed out after ${timeoutMs}ms`;
    else if (e.cause?.code) message = `${e.cause.code}: ${e.cause.message ?? e.message}`;
    else if (e.cause?.message) message = `${e.message}: ${e.cause.message}`;
    return { ...base, durationMs, error: message };
  }
}
