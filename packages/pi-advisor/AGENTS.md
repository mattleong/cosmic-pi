# Agent guidance for pi-advisor

## Project layout

- `index.ts` registers the advisor lifecycle, commands, settings UI, status, and review renderer.
- `src/` contains focused helpers for global configuration, bounded review context, advisor output parsing, and review execution.
- `tests/` contains Vitest coverage. Prefer targeted tests near the changed behavior.
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
- Keep event and UI wiring in `index.ts` small; put pure config, context, and parsing logic in `src/` and test it directly.
- Preserve unknown root JSON fields whenever settings update the global config.
- The advisor must fail open: model, auth, timeout, abort, parsing, and provider failures cannot block or discard the candidate response.
- Enforce at most one advisor-triggered revision for each genuine user request; advisor messages must never reset or recursively trigger the cycle.
- Never log, render, or commit credentials or auth-store contents.

## Release and publishing

This package is private and local-only. Do not publish it or add npm installation instructions. Keep its version synchronized with the workspace root and all other packages; the monorepo release workflow must skip it while publishing public packages. Do not tag or push release commits unless the maintainer explicitly instructs you to.
