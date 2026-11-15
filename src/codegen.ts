/** Generates copy-pasteable code snippets (cURL, fetch, Python, HTTPie) for a captured request. */
import type { CapturedRequest } from './types.js';

export type CodeLang = 'curl' | 'fetch' | 'python' | 'httpie';
export const CODE_LANGS: CodeLang[] = ['curl', 'fetch', 'python', 'httpie'];

const OMIT = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'expect']);

function headerPairs(req: CapturedRequest): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (OMIT.has(name.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.push([name, v]);
  }
  return out;
}

/** POSIX shell single-quote escaping. */
export function shellQuote(s: string): string {
  if (s === '') return "''";
  if (/^[A-Za-z0-9_\-.,:/@%+=]+$/.test(s)) return s;
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Resolves the URL a snippet should call. `base` is either an origin
 * (e.g. http://localhost:4040), in which case the captured path and query are
 * appended, or a full target URL (e.g. http://localhost:3000/api/webhooks),
 * which is used as-is.
 */
export function targetUrl(req: CapturedRequest, base: string): string {
  const u = new URL(base);
  if (u.pathname === '/' && !u.search) return new URL(req.url, u.origin).toString();
  return u.toString();
}

export function toCurl(req: CapturedRequest, baseUrl: string): string {
  const lines: string[] = [];
  const method = req.method.toUpperCase();
  lines.push(`curl -X ${method} ${shellQuote(targetUrl(req, baseUrl))}`);
  for (const [k, v] of headerPairs(req)) lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  if (req.size > 0 && method !== 'GET' && method !== 'HEAD') {
    if (req.bodyEncoding === 'base64') {
      // Binary bodies are piped from base64 so the command stays copy-pasteable.
      return `printf %s ${shellQuote(req.body)} | base64 --decode | \\\n` + lines.join(' \\\n') + ' \\\n  --data-binary @-';
    }
    lines.push(`  --data-binary ${shellQuote(req.body)}`);
  }
  return lines.join(' \\\n');
}

export function toFetch(req: CapturedRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const headers = Object.fromEntries(headerPairs(req));
  const parts = [`  method: ${JSON.stringify(method)}`, `  headers: ${JSON.stringify(headers, null, 2).replace(/\n/g, '\n  ')}`];
  let pre = '';
  if (req.size > 0 && method !== 'GET' && method !== 'HEAD') {
    if (req.bodyEncoding === 'base64') {
      pre = `const body = Buffer.from(${JSON.stringify(req.body)}, 'base64');\n`;
      parts.push('  body');
    } else {
      parts.push(`  body: ${JSON.stringify(req.body)}`);
    }
  }
  return `${pre}const res = await fetch(${JSON.stringify(targetUrl(req, baseUrl))}, {\n${parts.join(',\n')}\n});\nconsole.log(res.status, await res.text());`;
}

function pyStr(s: string): string {
  return JSON.stringify(s); // JSON string literals are valid Python string literals.
}

export function toPython(req: CapturedRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const headers = headerPairs(req)
    .map(([k, v]) => `    ${pyStr(k)}: ${pyStr(v)},`)
    .join('\n');
  const lines = ['import requests'];
  let bodyArg = '';
  if (req.size > 0 && method !== 'GET' && method !== 'HEAD') {
    if (req.bodyEncoding === 'base64') {
      lines.push('import base64');
      lines.push('', `data = base64.b64decode(${pyStr(req.body)})`);
    } else {
      lines.push('', `data = ${pyStr(req.body)}.encode("utf-8")`);
    }
    bodyArg = ',\n    data=data';
  }
  lines.push('', `headers = {\n${headers}\n}`);
  lines.push(
    '',
    `res = requests.request(\n    ${pyStr(method)},\n    ${pyStr(targetUrl(req, baseUrl))},\n    headers=headers${bodyArg},\n)`,
    'print(res.status_code, res.text)',
  );
  return lines.join('\n');
}

export function toHttpie(req: CapturedRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const head = headerPairs(req).map(([k, v]) => shellQuote(`${k}:${v}`));
  const cmd = ['http', '--ignore-stdin', method, shellQuote(targetUrl(req, baseUrl)), ...head];
  if (req.size > 0 && method !== 'GET' && method !== 'HEAD') {
    if (req.bodyEncoding === 'base64') {
      return `printf %s ${shellQuote(req.body)} | base64 --decode | ` + cmd.filter((c) => c !== '--ignore-stdin').join(' ');
    }
    return `printf %s ${shellQuote(req.body)} | ` + cmd.filter((c) => c !== '--ignore-stdin').join(' ');
  }
  return cmd.join(' ');
}

export function generateCode(req: CapturedRequest, lang: CodeLang, baseUrl: string): string {
  switch (lang) {
    case 'curl':
      return toCurl(req, baseUrl);
    case 'fetch':
      return toFetch(req, baseUrl);
    case 'python':
      return toPython(req, baseUrl);
    case 'httpie':
      return toHttpie(req, baseUrl);
  }
}
