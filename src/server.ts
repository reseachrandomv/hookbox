/**
 * HookBox server: Fastify app with raw-body webhook capture on /wh and /wh/*,
 * a JSON API, real-time updates over WebSocket (/api/ws) and Server-Sent
 * Events (/api/events), signature verification, replay and auto-forwarding.
 */
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import { WebSocketServer, WebSocket } from 'ws';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { RequestStore } from './store.js';
import { decodeBody, encodeBody, parseForm, tryParseJson } from './body.js';
import { forwardRequest, validateTarget, type ReplayOverrides } from './replay.js';
import { verifyRequest, verifyWithSecret, type VerifierSecrets } from './verifier.js';
import { CODE_LANGS, CODE_LANG_LABELS, generateCode, type CodeLang } from './codegen.js';
import { diffRequests } from './diff.js';
import type { CapturedRequest, ForwardResult, HookBoxEvent } from './types.js';

export type { CapturedRequest, ForwardResult, HookBoxEvent, VerificationResult } from './types.js';
export { RequestStore } from './store.js';

const require = createRequire(import.meta.url);
export const VERSION: string = (require('../package.json') as { version: string }).version;

export const DEFAULT_PUBLIC_DIR = resolve(fileURLToPath(new URL('.', import.meta.url)), '..', 'public');

export interface HookBoxOptions {
  port?: number;
  host?: string;
  /** Auto-forward every captured request to this URL. */
  target?: string;
  maxHistory?: number;
  /** SQLite file for persistence (optional). */
  db?: string;
  secrets?: VerifierSecrets;
  /** Max accepted body size in bytes (default 10 MiB). */
  bodyLimit?: number;
  /** SSE heartbeat interval (default 15s). */
  heartbeatMs?: number;
  /** Replay/forward timeout (default 30s). */
  forwardTimeoutMs?: number;
  publicDir?: string;
  logger?: boolean;
  /** Public tunnel URL, if one is open (shown in /api/info and the dashboard). */
  publicUrl?: string | null;
}

export interface HookBox {
  app: FastifyInstance;
  store: RequestStore;
  broadcaster: Broadcaster;
  options: Required<Pick<HookBoxOptions, 'port' | 'host' | 'maxHistory' | 'bodyLimit' | 'heartbeatMs' | 'forwardTimeoutMs' | 'publicDir'>> &
    HookBoxOptions;
  /** Starts listening and returns the local URL. */
  listen(): Promise<string>;
  close(): Promise<void>;
  capture(req: FastifyRequest, raw: Buffer): CapturedRequest;
  replay(id: string, target: string, overrides?: ReplayOverrides): Promise<ForwardResult | null>;
  /** Sets the public tunnel URL after start-up. */
  setPublicUrl(url: string | null): void;
}

/* ------------------------------------------------------------------ */
/* Broadcaster: fan-out of events to SSE and WebSocket clients.        */
/* ------------------------------------------------------------------ */

export class Broadcaster {
  private sse = new Set<ServerResponse>();
  readonly wss = new WebSocketServer({ noServer: true });
  private heartbeat: NodeJS.Timeout;
  private eventId = 0;
  private listeners = new Set<(event: HookBoxEvent) => void>();

  constructor(heartbeatMs: number) {
    this.heartbeat = setInterval(() => this.ping(), heartbeatMs);
    this.heartbeat.unref();
    this.wss.on('connection', (socket: WebSocket & { isAlive?: boolean }) => {
      socket.isAlive = true;
      socket.on('pong', () => {
        socket.isAlive = true;
      });
      socket.on('error', () => socket.terminate());
    });
  }

  get clientCount(): { sse: number; ws: number } {
    return { sse: this.sse.size, ws: this.wss.clients.size };
  }

  addSse(res: ServerResponse, hello: unknown): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    res.write(`event: hello\ndata: ${JSON.stringify(hello)}\n\n`);
    this.sse.add(res);
    const remove = () => this.sse.delete(res);
    res.on('close', remove);
    res.on('error', remove);
  }

  sendHello(socket: WebSocket, hello: unknown): void {
    socket.send(JSON.stringify({ type: 'hello', ...((hello as object) ?? {}) }));
  }

  /** Registers an in-process listener (used by the CLI logger). Returns an unsubscribe function. */
  subscribe(listener: (event: HookBoxEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  broadcast(event: HookBoxEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        /* a faulty listener must not break capture */
      }
    }
    this.eventId += 1;
    const data = JSON.stringify(event);
    const frame = `id: ${this.eventId}\nevent: ${event.type}\ndata: ${data}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(frame);
      } catch {
        this.sse.delete(res);
      }
    }
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) client.send(data);
    }
  }

  private ping(): void {
    const frame = `: heartbeat ${Date.now()}\n\n`;
    for (const res of this.sse) {
      try {
        res.write(frame);
      } catch {
        this.sse.delete(res);
      }
    }
    for (const client of this.wss.clients as Set<WebSocket & { isAlive?: boolean }>) {
      if (client.isAlive === false) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }

  close(): void {
    clearInterval(this.heartbeat);
    for (const res of this.sse) res.end();
    this.sse.clear();
    for (const client of this.wss.clients) client.terminate();
    this.wss.close();
  }
}

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.woff2': 'font/woff2',
};

const CAPTURE_METHODS = ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'] as const;

function normalizeQuery(q: unknown): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  if (q && typeof q === 'object') {
    for (const [k, v] of Object.entries(q as Record<string, unknown>)) {
      if (Array.isArray(v)) out[k] = v.map(String);
      else if (v !== undefined) out[k] = String(v);
    }
  }
  return out;
}

function normalizeHeaders(h: FastifyRequest['headers']): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const [k, v] of Object.entries(h)) {
    if (v === undefined) continue;
    out[k] = Array.isArray(v) ? v.map(String) : String(v);
  }
  return out;
}

/** Parses an API JSON body (the catch-all parser hands us a Buffer). */
function apiJson(body: unknown): Record<string, unknown> {
  if (Buffer.isBuffer(body)) {
    if (body.length === 0) return {};
    const parsed = tryParseJson(body.toString('utf8'));
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
    throw Object.assign(new Error('Request body must be a JSON object'), { statusCode: 400 });
  }
  if (body && typeof body === 'object') return body as Record<string, unknown>;
  return {};
}

function originOf(req: FastifyRequest): string {
  const host = req.headers.host ?? `${req.hostname}`;
  return `${req.protocol}://${host}`;
}

/** Appends the captured query string to an auto-forward target that has none. */
function forwardUrlFor(target: string, captured: CapturedRequest): string {
  const url = new URL(target);
  const qIdx = captured.url.indexOf('?');
  if (!url.search && qIdx !== -1) url.search = captured.url.slice(qIdx);
  return url.toString();
}

/* ------------------------------------------------------------------ */
/* Server factory                                                      */
/* ------------------------------------------------------------------ */

export function createHookBox(opts: HookBoxOptions = {}): HookBox {
  const options = {
    ...opts,
    port: opts.port ?? 4040,
    host: opts.host ?? '127.0.0.1',
    maxHistory: opts.maxHistory ?? 100,
    bodyLimit: opts.bodyLimit ?? 10 * 1024 * 1024,
    heartbeatMs: opts.heartbeatMs ?? 15_000,
    forwardTimeoutMs: opts.forwardTimeoutMs ?? 30_000,
    publicDir: opts.publicDir ?? DEFAULT_PUBLIC_DIR,
  };
  if (options.target) validateTarget(options.target);

  const store = new RequestStore(options.maxHistory, options.db);
  const broadcaster = new Broadcaster(options.heartbeatMs);
  const secrets: VerifierSecrets = options.secrets ?? {};
  const app = Fastify({ logger: options.logger ?? false, bodyLimit: options.bodyLimit, trustProxy: false });

  // Keep every body as a raw Buffer, whatever the content type (or none).
  app.removeAllContentTypeParsers();
  app.addContentTypeParser('*', { parseAs: 'buffer', bodyLimit: options.bodyLimit }, (_req, body, done) => done(null, body));

  const hello = () => ({
    version: VERSION,
    count: store.size,
    maxHistory: store.maxHistory,
    target: options.target ?? null,
    publicUrl: options.publicUrl ?? null,
  });

  /* ---------------- capture ---------------- */

  function capture(req: FastifyRequest, raw: Buffer): CapturedRequest {
    const headers = normalizeHeaders(req.headers);
    const contentType = typeof req.headers['content-type'] === 'string' ? req.headers['content-type'] : null;
    const { body, bodyEncoding } = encodeBody(raw, contentType);
    const json = bodyEncoding === 'utf8' ? tryParseJson(body) : null;
    const form =
      bodyEncoding === 'utf8' && contentType && /application\/x-www-form-urlencoded/i.test(contentType) ? parseForm(body) : null;
    const qIdx = req.url.indexOf('?');
    const item: CapturedRequest = {
      id: randomUUID(),
      seq: store.nextSeq(),
      method: req.method.toUpperCase(),
      url: req.url,
      path: qIdx === -1 ? req.url : req.url.slice(0, qIdx),
      headers,
      query: normalizeQuery(req.query),
      contentType,
      body,
      bodyEncoding,
      json,
      form,
      ip: req.ip,
      timestamp: new Date().toISOString(),
      size: raw.length,
      verification: verifyRequest(raw, req.headers, secrets),
      lastReplay: null,
      lastForward: null,
    };
    const evicted = store.add(item);
    broadcaster.broadcast({ type: 'request.created', request: item });
    if (evicted.length) broadcaster.broadcast({ type: 'request.removed', ids: evicted });
    if (options.target) {
      const target = forwardUrlFor(options.target, item);
      void forwardRequest(item, target, 'forward', options.forwardTimeoutMs).then((result) => {
        if (!store.get(item.id)) return; // evicted or cleared meanwhile
        item.lastForward = result;
        store.update(item);
        broadcaster.broadcast({ type: 'request.updated', request: item });
      });
    }
    return item;
  }

  const captureHandler = async (req: FastifyRequest, reply: FastifyReply) => {
    const raw = Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0);
    const item = capture(req, raw);
    reply
      .header('access-control-allow-origin', '*')
      .header('access-control-allow-methods', CAPTURE_METHODS.join(', '))
      .header('access-control-allow-headers', String(req.headers['access-control-request-headers'] ?? '*'))
      .header('x-hookbox-id', item.id);
    if (req.method === 'HEAD') return reply.code(200).send();
    if (req.method === 'OPTIONS') return reply.code(204).send();
    return reply.code(200).send({ ok: true, id: item.id, message: 'Captured by HookBox' });
  };

  app.route({ method: [...CAPTURE_METHODS], url: '/wh', handler: captureHandler });
  app.route({ method: [...CAPTURE_METHODS], url: '/wh/*', handler: captureHandler });

  /* ---------------- replay ---------------- */

  async function replay(id: string, target: string, overrides: ReplayOverrides = {}): Promise<ForwardResult | null> {
    const item = store.get(id);
    if (!item) return null;
    const result = await forwardRequest(item, target, 'replay', { timeoutMs: options.forwardTimeoutMs, ...overrides });
    if (store.get(id)) {
      item.lastReplay = result;
      store.update(item);
      broadcaster.broadcast({ type: 'request.updated', request: item });
    }
    return result;
  }

  /* ---------------- API ---------------- */

  app.get('/api/health', async () => ({ ok: true, version: VERSION }));

  app.get('/api/info', async () => ({
    name: 'hookbox',
    version: VERSION,
    count: store.size,
    maxHistory: store.maxHistory,
    target: options.target ?? null,
    publicUrl: options.publicUrl ?? null,
    persistence: store.persistence,
    verification: { stripe: Boolean(secrets.stripe), github: Boolean(secrets.github) },
    clients: broadcaster.clientCount,
    captureUrl: '/wh/*',
    codeLangs: CODE_LANGS.map((id) => ({ id, label: CODE_LANG_LABELS[id] })),
  }));

  app.get('/api/requests', async (req) => {
    const q = req.query as Record<string, string | undefined>;
    let items = store.list();
    if (q.method) {
      const methods = q.method.toUpperCase().split(',');
      items = items.filter((r) => methods.includes(r.method));
    }
    if (q.q) {
      const needle = q.q.toLowerCase();
      items = items.filter(
        (r) => r.url.toLowerCase().includes(needle) || (r.bodyEncoding === 'utf8' && r.body.toLowerCase().includes(needle)),
      );
    }
    const limit = q.limit ? Math.max(1, Math.min(Number(q.limit) || store.maxHistory, store.maxHistory)) : undefined;
    const total = items.length;
    if (limit) items = items.slice(0, limit);
    return { total, maxHistory: store.maxHistory, requests: items };
  });

  app.get('/api/requests/:id', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = store.get(id);
    if (!item) return reply.code(404).send({ error: 'Request not found', id });
    return item;
  });

  app.delete('/api/requests', async () => {
    const cleared = store.size;
    store.clear();
    broadcaster.broadcast({ type: 'requests.cleared' });
    return { ok: true, cleared };
  });

  app.post('/api/requests/:id/replay', async (req, reply) => {
    const { id } = req.params as { id: string };
    let target: unknown;
    const overrides: ReplayOverrides = {};
    try {
      const body = apiJson(req.body);
      target = body.target ?? options.target;
      validateTarget(target);
      if (body.method !== undefined) {
        if (typeof body.method !== 'string') throw new Error('"method" must be a string');
        overrides.method = body.method;
      }
      if (body.headers !== undefined) {
        if (!body.headers || typeof body.headers !== 'object' || Array.isArray(body.headers)) throw new Error('"headers" must be an object');
        overrides.headers = Object.fromEntries(
          Object.entries(body.headers as Record<string, unknown>).map(([k, v]) => [k, v === null ? null : String(v)]),
        );
      }
      if (body.timeoutMs !== undefined) {
        const t = Number(body.timeoutMs);
        if (!Number.isFinite(t) || t <= 0) throw new Error('"timeoutMs" must be a positive number');
        overrides.timeoutMs = t;
      }
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const result = await replay(id, target as string, overrides);
    if (!result) return reply.code(404).send({ error: 'Request not found', id });
    return result;
  });

  app.post('/api/requests/:id/verify', async (req, reply) => {
    const { id } = req.params as { id: string };
    const item = store.get(id);
    if (!item) return reply.code(404).send({ error: 'Request not found', id });
    let body: Record<string, unknown>;
    try {
      body = apiJson(req.body);
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
    const provider = body.provider === 'stripe' || body.provider === 'github' ? body.provider : 'auto';
    const secret = typeof body.secret === 'string' ? body.secret : '';
    const tolerance = body.toleranceSec === undefined ? undefined : Number(body.toleranceSec);
    return verifyWithSecret(decodeBody(item.body, item.bodyEncoding), item.headers, secret, {
      provider,
      toleranceSec: Number.isFinite(tolerance) ? tolerance : undefined,
    });
  });

  app.get('/api/requests/:id/curl', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { target?: string; format?: string };
    const item = store.get(id);
    if (!item) return reply.code(404).send({ error: 'Request not found', id });
    let base = originOf(req);
    if (q.target) {
      try {
        base = validateTarget(q.target).toString();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    const curl = generateCode(item, 'curl', base);
    if (q.format === 'json') return { id, curl };
    return reply.type('text/plain; charset=utf-8').send(curl);
  });

  app.get('/api/requests/:id/code', async (req, reply) => {
    const { id } = req.params as { id: string };
    const q = req.query as { lang?: string; target?: string };
    const item = store.get(id);
    if (!item) return reply.code(404).send({ error: 'Request not found', id });
    const lang = (q.lang ?? 'curl') as CodeLang | 'all';
    if (lang !== 'all' && !CODE_LANGS.includes(lang)) return reply.code(400).send({ error: `Unknown lang "${q.lang}". Use one of: ${CODE_LANGS.join(', ')}` });
    let base = originOf(req);
    if (q.target) {
      try {
        base = validateTarget(q.target).toString();
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    }
    if (lang === 'all') {
      return { id, lang, snippets: CODE_LANGS.map((l) => ({ lang: l, label: CODE_LANG_LABELS[l], code: generateCode(item, l, base) })) };
    }
    return { id, lang, label: CODE_LANG_LABELS[lang], code: generateCode(item, lang, base) };
  });

  app.get('/api/diff', async (req, reply) => {
    const q = req.query as { a?: string; b?: string; all?: string };
    if (!q.a || !q.b) return reply.code(400).send({ error: 'Pass two request ids: /api/diff?a=<id>&b=<id>' });
    const a = store.get(q.a);
    const b = store.get(q.b);
    if (!a || !b) return reply.code(404).send({ error: 'Request not found', missing: [!a && q.a, !b && q.b].filter(Boolean) });
    return diffRequests(a, b, { ignoreVolatile: q.all !== '1' });
  });

  app.get('/api/events', (req, reply) => {
    reply.hijack();
    broadcaster.addSse(reply.raw, hello());
  });

  /* ---------------- WebSocket ---------------- */

  app.server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    const path = (request.url ?? '').split('?')[0];
    if (path !== '/api/ws') {
      socket.destroy();
      return;
    }
    broadcaster.wss.handleUpgrade(request, socket, head, (ws) => {
      broadcaster.wss.emit('connection', ws, request);
      broadcaster.sendHello(ws, hello());
    });
  });

  /* ---------------- static UI ---------------- */

  const publicRoot = resolve(options.publicDir);
  const sendStatic = (reply: FastifyReply, file: string) => {
    const type = MIME[extname(file).toLowerCase()] ?? 'application/octet-stream';
    return reply
      .header('cache-control', type.startsWith('text/html') ? 'no-cache' : 'public, max-age=300')
      .type(type)
      .send(createReadStream(file));
  };

  app.get('/*', async (req, reply) => {
    const urlPath = decodeURIComponent(req.url.split('?')[0]);
    if (urlPath.startsWith('/api/')) return reply.code(404).send({ error: 'Not found' });
    const rel = normalize(urlPath).replace(/^([/\\])+/, '');
    const candidate = resolve(join(publicRoot, rel));
    if (candidate !== publicRoot && !candidate.startsWith(publicRoot + sep)) return reply.code(403).send({ error: 'Forbidden' });
    if (rel && existsSync(candidate) && statSync(candidate).isFile()) return sendStatic(reply, candidate);
    const index = join(publicRoot, 'index.html');
    if (existsSync(index)) return sendStatic(reply, index);
    return reply.type('text/plain').send(`HookBox ${VERSION} is running. Capture URL: /wh/*`);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode >= 400 ? err.statusCode : 500;
    reply.code(status).send({ error: err.message });
  });

  /* ---------------- lifecycle ---------------- */

  const hookbox: HookBox = {
    app,
    store,
    broadcaster,
    options,
    capture,
    replay,
    setPublicUrl(url) {
      options.publicUrl = url;
    },
    async listen() {
      await app.listen({ port: options.port, host: options.host });
      const addr = app.server.address();
      const port = typeof addr === 'object' && addr ? addr.port : options.port;
      options.port = port;
      const host = options.host === '0.0.0.0' || options.host === '::' ? 'localhost' : options.host;
      return `http://${host.includes(':') ? `[${host}]` : host}:${port}`;
    },
    async close() {
      broadcaster.close();
      await app.close();
      store.close();
    },
  };
  return hookbox;
}
