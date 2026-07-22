# Agent guidance for pi-advisor

## Project layout

- `index.ts` exposes the extension; `src/extension.ts` is a thin public entrypoint.
- `src/application/register.ts` registers Pi lifecycle, commands, and events; `src/application/lifecycle.ts` owns session lifecycle flow; `src/application/controller.ts` is the controller surface.
- `src/layer.ts` composes the session application. `src/domain/` holds plain contracts (including safe-data and runtime-error classification); `src/boundary/` is foreign APIs only. See root `AGENTS.md` and `ARCHITECTURE.md`.
- `tests/**/*.test.ts` contains Vitest coverage. Prefer targeted tests near the changed behavior.
- `.pi/` is local runtime state and is ignored by git.

## Verification

Run the narrowest useful test first, then the package and workspace gates:

```bash
pnpm install
pnpm --filter pi-advisor test -- tests/<file>.test.ts
pnpm --filter pi-advisor validate
pnpm validate
```

`pnpm check` runs typecheck, lint, and format checks. Do not skip the full workspace validation gate for code changes.

## Coding conventions

- Use TypeScript ESM imports with `.ts` extensions, matching the workspace's source-distributed extensions.
- Keep Pi registration in `src/application/register.ts` and the public extension entrypoint thin; put pure domain logic in `src/domain/` and test it directly.
- Preserve unknown root JSON fields whenever settings update the global config.
- The advisor must fail open: model, auth, timeout, abort, parsing, and provider failures cannot block or discard the candidate response.
- Enforce at most one advisor-triggered revision for each genuine user request; advisor messages must never reset or recursively trigger the cycle.
- Never log, render, or commit credentials or auth-store contents.

## Release and publishing

This package is private and local-only. Do not publish it or add npm installation instructions. Keep its version synchronized with the workspace root and all other packages; the monorepo release workflow must skip it while publishing public packages. Do not tag or push release commits unless the maintainer explicitly instructs you to.
