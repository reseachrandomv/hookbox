## What does this PR do?

<!-- A short summary of the change and why it's needed. Link the issue: "Closes #123". -->

## Type of change

- [ ] 🐛 Bug fix
- [ ] ✨ New feature (verifier, exporter, UI, CLI flag…)
- [ ] 📝 Docs
- [ ] ♻️ Refactor / tooling

## How was it tested?

- [ ] `npm run build` passes
- [ ] `npm test` passes (and I added or updated a check in `scripts/smoke-test.mjs` if behaviour changed)
- [ ] Tried it manually with `node dist/cli.js --demo`

## Screenshots / GIF (UI changes)

<!-- Drag images here. -->

## Checklist

- [ ] Captured bodies are still handled as raw bytes (no re-serialisation)
- [ ] No new runtime dependency (or it's discussed in the linked issue / lazily loaded)
- [ ] No TODOs or placeholders left in the code
- [ ] README / `--help` updated if user-facing behaviour changed
