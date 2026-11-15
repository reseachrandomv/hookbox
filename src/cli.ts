#!/usr/bin/env node
/**
 * HookBox CLI: `npx hookbox [options]`
 */
import { Command, InvalidArgumentError, Option } from 'commander';
import { createHookBox, VERSION } from './server.js';
import { DEMO_GITHUB_SECRET, DEMO_STRIPE_SECRET, startDemo } from './demo.js';
import { validateTarget } from './replay.js';
import type { HookBoxEvent } from './types.js';
import { openTunnel, type TunnelProvider } from './tunnel.js';

/* ---------------- colours (no dependency) ---------------- */

const useColor = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code: string) => (s: string) => (useColor ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  bold: paint('1'),
  dim: paint('2'),
  cyan: paint('36'),
  magenta: paint('35'),
  green: paint('32'),
  yellow: paint('33'),
  red: paint('31'),
  blue: paint('34'),
  gray: paint('90'),
  inverse: paint('7'),
};

const METHOD_COLOR: Record<string, (s: string) => string> = {
  GET: c.green,
  POST: c.blue,
  PUT: c.yellow,
  PATCH: c.magenta,
  DELETE: c.red,
  HEAD: c.gray,
  OPTIONS: c.gray,
};

/* ---------------- argument parsing ---------------- */

function parsePort(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new InvalidArgumentError('must be an integer between 0 and 65535');
  return n;
}

function parsePositiveInt(value: string): number {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1) throw new InvalidArgumentError('must be a positive integer');
  return n;
}

function parseTarget(value: string): string {
  try {
    return validateTarget(value).toString();
  } catch (err) {
    throw new InvalidArgumentError((err as Error).message);
  }
}

interface CliOptions {
  port: number;
  host: string;
  target?: string;
  maxHistory: number;
  db?: string;
  stripeSecret?: string;
  githubSecret?: string;
  tunnel: boolean | TunnelProvider;
  demo: boolean;
  demoInterval: number;
  demoCount?: number;
  bodyLimit: number;
  banner: boolean;
  log: boolean;
}

const program = new Command()
  .name('hookbox')
  .description('Zero-config local webhook inspector, verifier and replay tool.')
  .version(VERSION, '-v, --version', 'print the HookBox version')
  .helpOption('-h, --help', 'show this help')
  .addOption(new Option('-p, --port <number>', 'port for the dashboard and capture endpoint').default(4040).argParser(parsePort).env('HOOKBOX_PORT'))
  .addOption(new Option('--host <host>', 'interface to bind (use 0.0.0.0 to expose on your LAN)').default('127.0.0.1').env('HOOKBOX_HOST'))
  .addOption(new Option('-t, --target <url>', 'auto-forward every captured request to this URL').argParser(parseTarget).env('HOOKBOX_TARGET'))
  .addOption(new Option('-m, --max-history <number>', 'number of requests kept in the ring buffer').default(100).argParser(parsePositiveInt).env('HOOKBOX_MAX_HISTORY'))
  .addOption(new Option('--db <file>', 'persist requests to a local SQLite file').env('HOOKBOX_DB'))
  .addOption(new Option('--stripe-secret <whsec>', 'verify Stripe-Signature headers with this signing secret').env('HOOKBOX_STRIPE_SECRET'))
  .addOption(new Option('--github-secret <secret>', 'verify X-Hub-Signature-256 headers with this secret').env('HOOKBOX_GITHUB_SECRET'))
  .addOption(
    new Option('--tunnel [provider]', 'expose a public URL: auto (localtunnel, then cloudflared), localtunnel or cloudflared')
      .choices(['auto', 'localtunnel', 'cloudflared'])
      .default(false),
  )
  .addOption(new Option('--demo', 'send sample signed Stripe/GitHub/form traffic to yourself').default(false))
  .addOption(new Option('--demo-interval <ms>', 'delay between demo requests').default(2500).argParser(parsePositiveInt))
  .addOption(new Option('--demo-count <n>', 'stop the demo after this many requests (default: run until exit)').argParser(parsePositiveInt))
  .addOption(new Option('--body-limit <bytes>', 'max request body size in bytes').default(10 * 1024 * 1024).argParser(parsePositiveInt))
  .addOption(new Option('--no-banner', 'do not print the start-up banner'))
  .addOption(new Option('--no-log', 'do not log each captured request'))
  .addHelpText(
    'after',
    `
Examples:
  $ npx hookbox
  $ npx hookbox --port 5050 --target http://localhost:3000/api/webhooks/stripe
  $ npx hookbox --db ./hooks.db --max-history 500
  $ npx hookbox --stripe-secret whsec_xxx --github-secret s3cret
  $ npx hookbox --demo

Send a test webhook:
  $ curl -X POST http://localhost:4040/wh/test -H 'content-type: application/json' -d '{"hello":"world"}'
`,
  );

/* ---------------- banner ---------------- */

function printBanner(info: {
  localUrl: string;
  tunnelUrl: string | null;
  tunnelNote: string;
  target?: string;
  maxHistory: number;
  persistence: string;
  verification: string;
  demo: boolean;
}): void {
  const logo = [
    ' _   _             _    ____            ',
    '| | | | ___   ___ | | _| __ )  _____  __',
    "| |_| |/ _ \\ / _ \\| |/ /  _ \\ / _ \\ \\/ /",
    '|  _  | (_) | (_) |   <| |_) | (_) >  < ',
    '|_| |_|\\___/ \\___/|_|\\_\\____/ \\___/_/\\_\\',
  ];
  const gradient = [c.cyan, c.cyan, c.blue, c.magenta, c.magenta];
  const label = (s: string) => c.gray(s.padEnd(20));
  const out: string[] = [''];
  logo.forEach((line, i) => out.push('  ' + c.bold(gradient[i](line))));
  out.push('  ' + c.dim(`v${VERSION} · local webhook inspector & replay`), '');
  out.push(`  ${label('Local URL')}${c.bold(c.cyan(info.localUrl))}`);
  out.push(`  ${label('Capture endpoint')}${c.green(`${info.localUrl}/wh/<anything>`)}`);
  out.push(
    `  ${label('Public Tunnel URL')}${info.tunnelUrl ? c.bold(c.magenta(`${info.tunnelUrl}/wh/<anything>`)) + c.dim(` (${info.tunnelNote})`) : c.dim(info.tunnelNote)}`,
  );
  out.push(`  ${label('Target Forward URL')}${info.target ? c.yellow(info.target) : c.dim('off (use --target <url>)')}`);
  out.push(`  ${label('History')}${info.maxHistory} requests · ${info.persistence}`);
  out.push(`  ${label('Verification')}${info.verification}`);
  if (info.demo) out.push(`  ${label('Demo traffic')}${c.green('on')}`);
  out.push('');
  out.push('  ' + c.bold('Dashboard shortcuts'));
  const key = (k: string) => c.inverse(` ${k} `);
  out.push(`    ${key('j')} ${key('k')} / ${key('↑')} ${key('↓')}  navigate   ${key('r')} replay   ${key('/')} filter   ${key('c')} copy cURL`);
  out.push('');
  out.push('  ' + c.dim('Try it:'));
  out.push(
    '  ' + c.dim(`curl -X POST ${info.localUrl}/wh/test -H 'content-type: application/json' -d '{"hello":"world"}'`),
  );
  out.push('  ' + c.dim('Press Ctrl+C to stop.'), '');
  console.log(out.join('\n'));
}

function statusColor(status: number | null): (s: string) => string {
  if (status === null) return c.red;
  if (status >= 500) return c.red;
  if (status >= 400) return c.yellow;
  if (status >= 300) return c.cyan;
  return c.green;
}

/* ---------------- main ---------------- */

async function main(): Promise<void> {
  program.parse(process.argv);
  const opts = program.opts<CliOptions>();

  const secrets = {
    stripe: opts.stripeSecret ?? (opts.demo ? DEMO_STRIPE_SECRET : undefined),
    github: opts.githubSecret ?? (opts.demo ? DEMO_GITHUB_SECRET : undefined),
  };

  const hookbox = createHookBox({
    port: opts.port,
    host: opts.host,
    target: opts.target,
    maxHistory: opts.maxHistory,
    db: opts.db,
    secrets,
    bodyLimit: opts.bodyLimit,
  });

  let localUrl: string;
  try {
    localUrl = await hookbox.listen();
  } catch (err) {
    const e = err as NodeJS.ErrnoException;
    if (e.code === 'EADDRINUSE') {
      console.error(c.red(`✖ Port ${opts.port} is already in use. Try: npx hookbox --port ${opts.port + 1}`));
    } else if (e.code === 'EACCES') {
      console.error(c.red(`✖ Permission denied binding to ${opts.host}:${opts.port}. Try a port above 1024.`));
    } else {
      console.error(c.red(`✖ Failed to start: ${e.message}`));
    }
    await hookbox.close().catch(() => undefined);
    process.exit(1);
  }

  let tunnelUrl: string | null = null;
  let tunnelNote = 'off (use --tunnel)';
  let closeTunnel = () => undefined as void;
  if (opts.tunnel) {
    const provider: TunnelProvider = opts.tunnel === true ? 'auto' : opts.tunnel;
    const localHost = opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host;
    if (opts.banner) console.log(c.dim(`  Opening public tunnel (${provider})…`));
    const { tunnel, errors } = await openTunnel(hookbox.options.port, provider, localHost);
    if (tunnel) {
      tunnelUrl = tunnel.url;
      tunnelNote = tunnel.provider;
      closeTunnel = () => tunnel.close();
      hookbox.setPublicUrl(tunnel.url);
    } else {
      tunnelNote = `unavailable (${errors.join('; ')})`;
    }
  }

  const p = hookbox.store.persistence;
  const persistence = p.enabled
    ? c.green(`SQLite ${p.file} (${p.driver})`)
    : opts.db
      ? c.yellow(`memory only (${p.error ?? 'SQLite unavailable'})`)
      : c.dim('memory only (use --db <file> to persist)');
  const verification =
    [secrets.stripe ? c.green('Stripe ✓') : c.dim('Stripe –'), secrets.github ? c.green('GitHub ✓') : c.dim('GitHub –')].join('  ');

  if (opts.banner) {
    printBanner({ localUrl, tunnelUrl, tunnelNote, target: opts.target, maxHistory: opts.maxHistory, persistence, verification, demo: opts.demo });
  } else {
    console.log(`HookBox ${VERSION} listening on ${localUrl}`);
  }

  const loggedForwards = new Set<string>();
  if (opts.log) {
    const time = () => new Date().toLocaleTimeString();
    hookbox.broadcaster.subscribe((event: HookBoxEvent) => {
      if (event.type !== 'request.created' && event.type !== 'request.updated') return;
      const r = event.request;
      if (event.type === 'request.created') {
        const m = (METHOD_COLOR[r.method] ?? c.bold)(r.method.padEnd(7));
        const v = r.verification
          ? r.verification.valid
            ? c.green(` ✓ ${r.verification.provider}`)
            : c.red(` ✖ ${r.verification.provider}: ${r.verification.reason}`)
          : '';
        console.log(`${c.gray(time())} ${m} ${r.url} ${c.dim(`${r.size}B`)}${v}`);
        return;
      }
      // request.updated: log the auto-forward result once (replays are shown in the dashboard).
      const f = r.lastForward;
      if (!f || r.lastReplay?.at === f.at) return;
      const key = `${r.id}:${f.at}`;
      if (loggedForwards.has(key)) return;
      loggedForwards.add(key);
      if (loggedForwards.size > 1000) loggedForwards.clear();
      const s = f.status === null ? `ERR ${f.error}` : String(f.status);
      console.log(`${c.gray(time())} ${c.dim('  ↳ forward')} ${statusColor(f.status)(s)} ${c.dim(`${f.durationMs}ms → ${f.target}`)}`);
    });
  }
  let stopDemo = () => undefined as void;
  if (opts.demo) {
    const base = `http://${opts.host === '0.0.0.0' || opts.host === '::' ? '127.0.0.1' : opts.host}:${hookbox.options.port}`;
    stopDemo = startDemo({ baseUrl: base, intervalMs: opts.demoInterval, count: opts.demoCount });
  }

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(c.dim(`\n${signal} received, shutting down…`));
    stopDemo();
    closeTunnel();
    const force = setTimeout(() => process.exit(0), 3000);
    force.unref();
    await hookbox.close().catch(() => undefined);
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

main().catch((err) => {
  console.error(c.red(`✖ ${(err as Error).message}`));
  process.exit(1);
});
