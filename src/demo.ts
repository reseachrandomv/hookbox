/**
 * Demo traffic generator: sends realistic, correctly signed webhook traffic to
 * a running HookBox so the dashboard can be explored without a real provider.
 */
import { randomBytes, randomUUID } from 'node:crypto';
import { signGitHub, signStripe } from './verifier.js';

export const DEMO_STRIPE_SECRET = 'whsec_hookbox_demo_secret';
export const DEMO_GITHUB_SECRET = 'hookbox-demo-github-secret';

export interface DemoOptions {
  /** Base URL of the HookBox server, e.g. http://127.0.0.1:4040 */
  baseUrl: string;
  intervalMs?: number;
  /** Stop after this many requests (default: run until stopped). */
  count?: number;
  stripeSecret?: string;
  githubSecret?: string;
  onSent?: (info: { name: string; status: number | null; error?: string }) => void;
}

interface DemoRequest {
  name: string;
  method: string;
  path: string;
  headers: Record<string, string>;
  body?: string | Buffer;
}

const rid = (prefix: string, n = 14) => `${prefix}_${randomBytes(n).toString('base64url').slice(0, n)}`;

function stripeEvent(secret: string, tamper = false): DemoRequest {
  const amount = 500 + Math.floor(Math.random() * 20000);
  const body = JSON.stringify({
    id: rid('evt'),
    object: 'event',
    api_version: '2024-06-20',
    created: Math.floor(Date.now() / 1000),
    type: 'payment_intent.succeeded',
    livemode: false,
    data: {
      object: { id: rid('pi'), object: 'payment_intent', amount, currency: 'usd', status: 'succeeded', customer: rid('cus') },
    },
  });
  const sig = signStripe(body, secret);
  return {
    name: tamper ? 'stripe payment_intent.succeeded (tampered)' : 'stripe payment_intent.succeeded',
    method: 'POST',
    path: '/wh/stripe',
    headers: { 'content-type': 'application/json; charset=utf-8', 'user-agent': 'Stripe/1.0 (+https://stripe.com/docs/webhooks)', 'stripe-signature': sig },
    body: tamper ? body.replace(`"amount":${amount}`, `"amount":${amount + 1}`) : body,
  };
}

function githubPush(secret: string): DemoRequest {
  const body = JSON.stringify({
    ref: 'refs/heads/main',
    before: randomBytes(20).toString('hex'),
    after: randomBytes(20).toString('hex'),
    repository: { id: 123456, full_name: 'acme/webapp', private: false },
    pusher: { name: 'octocat', email: 'octocat@example.com' },
    commits: [{ id: randomBytes(20).toString('hex'), message: 'Fix webhook retry handling', author: { name: 'octocat' } }],
  });
  return {
    name: 'github push',
    method: 'POST',
    path: '/wh/github',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc1234',
      'x-github-event': 'push',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': signGitHub(body, secret),
    },
    body,
  };
}

function formPost(): DemoRequest {
  const body = new URLSearchParams({ name: 'Ada Lovelace', email: 'ada@example.com', plan: 'pro', tags: 'beta' }).toString() + '&tags=early';
  return { name: 'form submission', method: 'POST', path: '/wh/forms/signup?source=landing', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body };
}

function genericPut(): DemoRequest {
  return {
    name: 'order updated (PUT)',
    method: 'PUT',
    path: '/wh/orders/1042',
    headers: { 'content-type': 'application/json', authorization: 'Bearer demo-token' },
    body: JSON.stringify({ orderId: 1042, status: ['packed', 'shipped', 'delivered'][Math.floor(Math.random() * 3)], items: 3 }),
  };
}

function pingGet(): DemoRequest {
  return { name: 'health ping (GET)', method: 'GET', path: `/wh/ping?ts=${Date.now()}&env=staging`, headers: { 'user-agent': 'uptime-bot/2.1' } };
}

function binaryUpload(): DemoRequest {
  return { name: 'binary upload', method: 'POST', path: '/wh/uploads', headers: { 'content-type': 'application/octet-stream' }, body: randomBytes(64) };
}

function githubPullRequestWrongSecret(): DemoRequest {
  const body = JSON.stringify({
    action: 'opened',
    number: 7,
    pull_request: { title: 'Add retry backoff', user: { login: 'hubot' }, head: { ref: 'feat/backoff' }, base: { ref: 'main' } },
    repository: { full_name: 'acme/webapp' },
  });
  return {
    name: 'github pull_request (signed with the wrong secret)',
    method: 'POST',
    path: '/wh/github',
    headers: {
      'content-type': 'application/json',
      'user-agent': 'GitHub-Hookshot/abc1234',
      'x-github-event': 'pull_request',
      'x-github-delivery': randomUUID(),
      'x-hub-signature-256': signGitHub(body, 'not-the-configured-secret'),
    },
    body,
  };
}

function patchProfile(): DemoRequest {
  return {
    name: 'user updated (PATCH)',
    method: 'PATCH',
    path: '/wh/users/u_314',
    headers: { 'content-type': 'application/merge-patch+json', 'x-event': 'user.updated' },
    body: JSON.stringify({ email: 'grace@example.com', preferences: { theme: 'dark', digest: 'weekly' } }),
  };
}

function deleteHook(): DemoRequest {
  return { name: 'subscription deleted (DELETE)', method: 'DELETE', path: '/wh/subscriptions/sub_42', headers: { 'x-event': 'subscription.deleted' } };
}

export function buildDemoSequence(stripeSecret: string, githubSecret: string): Array<() => DemoRequest> {
  return [
    () => stripeEvent(stripeSecret),
    () => githubPush(githubSecret),
    formPost,
    genericPut,
    pingGet,
    () => stripeEvent(stripeSecret, true),
    patchProfile,
    binaryUpload,
    githubPullRequestWrongSecret,
    deleteHook,
  ];
}

export async function sendDemoRequest(baseUrl: string, req: DemoRequest): Promise<number> {
  const res = await fetch(new URL(req.path, baseUrl), {
    method: req.method,
    headers: { ...req.headers, 'x-hookbox-demo': '1' },
    body: req.body,
    signal: AbortSignal.timeout(10_000),
  });
  await res.arrayBuffer();
  return res.status;
}

/** Starts sending demo traffic; returns a stop function. */
export function startDemo(opts: DemoOptions): () => void {
  const seq = buildDemoSequence(opts.stripeSecret ?? DEMO_STRIPE_SECRET, opts.githubSecret ?? DEMO_GITHUB_SECRET);
  const interval = Math.max(100, opts.intervalMs ?? 2500);
  let i = 0;
  let stopped = false;
  let timer: NodeJS.Timeout | null = null;

  const tick = async () => {
    if (stopped) return;
    if (opts.count !== undefined && i >= opts.count) return;
    const req = seq[i % seq.length]();
    i += 1;
    try {
      const status = await sendDemoRequest(opts.baseUrl, req);
      opts.onSent?.({ name: req.name, status });
    } catch (err) {
      opts.onSent?.({ name: req.name, status: null, error: (err as Error).message });
    }
    if (!stopped && (opts.count === undefined || i < opts.count)) timer = setTimeout(tick, interval);
  };
  timer = setTimeout(tick, 300);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
