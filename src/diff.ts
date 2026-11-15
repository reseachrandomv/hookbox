/** Structural diff between two captured requests (method, path, query, headers, body/JSON). */
import type { CapturedRequest } from './types.js';

export type DiffKind = 'added' | 'removed' | 'changed';

export interface DiffEntry {
  /** JSON-pointer-like path, e.g. headers.content-type or json.data.object.amount */
  path: string;
  kind: DiffKind;
  before?: unknown;
  after?: unknown;
}

export interface RequestDiff {
  a: string;
  b: string;
  identical: boolean;
  changes: DiffEntry[];
  summary: { added: number; removed: number; changed: number };
}

/** Headers that differ on every request and add noise. */
const VOLATILE_HEADERS = new Set(['date', 'content-length', 'x-request-id', 'x-hookbox-request-id', 'cf-ray', 'x-amzn-trace-id']);

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function deepDiff(before: unknown, after: unknown, path: string, out: DiffEntry[]): void {
  if (Object.is(before, after)) return;
  if (Array.isArray(before) && Array.isArray(after)) {
    const len = Math.max(before.length, after.length);
    for (let i = 0; i < len; i++) {
      const p = `${path}[${i}]`;
      if (i >= before.length) out.push({ path: p, kind: 'added', after: after[i] });
      else if (i >= after.length) out.push({ path: p, kind: 'removed', before: before[i] });
      else deepDiff(before[i], after[i], p, out);
    }
    return;
  }
  if (isObject(before) && isObject(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const key of [...keys].sort()) {
      const p = path ? `${path}.${key}` : key;
      if (!(key in before)) out.push({ path: p, kind: 'added', after: after[key] });
      else if (!(key in after)) out.push({ path: p, kind: 'removed', before: before[key] });
      else deepDiff(before[key], after[key], p, out);
    }
    return;
  }
  out.push({ path, kind: 'changed', before, after });
}

function normalizeHeaders(h: CapturedRequest['headers'], ignoreVolatile: boolean): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(h)) {
    const key = k.toLowerCase();
    if (ignoreVolatile && VOLATILE_HEADERS.has(key)) continue;
    out[key] = v;
  }
  return out;
}

export function diffRequests(a: CapturedRequest, b: CapturedRequest, opts: { ignoreVolatile?: boolean } = {}): RequestDiff {
  const ignoreVolatile = opts.ignoreVolatile ?? true;
  const changes: DiffEntry[] = [];
  deepDiff(a.method, b.method, 'method', changes);
  deepDiff(a.path, b.path, 'path', changes);
  deepDiff(a.query, b.query, 'query', changes);
  deepDiff(normalizeHeaders(a.headers, ignoreVolatile), normalizeHeaders(b.headers, ignoreVolatile), 'headers', changes);
  if (a.json !== null && b.json !== null) {
    deepDiff(a.json, b.json, 'json', changes);
  } else if (a.body !== b.body || a.bodyEncoding !== b.bodyEncoding) {
    changes.push({ path: 'body', kind: 'changed', before: a.body, after: b.body });
  }
  const summary = { added: 0, removed: 0, changed: 0 };
  for (const c of changes) summary[c.kind] += 1;
  return { a: a.id, b: b.id, identical: changes.length === 0, changes, summary };
}
