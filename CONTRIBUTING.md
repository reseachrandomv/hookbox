# Contributing to HookBox

Thanks for helping! HookBox aims to stay **small, local-first and zero-config**. Contributions that keep it that way are the easiest to merge.

## Quick setup

```bash
git clone https://github.com/reseachrandomv/hookbox.git
cd hookbox
npm install          # installs deps and builds dist/ (prepare script)
npm run dev          # tsc --watch in one terminal
node dist/cli.js --demo   # in another: dashboard on http://localhost:4040
npm test             # end-to-end smoke tests against the built CLI
```

Requirements: Node.js 20 or newer. No Docker, database or API keys needed.

## Project layout

| Path | What lives there |
|---|---|
| `src/cli.ts` | CLI flags (commander), banner, terminal log |
| `src/server.ts` | Fastify app, raw-body capture, JSON API, SSE + WebSocket broadcaster, static UI |
| `src/store.ts` | In-memory ring buffer + optional SQLite (`node:sqlite` / `better-sqlite3`) |
| `src/verifier.ts` | Stripe and GitHub HMAC verification with human-readable failure reasons |
| `src/replay.ts` | Replay / auto-forward engine (fetch, header filtering, latency) |
| `src/codegen.ts` | cURL, fetch, TypeScript, Python, HTTPie, Vitest and Jest exporters |
| `src/diff.ts` | Structural diff of two requests |
| `src/tunnel.ts` | localtunnel / cloudflared tunnels with health checks |
| `src/demo.ts` | Signed demo traffic generator |
| `public/index.html` | The whole dashboard: Preact + HTM + Tailwind via CDN, **no build step** |
| `scripts/smoke-test.mjs` | End-to-end tests (`npm test`) |

## Good first contributions

Look for issues labelled [`good first issue`](https://github.com/reseachrandomv/hookbox/labels/good%20first%20issue) and [`help wanted`](https://github.com/reseachrandomv/hookbox/labels/help%20wanted). New **signature verifiers** (see `src/verifier.ts`) and **code exporters** (see `src/codegen.ts`) are self-contained and a great place to start.

## Guidelines

- **Raw bytes are sacred.** Never re-serialise a captured body; verification and replay depend on the exact bytes.
- **Keep dependencies minimal.** Runtime deps today: `fastify`, `ws`, `commander`. Please discuss new ones in an issue first. Optional features should lazy-load optional dependencies.
- **No frontend build step.** `public/index.html` must keep working when opened from the npm package as-is.
- **Strict TypeScript.** `npm run typecheck` must pass.
- **Test what you change.** Add or extend a `check(...)` in `scripts/smoke-test.mjs`.
- **No placeholders or TODOs** in merged code; open an issue for follow-ups instead.

## Pull request flow

1. Fork and create a branch: `git checkout -b feat/shopify-verifier`.
2. Make your change, then run `npm run build && npm test`.
3. Open a PR and fill in the template. Screenshots or GIFs help a lot for UI changes.
4. A maintainer reviews it. Small, focused PRs get merged fastest.

Commit messages: short imperative summaries are fine (`Add Shopify HMAC verifier`). Conventional Commits are welcome but not required.

## Reporting bugs and ideas

- Bugs: use the **Bug report** issue template and include your Node version, OS, the command you ran, and what you expected.
- Ideas: use the **Feature request** template or start a thread in [Discussions](https://github.com/reseachrandomv/hookbox/discussions).
- Security problems: **do not open a public issue**; see [SECURITY.md](SECURITY.md).

By contributing you agree that your contributions are licensed under the [MIT License](LICENSE) and that you'll follow our [Code of Conduct](CODE_OF_CONDUCT.md).
