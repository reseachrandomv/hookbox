/**
 * Public tunnels so third-party providers (Stripe, GitHub, …) can reach the
 * local capture endpoint.
 *
 * Order for provider "auto":
 *   1. localtunnel (bundled as an optional dependency, loaded lazily)
 *   2. cloudflared quick tunnel (https://*.trycloudflare.com), if the
 *      `cloudflared` binary is on PATH or HOOKBOX_CLOUDFLARED points at it
 */
import { spawn, type ChildProcess } from 'node:child_process';

export type TunnelProvider = 'auto' | 'localtunnel' | 'cloudflared';

export interface OpenTunnel {
  provider: Exclude<TunnelProvider, 'auto'>;
  url: string;
  close(): void;
}

export interface TunnelOutcome {
  tunnel: OpenTunnel | null;
  /** One line per provider that was tried and failed. */
  errors: string[];
}

interface LocalTunnelInstance {
  url: string;
  close(): void;
  on(event: 'error' | 'close', cb: (err?: Error) => void): void;
}

type LocalTunnelFn = (opts: { port: number; local_host?: string; subdomain?: string }) => Promise<LocalTunnelInstance>;

function withTimeout<T>(p: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

export async function openLocalTunnel(port: number, localHost: string, timeoutMs = 15_000): Promise<OpenTunnel> {
  const moduleName = 'localtunnel';
  let lt: LocalTunnelFn;
  try {
    const mod = (await import(moduleName)) as { default: LocalTunnelFn };
    lt = mod.default;
  } catch {
    throw new Error('localtunnel package is not installed (npm i localtunnel)');
  }
  const tunnel = await withTimeout(lt({ port, local_host: localHost }), timeoutMs, 'localtunnel');
  tunnel.on('error', () => undefined);
  return { provider: 'localtunnel', url: tunnel.url.replace(/\/$/, ''), close: () => tunnel.close() };
}

export function openCloudflaredTunnel(port: number, localHost: string, timeoutMs = 30_000): Promise<OpenTunnel> {
  const bin = process.env.HOOKBOX_CLOUDFLARED || 'cloudflared';
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = spawn(bin, ['tunnel', '--no-autoupdate', '--url', `http://${localHost}:${port}`], {
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (err) {
      reject(new Error(`cannot start cloudflared: ${(err as Error).message}`));
      return;
    }
    let settled = false;
    let log = '';
    const finish = (err: Error | null, url?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) {
        child.kill();
        reject(err);
      } else {
        resolve({ provider: 'cloudflared', url: url as string, close: () => child.kill() });
      }
    };
    let url: string | null = null;
    let lastError = '';
    const timer = setTimeout(() => {
      const why = url
        ? `got ${url} but no edge connection registered within ${timeoutMs / 1000}s${lastError ? ` (${lastError})` : ''}`
        : `did not report a URL within ${timeoutMs / 1000}s${lastError ? ` (${lastError})` : ''}`;
      finish(new Error(why));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      const text = chunk.toString();
      log = (log + text).slice(-8000);
      for (const line of text.split('\n')) {
        const err = / ERR (.+?)(?: connIndex=.*)?$/.exec(line);
        if (err && !/fetch features/i.test(err[1])) lastError = err[1].trim();
      }
      if (!url) url = /https:\/\/[a-z0-9-]+\.trycloudflare\.com/i.exec(log)?.[0] ?? null;
      // The URL is printed before the edge connection exists; wait until it is registered.
      if (url && /Registered tunnel connection/i.test(log)) finish(null, url);
    };
    child.stdout?.on('data', onData);
    child.stderr?.on('data', onData);
    child.on('error', (err: NodeJS.ErrnoException) => {
      finish(
        new Error(
          err.code === 'ENOENT'
            ? 'binary not installed (https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/)'
            : `cloudflared failed: ${err.message}`,
        ),
      );
    });
    child.on('exit', (code) => {
      const last = log.trim().split('\n').slice(-1)[0] ?? '';
      finish(new Error(`cloudflared exited with code ${code}${last ? `: ${last}` : ''}`));
    });
  });
}

/** Tries the requested provider(s) and returns the first tunnel that opens. */
export async function openTunnel(
  port: number,
  provider: TunnelProvider = 'auto',
  localHost = '127.0.0.1',
  opts: { verify?: boolean } = { verify: true },
): Promise<TunnelOutcome> {
  const order: Array<Exclude<TunnelProvider, 'auto'>> = provider === 'auto' ? ['localtunnel', 'cloudflared'] : [provider];
  const errors: string[] = [];
  for (const p of order) {
    let tunnel: OpenTunnel;
    try {
      tunnel = p === 'localtunnel' ? await openLocalTunnel(port, localHost) : await openCloudflaredTunnel(port, localHost);
    } catch (err) {
      errors.push(`${p}: ${(err as Error).message}`);
      continue;
    }
    if (!opts.verify) return { tunnel, errors };
    // A URL alone is not proof: make sure traffic actually reaches this server.
    let probe = await probeTunnel(tunnel.url, 10_000);
    for (let attempt = 1; !probe.ok && attempt < 3; attempt++) {
      await new Promise((r) => setTimeout(r, 2000));
      probe = await probeTunnel(tunnel.url, 10_000);
    }
    if (probe.ok) return { tunnel, errors };
    tunnel.close();
    errors.push(`${p}: ${tunnel.url} was issued but is unreachable (${probe.status ?? probe.error ?? 'no response'})`);
  }
  return { tunnel: null, errors };
}

/** Checks a tunnel end to end by requesting /api/health through it. */
export async function probeTunnel(url: string, timeoutMs = 15_000): Promise<{ ok: boolean; status: number | null; error: string | null }> {
  try {
    const res = await fetch(`${url}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
      headers: { 'bypass-tunnel-reminder': '1', 'user-agent': 'hookbox-probe' },
    });
    const text = await res.text();
    const ok = res.ok && text.includes('"ok":true');
    return { ok, status: res.status, error: ok ? null : `HTTP ${res.status}` };
  } catch (err) {
    return { ok: false, status: null, error: (err as Error).message };
  }
}
