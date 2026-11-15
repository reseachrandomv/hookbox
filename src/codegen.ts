/**
 * Generates copy-pasteable code for a captured request:
 *   curl, fetch (JavaScript), typescript (typed fetch), python (requests),
 *   httpie, and ready-to-run Vitest / Jest test fixtures.
 */
import type { CapturedRequest } from './types.js';

export type CodeLang = 'curl' | 'fetch' | 'typescript' | 'python' | 'httpie' | 'vitest' | 'jest';
export const CODE_LANGS: CodeLang[] = ['curl', 'fetch', 'typescript', 'python', 'httpie', 'vitest', 'jest'];

export const CODE_LANG_LABELS: Record<CodeLang, string> = {
  curl: 'cURL',
  fetch: 'fetch (JS)',
  typescript: 'fetch (TS)',
  python: 'Python',
  httpie: 'HTTPie',
  vitest: 'Vitest fixture',
  jest: 'Jest fixture',
};

const OMIT = new Set(['host', 'content-length', 'connection', 'accept-encoding', 'transfer-encoding', 'keep-alive', 'expect']);

function headerPairs(req: CapturedRequest): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const [name, value] of Object.entries(req.headers)) {
    if (OMIT.has(name.toLowerCase())) continue;
    for (const v of Array.isArray(value) ? value : [value]) out.push([name, v]);
  }
  return out;
}

function hasBody(req: CapturedRequest): boolean {
  const m = req.method.toUpperCase();
  return req.size > 0 && m !== 'GET' && m !== 'HEAD';
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

const js = (v: unknown) => JSON.stringify(v);

/** Indents every line after the first by `pad`. */
function indentRest(text: string, pad: string): string {
  return text.replace(/\n/g, `\n${pad}`);
}

/* ---------------- shell ---------------- */

export function toCurl(req: CapturedRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const lines: string[] = [method === 'HEAD' ? `curl -I ${shellQuote(targetUrl(req, baseUrl))}` : `curl -X ${method} ${shellQuote(targetUrl(req, baseUrl))}`];
  for (const [k, v] of headerPairs(req)) lines.push(`  -H ${shellQuote(`${k}: ${v}`)}`);
  if (hasBody(req)) {
    if (req.bodyEncoding === 'base64') {
      // Binary bodies are piped from base64 so the command stays copy-pasteable.
      return `printf %s ${shellQuote(req.body)} | base64 --decode | \\\n` + lines.join(' \\\n') + ' \\\n  --data-binary @-';
    }
    lines.push(`  --data-binary ${shellQuote(req.body)}`);
  }
  return lines.join(' \\\n');
}

export function toHttpie(req: CapturedRequest, baseUrl: string): string {
  const method = req.method.toUpperCase();
  const head = headerPairs(req).map(([k, v]) => shellQuote(`${k}:${v}`));
  if (hasBody(req)) {
    const pipe = req.bodyEncoding === 'base64' ? `printf %s ${shellQuote(req.body)} | base64 --decode | ` : `printf %s ${shellQuote(req.body)} | `;
    return pipe + ['http', method, shellQuote(targetUrl(req, baseUrl)), ...head].join(' ');
  }
  return ['http', '--ignore-stdin', method, shellQuote(targetUrl(req, baseUrl)), ...head].join(' ');
}

/* ---------------- JavaScript / TypeScript ---------------- */

function bodyExpr(req: CapturedRequest): string | null {
  if (!hasBody(req)) return null;
  if (req.bodyEncoding === 'base64') return `Buffer.from(${js(req.body)}, 'base64')`;
  if (req.json !== null) return `JSON.stringify(${indentRest(JSON.stringify(req.json, null, 2), '  ')})`;
  return js(req.body);
}

export function toFetch(req: CapturedRequest, baseUrl: string): string {
  const headers = Object.fromEntries(headerPairs(req));
  const body = bodyExpr(req);
  const parts = [`  method: ${js(req.method.toUpperCase())}`, `  headers: ${indentRest(JSON.stringify(headers, null, 2), '  ')}`];
  if (body) parts.push(`  body: ${body}`);
  return [
    `const res = await fetch(${js(targetUrl(req, baseUrl))}, {`,
    parts.join(',\n'),
    '});',
    '',
    'console.log(res.status, await res.text());',
  ].join('\n');
}

export function toTypeScript(req: CapturedRequest, baseUrl: string): string {
  const headers = Object.fromEntries(headerPairs(req));
  const body = bodyExpr(req);
  const lines = [
    `const url = new URL(${js(targetUrl(req, baseUrl))});`,
    '',
    `const headers: Record<string, string> = ${JSON.stringify(headers, null, 2)};`,
    '',
    `const init: RequestInit = {`,
    `  method: ${js(req.method.toUpperCase())},`,
    '  headers,',
  ];
  if (body) lines.push(`  body: ${body},`);
  lines.push(
    '};',
    '',
    'const res: Response = await fetch(url, init);',
    'const text: string = await res.text();',
    'console.log(res.status, text);',
  );
  return lines.join('\n');
}

/** Shared body of the Vitest/Jest fixtures. */
function testFixture(req: CapturedRequest, baseUrl: string, framework: 'vitest' | 'jest'): string {
  const name = `${req.method.toUpperCase()} ${req.path}`;
  const fixture = {
    method: req.method.toUpperCase(),
    path: req.url,
    headers: Object.fromEntries(headerPairs(req)),
    bodyEncoding: req.bodyEncoding,
    body: hasBody(req) ? req.body : '',
  };
  const url = targetUrl(req, baseUrl);
  const ts = framework === 'vitest';
  const header = ts
    ? ['// webhook.test.ts (Vitest)', "import { describe, it, expect } from 'vitest';"]
    : ['// webhook.test.js (Jest: describe/it/expect are globals; needs Node 18+ for fetch)'];
  return [
    ...header,
    '',
    `// Captured by HookBox on ${req.timestamp} (request ${req.id}).`,
    `${ts ? 'export ' : ''}const webhookFixture = ${JSON.stringify(fixture, null, 2)}${ts ? ' as const' : ''};`,
    '',
    '/** Raw body exactly as received, so signature checks see identical bytes. */',
    `${ts ? 'export ' : ''}function fixtureBody()${ts ? ': Buffer | undefined' : ''} {`,
    "  if (!webhookFixture.body) return undefined;",
    "  return Buffer.from(webhookFixture.body, webhookFixture.bodyEncoding === 'base64' ? 'base64' : 'utf8');",
    '}',
    '',
    `const TARGET = process.env.WEBHOOK_URL ?? ${js(url)};`,
    '',
    `describe(${js(`webhook: ${name}`)}, () => {`,
    "  it('is accepted by the handler', async () => {",
    '    const res = await fetch(TARGET, {',
    '      method: webhookFixture.method,',
    '      headers: webhookFixture.headers,',
    '      body: fixtureBody(),',
    '    });',
    '    expect(res.status).toBeLessThan(400);',
    '  });',
    '',
    "  it('matches the captured payload shape', () => {",
    `    expect(webhookFixture.method).toBe(${js(fixture.method)});`,
    req.json !== null && typeof req.json === 'object'
      ? `    expect(JSON.parse(webhookFixture.body)).toMatchObject(${indentRest(JSON.stringify(req.json, null, 2), '    ')});`
      : `    expect(webhookFixture.body.length).toBe(${fixture.body.length});`,
    '  });',
    '});',
  ].join('\n');
}

export function toVitest(req: CapturedRequest, baseUrl: string): string {
  return testFixture(req, baseUrl, 'vitest');
}

export function toJest(req: CapturedRequest, baseUrl: string): string {
  return testFixture(req, baseUrl, 'jest');
}

/* ---------------- Python ---------------- */

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
  if (hasBody(req)) {
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

export function generateCode(req: CapturedRequest, lang: CodeLang, baseUrl: string): string {
  switch (lang) {
    case 'curl':
      return toCurl(req, baseUrl);
    case 'fetch':
      return toFetch(req, baseUrl);
    case 'typescript':
      return toTypeScript(req, baseUrl);
    case 'python':
      return toPython(req, baseUrl);
    case 'httpie':
      return toHttpie(req, baseUrl);
    case 'vitest':
      return toVitest(req, baseUrl);
    case 'jest':
      return toJest(req, baseUrl);
  }
}
