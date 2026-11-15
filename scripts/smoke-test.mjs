// End-to-end smoke test: starts the built CLI and exercises capture, SSE,
// WebSocket, replay, auto-forward, cURL export, verification, max-history,
// SQLite persistence and the demo generator. Run with `npm test` after `npm run build`.
import { spawn, execFileSync } from 'node:child_process';
import { createServer } from 'node:http';
import { createHmac } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';

const CLI = new URL('../dist/cli.js', import.meta.url).pathname;
const results = [];
let failed = 0;

function check(name, cond, detail = '') {
  results.push({ name, ok: Boolean(cond), detail });
  if (!cond) failed++;
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function freePort() {
  const srv = createServer();
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  const { port } = srv.address();
  await new Promise((r) => srv.close(r));
  return port;
}

/** Tiny echo server that records every request it receives. */
async function startEcho() {
  const received = [];
  const srv = createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      received.push({ method: req.method, url: req.url, headers: req.headers, body });
      res.writeHead(201, { 'content-type': 'application/json', 'x-echo': 'yes' });
      res.end(JSON.stringify({ echoed: true, method: req.method, url: req.url, body, headers: req.headers }));
    });
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${srv.address().port}`, received, close: () => new Promise((r) => srv.close(r)) };
}

async function startCli(args) {
  const port = await freePort();
  const child = spawn(process.execPath, [CLI, '--port', String(port), '--no-banner', ...args], { stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (out += d));
  const base = `http://127.0.0.1:${port}`;
  for (let i = 0; i < 100; i++) {
    try {
      const r = await fetch(`${base}/api/health`);
      if (r.ok) return { base, port, child, output: () => out };
    } catch {
      /* not up yet */
    }
    await sleep(100);
  }
  child.kill();
  throw new Error(`CLI did not start:\n${out}`);
}

async function stopCli(cli) {
  cli.child.kill('SIGTERM');
  await new Promise((r) => cli.child.once('exit', r));
}

/** Opens the SSE stream and resolves with the first event of the given type. */
function waitForSse(base, type, timeoutMs = 5000) {
  const ac = new AbortController();
  let ready;
  const readyP = new Promise((r) => (ready = r));
  const eventP = (async () => {
    const res = await fetch(`${base}/api/events`, { signal: ac.signal });
    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const timer = setTimeout(() => ac.abort(), timeoutMs);
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done) return null;
        buf += dec.decode(value, { stream: true });
        let idx;
        while ((idx = buf.indexOf('\n\n')) !== -1) {
          const frame = buf.slice(0, idx);
          buf = buf.slice(idx + 2);
          const ev = /^event: (.+)$/m.exec(frame)?.[1];
          const data = /^data: (.+)$/m.exec(frame)?.[1];
          if (ev === 'hello') ready();
          if (ev === type) return JSON.parse(data);
        }
      }
    } catch {
      return null;
    } finally {
      clearTimeout(timer);
      ac.abort();
    }
  })();
  return { ready: readyP, event: eventP };
}

function waitForWs(base, type, timeoutMs = 5000) {
  const ws = new WebSocket(base.replace('http', 'ws') + '/api/ws');
  let ready;
  const readyP = new Promise((r) => (ready = r));
  const eventP = new Promise((resolve) => {
    const timer = setTimeout(() => {
      ws.terminate();
      resolve(null);
    }, timeoutMs);
    ws.on('message', (raw) => {
      const msg = JSON.parse(String(raw));
      if (msg.type === 'hello') ready();
      if (msg.type === type) {
        clearTimeout(timer);
        ws.close();
        resolve(msg);
      }
    });
    ws.on('error', () => resolve(null));
  });
  return { ready: readyP, event: eventP };
}

const json = (r) => r.json();

async function main() {
  const echo = await startEcho();
  const tmp = mkdtempSync(join(tmpdir(), 'hookbox-test-'));
  const STRIPE = 'whsec_test_123';
  const GITHUB = 'gh_test_secret';
  const cli = await startCli(['--max-history', '3', '--target', `${echo.url}/auto`, '--stripe-secret', STRIPE, '--github-secret', GITHUB]);
  const { base } = cli;

  try {
    // 1-3: capture + SSE + WebSocket
    const sse = waitForSse(base, 'request.created');
    const wsw = waitForWs(base, 'request.created');
    await Promise.all([sse.ready, wsw.ready]);
    const payload = { event: 'order.created', data: { id: 42, total: 19.99 } };
    const capRes = await fetch(`${base}/wh/test?source=smoke&tag=a&tag=b`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-custom': 'hello' },
      body: JSON.stringify(payload),
    });
    const cap = await capRes.json();
    check('POST JSON to /wh/test returns 200 with id', capRes.status === 200 && cap.ok && cap.id, `status ${capRes.status}`);
    const stored = await fetch(`${base}/api/requests/${cap.id}`).then(json);
    check(
      'request captured with method, path, query, headers, parsed JSON, ip, timestamp, size',
      stored.method === 'POST' &&
        stored.path === '/wh/test' &&
        stored.query.source === 'smoke' &&
        Array.isArray(stored.query.tag) &&
        stored.headers['x-custom'] === 'hello' &&
        stored.json?.data?.id === 42 &&
        stored.body === JSON.stringify(payload) &&
        stored.ip &&
        stored.timestamp &&
        stored.size === Buffer.byteLength(JSON.stringify(payload)),
      `ip=${stored.ip} size=${stored.size}`,
    );
    const sseEvent = await sse.event;
    check('SSE /api/events fires request.created', sseEvent?.request?.id === cap.id);
    const wsEvent = await wsw.event;
    check('WebSocket /api/ws fires request.created', wsEvent?.request?.id === cap.id);

    // 4: auto-forward via --target
    await sleep(400);
    const afterForward = await fetch(`${base}/api/requests/${cap.id}`).then(json);
    const fwd = echo.received.find((r) => r.headers['x-hookbox-request-id'] === cap.id && r.headers['x-hookbox-mode'] === 'forward');
    check(
      '--target auto-forwards in background and stores lastForward',
      fwd && fwd.url === '/auto?source=smoke&tag=a&tag=b' && fwd.body === JSON.stringify(payload) && afterForward.lastForward?.status === 201,
      `forward status ${afterForward.lastForward?.status}, ${afterForward.lastForward?.durationMs}ms`,
    );

    // 5: replay
    const updated = waitForSse(base, 'request.updated');
    await updated.ready;
    const replay = await fetch(`${base}/api/requests/${cap.id}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: `${echo.url}/api/webhooks/stripe` }),
    }).then(json);
    const echoed = JSON.parse(replay.body);
    check(
      'replay forwards method, filtered headers and raw body; returns status, headers, body, duration',
      replay.status === 201 &&
        replay.headers['x-echo'] === 'yes' &&
        echoed.method === 'POST' &&
        echoed.url === '/api/webhooks/stripe' &&
        echoed.body === JSON.stringify(payload) &&
        echoed.headers['x-custom'] === 'hello' &&
        echoed.headers.host !== new URL(base).host &&
        typeof replay.durationMs === 'number',
      `status ${replay.status}, ${replay.durationMs}ms`,
    );
    const afterReplay = await fetch(`${base}/api/requests/${cap.id}`).then(json);
    check('last replay response stored on request', afterReplay.lastReplay?.status === 201 && afterReplay.lastReplay.kind === 'replay');
    check('SSE fires request.updated after replay', (await updated.event)?.request?.lastReplay?.status === 201);
    const badReplay = await fetch(`${base}/api/requests/${cap.id}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'ftp://nope' }),
    });
    check('replay rejects invalid target with 400', badReplay.status === 400);
    const deadReplay = await fetch(`${base}/api/requests/${cap.id}/replay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: `http://127.0.0.1:${await freePort()}/` }),
    }).then(json);
    check('replay to an unreachable target reports the error', deadReplay.ok === false && deadReplay.error, deadReplay.error);

    // 6: cURL export (and actually run it)
    const curl = await fetch(`${base}/api/requests/${cap.id}/curl`).then((r) => r.text());
    check('GET /api/requests/:id/curl returns a curl command', curl.startsWith('curl -X POST') && curl.includes('/wh/test?source=smoke'));
    let curlRan = false;
    try {
      const out = execFileSync('sh', ['-c', curl.replace(/^curl /, 'curl -sS ')], { encoding: 'utf8' });
      const again = await fetch(`${base}/api/requests/${JSON.parse(out).id}`).then(json);
      curlRan = again.body === JSON.stringify(payload) && again.headers['x-custom'] === 'hello';
    } catch (e) {
      curlRan = false;
    }
    check('exported curl re-sends an identical request', curlRan);
    const curlTarget = await fetch(`${base}/api/requests/${cap.id}/curl?format=json&target=${encodeURIComponent(echo.url + '/x')}`).then(json);
    check('curl export can point at a target URL', curlTarget.curl.includes(`${echo.url}/x`));
    const py = await fetch(`${base}/api/requests/${cap.id}/code?lang=python`).then(json);
    check('code export (python) works', py.code.includes('requests.request('));

    // 7: verification
    const stripeBody = JSON.stringify({ id: 'evt_1', type: 'charge.succeeded' });
    const t = Math.floor(Date.now() / 1000);
    const stripeSig = `t=${t},v1=${createHmac('sha256', STRIPE).update(`${t}.${stripeBody}`).digest('hex')}`;
    const s1 = await fetch(`${base}/wh/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig }, body: stripeBody }).then(json);
    const s2 = await fetch(`${base}/wh/stripe`, { method: 'POST', headers: { 'content-type': 'application/json', 'stripe-signature': stripeSig }, body: stripeBody + ' ' }).then(json);
    const v1 = (await fetch(`${base}/api/requests/${s1.id}`).then(json)).verification;
    const v2 = (await fetch(`${base}/api/requests/${s2.id}`).then(json)).verification;
    check('Stripe signature valid', v1?.provider === 'stripe' && v1.valid, v1?.reason);
    check('Stripe tampered body rejected with reason', v2?.valid === false && /mismatch/i.test(v2.reason), v2?.reason);
    const ghBody = '{"zen":"Keep it logically awesome."}';
    const ghSig = 'sha256=' + createHmac('sha256', GITHUB).update(ghBody).digest('hex');
    const g1 = await fetch(`${base}/wh/github`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-hub-signature-256': ghSig }, body: ghBody }).then(json);
    const gv = (await fetch(`${base}/api/requests/${g1.id}`).then(json)).verification;
    check('GitHub signature valid', gv?.provider === 'github' && gv.valid, gv?.reason);

    // 8: max-history trims (limit 3)
    const removed = waitForSse(base, 'request.removed');
    await removed.ready;
    for (let i = 0; i < 5; i++) await fetch(`${base}/wh/trim/${i}`, { method: 'PUT', body: `n=${i}`, headers: { 'content-type': 'text/plain' } });
    const list = await fetch(`${base}/api/requests`).then(json);
    check(
      '--max-history 3 trims the ring buffer (newest first)',
      list.requests.length === 3 && list.requests[0].path === '/wh/trim/4' && list.requests[2].path === '/wh/trim/2',
      `kept ${list.requests.map((r) => r.path).join(', ')}`,
    );
    check('SSE fires request.removed for evicted ids', Array.isArray((await removed.event)?.ids));

    // 9: other methods, /wh root, binary, empty
    const g = await fetch(`${base}/wh`);
    const h = await fetch(`${base}/wh/head-check`, { method: 'HEAD' });
    const o = await fetch(`${base}/wh/opt`, { method: 'OPTIONS' });
    const d = await fetch(`${base}/wh/del`, { method: 'DELETE' });
    const pa = await fetch(`${base}/wh/patch`, { method: 'PATCH', body: 'raw text no type' });
    check('GET /wh, HEAD, OPTIONS, DELETE, PATCH accepted', g.status === 200 && h.status === 200 && o.status === 204 && d.status === 200 && pa.status === 200);
    const bin = Buffer.from([0, 1, 2, 3, 255, 254, 10, 13]);
    const b = await fetch(`${base}/wh/bin`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: bin }).then(json);
    const bstored = await fetch(`${base}/api/requests/${b.id}`).then(json);
    check('binary body stored as base64', bstored.bodyEncoding === 'base64' && Buffer.from(bstored.body, 'base64').equals(bin));

    // 10: diff
    const two = (await fetch(`${base}/api/requests`).then(json)).requests;
    const diff = await fetch(`${base}/api/diff?a=${two[0].id}&b=${two[1].id}`).then(json);
    check('GET /api/diff compares two requests', Array.isArray(diff.changes) && diff.changes.length > 0);

    // 11: static UI + clear
    const html = await fetch(`${base}/`).then((r) => r.text());
    check('public/index.html served at /', html.includes('HookBox'));
    const traversal = await fetch(`${base}/..%2f..%2fpackage.json`);
    check('static server blocks path traversal', traversal.status === 403 || !(await traversal.text()).includes('"name": "hookbox"'));
    const cleared = waitForSse(base, 'requests.cleared');
    await cleared.ready;
    const del = await fetch(`${base}/api/requests`, { method: 'DELETE' }).then(json);
    const empty = await fetch(`${base}/api/requests`).then(json);
    check('DELETE /api/requests clears and broadcasts', del.ok && empty.requests.length === 0 && (await cleared.event) !== null);
  } finally {
    await stopCli(cli);
  }

  // 12: SQLite persistence across restarts
  const dbFile = join(tmp, 'hooks.db');
  const c1 = await startCli(['--db', dbFile]);
  const info = await fetch(`${c1.base}/api/info`).then(json);
  const p = await fetch(`${c1.base}/wh/persist`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"keep":true}' }).then(json);
  await stopCli(c1);
  const c2 = await startCli(['--db', dbFile]);
  const restored = await fetch(`${c2.base}/api/requests/${p.id}`);
  check('--db persists requests across restarts', info.persistence.enabled && restored.status === 200, `driver ${info.persistence.driver}`);
  await stopCli(c2);
  const notADir = join(tmp, 'not-a-dir');
  writeFileSync(notADir, 'file');
  const c4 = await startCli(['--db', join(notADir, 'hooks.db')]);
  const info4 = await fetch(`${c4.base}/api/info`).then(json);
  const okCapture = await fetch(`${c4.base}/wh/mem`, { method: 'POST', body: 'x' });
  check('--db degrades gracefully to memory when SQLite cannot open', !info4.persistence.enabled && info4.persistence.error && okCapture.status === 200, info4.persistence.error);
  await stopCli(c4);

  // 13: demo traffic
  const c3 = await startCli(['--demo', '--demo-interval', '100']);
  await sleep(1600);
  const demo = await fetch(`${c3.base}/api/requests`).then(json);
  const verified = demo.requests.filter((r) => r.verification);
  check(
    '--demo generates signed traffic (valid + tampered)',
    demo.requests.length >= 6 && verified.some((r) => r.verification.valid) && verified.some((r) => !r.verification.valid),
    `${demo.requests.length} requests`,
  );
  await stopCli(c3);

  await echo.close();
  rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${results.length - failed}/${results.length} checks passed`);
  process.exit(failed ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
