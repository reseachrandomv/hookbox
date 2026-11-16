# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| 0.1.x (latest `main`) | ✅ |
| older | ❌ |

## Reporting a vulnerability

**Please don't open a public issue for security problems.**

Report privately via GitHub's **[private vulnerability reporting](https://github.com/reseachrandomv/hookbox/security/advisories/new)** (Security tab → *Report a vulnerability*). Include:

- affected version or commit
- steps to reproduce (a minimal request or command)
- impact as you understand it

You'll get an acknowledgement as soon as a maintainer sees it, and we'll keep you updated while a fix is prepared. We're happy to credit you in the release notes unless you prefer otherwise.

## Security model (what HookBox is and isn't)

HookBox is a **local developer tool**. Please keep these properties in mind:

- **Binds to `127.0.0.1` by default.** The dashboard and API have **no authentication**. Anyone who can reach the port can read captured requests (which may include secrets and tokens) and trigger replays. Only use `--host 0.0.0.0` on networks you trust.
- **`--tunnel` makes the capture endpoint *and* the dashboard/API reachable from the internet** through the tunnel URL. Treat that URL as a secret, and stop the tunnel when you're done.
- **Replay and `--target` send requests to URLs you choose**, from your machine. The dashboard only does this when you ask it to.
- **Captured data stays local**: in memory, or in the SQLite file you pass with `--db`. Signing secrets pasted in the dashboard are stored in your browser's `localStorage` and sent only to your local HookBox.
- The dashboard loads Preact/HTM, Tailwind and Google Fonts from public CDNs.

Reports about issues *within* this model (for example, path traversal in the static server, XSS from captured payloads in the dashboard, or signature verification bypasses) are very welcome.
