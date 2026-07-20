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
- The shared Pi session-runtime slot is the minimal imperative island: it creates, replaces, and disposes the runtime that cannot own its own creation. Everything acquired after runtime construction is scoped inside Effect.
- Dispose runtimes and close session resources explicitly.
- Effect services own state transitions in `Ref` or `SynchronizedRef`. When Pi requires synchronous rendering, services atomically publish immutable snapshots to a boundary `MutableRef`; renderers only read those snapshots.
- Add spans around provider requests, refreshes, image streams, advisor checkpoints, and resource initialization without recording secrets.

## Beta-specific rules

Pinned declarations are the source of truth when older documentation disagrees:

- Services are `Context.Service`, not `ServiceMap.Service`.
- Layer-owned resources use `Layer.effect`; beta.99 has no `Layer.scoped` constructor.
- `ManagedRuntime.make(layer, { memoMap })` uses an options object.
- HTTP is imported from `effect/unstable/http` and provided separately by a Node HTTP layer.
- `@effect/vitest` beta.99 provides `it.effect`, `it.live`, and `layer`; it does not provide the older `it.scoped` helpers.

## Final service graph

Each extension has one host-owned session runtime. `PiApi` and the package application Layer are composed once at startup; implementation Layers hide their dependencies before entering the runtime.

- `pi-cosmic-core` supplies the managed-runtime facade/session slot, typed HTTP and document adapters, `SafeFile`, `AgentDirectory`, subscription refresh coordination, security utilities, and deterministic test Layers.
- `pi-cosmic-ui` composes config repository, narrow Pi process execution, repository probing, footer host state, and the plain-data footer protocol client.
- Better OpenAI and Better xAI compose provider-local config/auth/request schemas with the shared refresh engine and Cosmic UI client. OpenAI additionally scopes image streaming, Sharp, safe input reads, and atomic output writes.
- `pi-code-previews` composes session capability, settings/environment services, scoped Shiki state, and scoped before-write state. Pure diff/layout/rendering remains outside Effect.
- `pi-advisor` composes the parent controller, review queue, child runtime, read-only filesystem, and Pi command adapter. Immediate ingestion remains a bounded synchronous projection into the controller.

No extension owns a telemetry exporter or process-wide Effect runtime.

## State and projection contract

`SynchronizedRef` owns effectful state and serializes transitions. A successful atomic transition publishes a newly frozen `MutableRef` snapshot only when Pi needs a synchronous renderer. Renderers never mutate the snapshot, call a runner, build a Layer, or read an Effect Ref. Pure reducers, formatting, parsing of already trusted values, diffing, word matching, and TUI layout stay synchronous.

## Observability contract

Stable operation spans use package-prefixed names. Required families are:

- `pi-cosmic-core.runtime.startup`, `pi-cosmic-core.http.{json,streaming}.*`, and `pi-cosmic-core.safe-file.initialize`;
- `pi-better-{openai,xai}.usage.{initialize,refresh}`;
- `pi-better-openai.image.{request,stream,convert,write}`;
- `pi-cosmic-ui.probe.{git,pull-request}`;
- `pi-code-previews.shiki.initialize`;
- `pi-advisor.{parent,child}.checkpoint`, `pi-advisor.checkpoint.decode`, and advisor tool spans.

Only bounded enums, counts, methods, and status codes may be attributes. URLs, paths, prompts, bodies, credentials, auth values, account/team identifiers, and raw errors are forbidden. The core HTTP adapters disable the upstream client's URL-bearing automatic span and emit safe workspace spans instead. Unknown diagnostics pass through shared redaction before they reach logs or projections.

## Dependency layout

Compiler tooling lives at the workspace root. Runtime dependencies are declared directly by every package that imports them, using the synchronized pnpm catalog. `pi-cosmic-core` is a normal publishable package and does not register a Pi extension.

## Enforcement

- `tsconfig.base.json` enables core language-service correctness diagnostics for every package.
- `tsconfig.effect.json` enables Effect-native and anti-pattern diagnostics for every workspace package.
- `scripts/run-effect-diagnostics.mjs` dynamically enumerates every package TypeScript project.
- `scripts/check-effect-architecture.mjs` uses exact file/import/call-owner allowlists, verifies direct `catalog:` declarations, and rejects detached runners, unsafe Effect operations, unsafe JSON request bodies, raw platform globals, leaked HTTP Layers, and direct expected-error throws inside `Effect.gen`.
- `scripts/check-effect-architecture.test.mjs` runs positive and negative AST fixtures for every strengthened rule family.
- The temporary migration baseline was deleted after the final package cutover.

## Upgrade procedure

1. Update all synchronized Effect packages in one commit.
2. Re-run `effect-language-service patch`.
3. Review release notes and the pinned declarations.
4. Run `pnpm effect:lsp:verify` and `pnpm effect:diagnostics`.
5. Run focused tests, pack checks, benchmarks, and `pnpm validate`.
