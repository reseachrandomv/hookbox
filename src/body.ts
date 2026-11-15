/** Helpers for turning raw request/response bytes into storable text and back. */
import type { BodyEncoding } from './types.js';

const decoder = new TextDecoder('utf-8', { fatal: true });

const TEXTUAL_TYPE =
  /^(text\/|application\/(json|.*\+json|xml|.*\+xml|x-www-form-urlencoded|javascript|graphql|x-ndjson|yaml|x-yaml))/i;

/** Encodes bytes as utf8 text when they are valid UTF-8 (and not obviously binary), otherwise base64. */
export function encodeBody(buf: Buffer, contentType?: string | null): { body: string; bodyEncoding: BodyEncoding } {
  if (buf.length === 0) return { body: '', bodyEncoding: 'utf8' };
  const declaredTextual = contentType ? TEXTUAL_TYPE.test(contentType) : false;
  try {
    const text = decoder.decode(buf);
    // Reject control characters typical of binary payloads unless the type says it is text.
    // eslint-disable-next-line no-control-regex
    if (!declaredTextual && /[\u0000-\u0008\u000E-\u001F]/.test(text)) {
      return { body: buf.toString('base64'), bodyEncoding: 'base64' };
    }
    return { body: text, bodyEncoding: 'utf8' };
  } catch {
    return { body: buf.toString('base64'), bodyEncoding: 'base64' };
  }
}

export function decodeBody(body: string, encoding: BodyEncoding): Buffer {
  return encoding === 'base64' ? Buffer.from(body, 'base64') : Buffer.from(body, 'utf8');
}

export function tryParseJson(text: string): unknown | null {
  const trimmed = text.trim();
  if (!trimmed || !/^[[{"\-0-9tfn]/.test(trimmed)) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export function parseForm(text: string): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of new URLSearchParams(text)) {
    const existing = out[k];
    if (existing === undefined) out[k] = v;
    else if (Array.isArray(existing)) existing.push(v);
    else out[k] = [existing, v];
  }
  return out;
}
