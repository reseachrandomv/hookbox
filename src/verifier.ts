/**
 * Webhook signature verification for Stripe and GitHub.
 *
 * Stripe:  Stripe-Signature: t=<unix>,v1=<hex hmac-sha256 of "<t>.<raw body>">
 * GitHub:  X-Hub-Signature-256: sha256=<hex hmac-sha256 of raw body>
 *          (legacy X-Hub-Signature: sha1=<hex hmac-sha1> is also accepted)
 */
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { VerificationResult } from './types.js';

export interface VerifierSecrets {
  stripe?: string;
  github?: string;
  /** Stripe timestamp tolerance in seconds (default 300, like Stripe's SDKs). */
  stripeToleranceSec?: number;
}

type Headers = Record<string, string | string[] | undefined>;

function header(headers: Headers, name: string): string | undefined {
  const v = headers[name.toLowerCase()];
  return Array.isArray(v) ? v[0] : v;
}

function safeEqualHex(a: string, b: string): boolean {
  if (!/^[0-9a-f]+$/i.test(a) || !/^[0-9a-f]+$/i.test(b)) return false;
  const ba = Buffer.from(a.toLowerCase(), 'hex');
  const bb = Buffer.from(b.toLowerCase(), 'hex');
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

export function signStripe(rawBody: Buffer | string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const payload = `${timestamp}.${Buffer.isBuffer(rawBody) ? rawBody.toString('utf8') : rawBody}`;
  const sig = createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
  return `t=${timestamp},v1=${sig}`;
}

export function signGitHub(rawBody: Buffer | string, secret: string): string {
  return 'sha256=' + createHmac('sha256', secret).update(rawBody).digest('hex');
}

export function verifyStripe(
  rawBody: Buffer,
  headerValue: string,
  secret: string | undefined,
  toleranceSec = 300,
  nowSec = Math.floor(Date.now() / 1000),
): VerificationResult {
  const base = { provider: 'stripe' as const, header: 'stripe-signature' };
  if (!secret) {
    return { ...base, valid: false, reason: 'No Stripe secret configured (use --stripe-secret or HOOKBOX_STRIPE_SECRET).' };
  }
  const parts = headerValue.split(',').map((p) => p.trim());
  let timestamp: number | null = null;
  const v1: string[] = [];
  for (const part of parts) {
    const idx = part.indexOf('=');
    if (idx === -1) continue;
    const key = part.slice(0, idx);
    const value = part.slice(idx + 1);
    if (key === 't') timestamp = Number(value);
    else if (key === 'v1') v1.push(value);
  }
  if (timestamp === null || !Number.isFinite(timestamp)) {
    return { ...base, valid: false, reason: 'Malformed Stripe-Signature header: missing or invalid timestamp (t=).' };
  }
  if (v1.length === 0) {
    return { ...base, valid: false, reason: 'Malformed Stripe-Signature header: no v1 signature found.' };
  }
  const expected = createHmac('sha256', secret).update(`${timestamp}.`, 'utf8').update(rawBody).digest('hex');
  const matched = v1.some((sig) => safeEqualHex(sig, expected));
  if (!matched) {
    return {
      ...base,
      valid: false,
      reason: 'Signature mismatch: the body was modified, or the signing secret is wrong (check whsec_... for this endpoint).',
    };
  }
  const age = nowSec - timestamp;
  if (toleranceSec > 0 && Math.abs(age) > toleranceSec) {
    return {
      ...base,
      valid: false,
      reason: `Signature matched but the timestamp is outside the ${toleranceSec}s tolerance (${age}s old). Possible replay attack or clock skew.`,
    };
  }
  return { ...base, valid: true, reason: `Valid Stripe signature (timestamp ${age}s old).` };
}

export function verifyGitHub(
  rawBody: Buffer,
  headerName: 'x-hub-signature-256' | 'x-hub-signature',
  headerValue: string,
  secret: string | undefined,
): VerificationResult {
  const base = { provider: 'github' as const, header: headerName };
  if (!secret) {
    return { ...base, valid: false, reason: 'No GitHub secret configured (use --github-secret or HOOKBOX_GITHUB_SECRET).' };
  }
  const algo = headerName === 'x-hub-signature-256' ? 'sha256' : 'sha1';
  const prefix = `${algo}=`;
  if (!headerValue.startsWith(prefix)) {
    return { ...base, valid: false, reason: `Malformed ${headerName} header: expected it to start with "${prefix}".` };
  }
  const given = headerValue.slice(prefix.length);
  const expected = createHmac(algo, secret).update(rawBody).digest('hex');
  if (!safeEqualHex(given, expected)) {
    return {
      ...base,
      valid: false,
      reason: 'Signature mismatch: the body was modified, or the webhook secret does not match the one set in GitHub.',
    };
  }
  return {
    ...base,
    valid: true,
    reason: algo === 'sha256' ? 'Valid GitHub signature (HMAC-SHA256).' : 'Valid GitHub signature (legacy HMAC-SHA1; prefer X-Hub-Signature-256).',
  };
}

/** Detects the provider from headers and verifies. Returns null when no known signature header is present. */
export function verifyRequest(rawBody: Buffer, headers: Headers, secrets: VerifierSecrets): VerificationResult | null {
  const stripeSig = header(headers, 'stripe-signature');
  if (stripeSig !== undefined) {
    return verifyStripe(rawBody, stripeSig, secrets.stripe, secrets.stripeToleranceSec ?? 300);
  }
  const gh256 = header(headers, 'x-hub-signature-256');
  if (gh256 !== undefined) return verifyGitHub(rawBody, 'x-hub-signature-256', gh256, secrets.github);
  const gh1 = header(headers, 'x-hub-signature');
  if (gh1 !== undefined) return verifyGitHub(rawBody, 'x-hub-signature', gh1, secrets.github);
  return null;
}
