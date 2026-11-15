/** Shared types for HookBox. */

export type BodyEncoding = 'utf8' | 'base64';

export interface VerificationResult {
  /** Which provider signature scheme was detected. */
  provider: 'stripe' | 'github';
  /** True when the signature matched the configured secret. */
  valid: boolean;
  /** Human readable explanation, always set (success or failure reason). */
  reason: string;
  /** Header that carried the signature. */
  header: string;
}

export interface ForwardResult {
  target: string;
  /** 'replay' = manual replay from the API/UI, 'forward' = automatic --target proxy. */
  kind: 'replay' | 'forward';
  ok: boolean;
  status: number | null;
  statusText: string;
  headers: Record<string, string>;
  body: string;
  bodyEncoding: BodyEncoding;
  size: number;
  durationMs: number;
  error: string | null;
  at: string;
}

export interface CapturedRequest {
  id: string;
  /** Monotonic sequence number (useful for ordering and the UI). */
  seq: number;
  method: string;
  /** Full URL path including query string, e.g. /wh/stripe?x=1 */
  url: string;
  /** Path without the query string, e.g. /wh/stripe */
  path: string;
  headers: Record<string, string | string[]>;
  query: Record<string, string | string[]>;
  contentType: string | null;
  /** Raw body. utf8 text when it decodes cleanly, otherwise base64. */
  body: string;
  bodyEncoding: BodyEncoding;
  /** Parsed JSON body when the body is valid JSON, otherwise null. */
  json: unknown | null;
  /** Parsed application/x-www-form-urlencoded body, otherwise null. */
  form: Record<string, string | string[]> | null;
  ip: string;
  timestamp: string;
  /** Body size in bytes. */
  size: number;
  verification: VerificationResult | null;
  lastReplay: ForwardResult | null;
  lastForward: ForwardResult | null;
}

export type HookBoxEvent =
  | { type: 'request.created'; request: CapturedRequest }
  | { type: 'request.updated'; request: CapturedRequest }
  | { type: 'request.removed'; ids: string[] }
  | { type: 'requests.cleared' };
