# Agent guidance for pi-better-openai

## Project layout

- `index.ts` exposes the extension; `src/extension.ts` is a thin public entrypoint.
- `src/application.ts` registers commands/events and coordinates the session; `src/layer.ts` composes Effect services. See `ARCHITECTURE.md`.
- Follow the root `AGENTS.md` canonical small-extension tree: `config/`, `settings/`, `boundary/`, `auth/`, feature folders (`usage/`, `fast/`, `image/`, `footer/`), and `ui/`.
- `tests/**/*.test.ts` contains Vitest coverage. Prefer adding targeted tests near the changed behavior.
- `.pi/` is local runtime/config/generated output and is ignored by git.

## Verification

Run the narrowest useful test first, then the full gate before committing:

```bash
pnpm install
pnpm test -- tests/<file>.test.ts
pnpm validate
```

`pnpm check` runs typecheck, lint, and format checks. `pnpm validate` adds the full test suite. Do not skip the validation gate for code changes.

## Coding conventions

- Use TypeScript ESM imports with `.ts` extensions, matching the existing files.
- Keep the public extension entrypoint thin, Layer composition in `src/layer.ts`, and pure helpers outside application orchestration; test them directly.
- Preserve unknown JSON config fields when writing settings.
- Do not commit `node_modules/`, generated `.pi/` images/config, auth files, or other local machine state.

## Release and publishing

The monorepo release workflow publishes every package together from a GitHub Release or manual dispatch. Keep this package's version synchronized with the workspace root and all other packages. Do not publish, tag, or push release commits unless the maintainer explicitly instructs you to.

## Security reminders

- Never paste, log, or commit token/auth file contents. The auth store is normally `~/.pi/agent/auth.json` or under `PI_CODING_AGENT_DIR`.
- Mask account IDs in diagnostics and examples.
- Keep image input paths workspace-contained and avoid broadening file reads without explicit tests.
- Do not suppress high-severity audit findings without an actual remediation.
