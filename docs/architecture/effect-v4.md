# Effect v4 architecture

## Definition

Cosmic-pi is Effect-first. Effect owns application lifecycle, dependencies, failures, concurrency, resources, state transitions, clocks, configuration, persistence, HTTP, logging, and tests. Pure deterministic functions remain pure and may use Effect data modules when they improve the model.

## Code conventions

- Import Effect modules through explicit namespace subpaths, for example `import * as Effect from "effect/Effect"`.
- Declare services as classes with `Context.Service` and deterministic language-service keys.
- Give every live implementation an explicit Layer. Compose the dependency graph before providing it.
- In beta.99, use `Layer.effect` with `Effect.acquireRelease` for layer-owned scoped resources.
- Keep implementation-only requirements in Layer construction rather than leaking them through service methods.
- Use `Schema.decodeUnknownEffect` at unknown boundaries. Do not cast decoded JSON.
- Represent expected failures with schema-backed tagged errors. Reserve defects for violated invariants.
- Use `Clock`, `Duration`, `Random`, `Config`, `Logger`, queues, deferred values, semaphores, refs, schedules, streams, and scopes instead of corresponding unmanaged globals.
- Create one `ManagedRuntime` from `session_start` at the Pi host boundary. Internal services never call Effect runners.
- Dispose runtimes and close session resources explicitly.
- Add spans around provider requests, refreshes, image streams, advisor checkpoints, and resource initialization without recording secrets.

## Beta-specific rules

Pinned declarations are the source of truth when older documentation disagrees:

- Services are `Context.Service`, not `ServiceMap.Service`.
- Layer-owned resources use `Layer.effect`; beta.99 has no `Layer.scoped` constructor.
- `ManagedRuntime.make(layer, { memoMap })` uses an options object.
- HTTP is imported from `effect/unstable/http` and provided separately by a Node HTTP layer.
- `@effect/vitest` beta.99 provides `it.effect`, `it.live`, and `layer`; it does not provide the older `it.scoped` helpers.

## Dependency layout

Compiler tooling lives at the workspace root. Runtime dependencies are declared directly by every package that imports them, using the synchronized pnpm catalog. `pi-cosmic-core` is a normal publishable package and does not register a Pi extension.

## Enforcement

- `tsconfig.base.json` enables core language-service correctness diagnostics for every package.
- `tsconfig.effect.json` enables Effect-native and anti-pattern diagnostics for every workspace package.
- `scripts/check-effect-architecture.mjs` directly requires zero unapproved violations in every package that extends `tsconfig.effect.json`.
- The temporary migration baseline was deleted after the final package cutover.

## Upgrade procedure

1. Update all synchronized Effect packages in one commit.
2. Re-run `effect-language-service patch`.
3. Review release notes and the pinned declarations.
4. Run `pnpm effect:lsp:verify` and `pnpm effect:diagnostics`.
5. Run focused tests, pack checks, benchmarks, and `pnpm validate`.
