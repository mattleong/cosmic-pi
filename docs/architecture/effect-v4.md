# Effect v4 architecture

The numbered audit implementation is mapped in [effect-audit-mapping.md](effect-audit-mapping.md).

## Definition

Cosmic-pi is Effect-first. Effect owns application lifecycle, dependencies, failures, concurrency, resources, state transitions, clocks, configuration, persistence, HTTP, logging, and tests. Pure deterministic functions remain pure and may use Effect data modules when they improve the model.

## Code conventions

- Import Effect modules through explicit namespace subpaths, for example `import * as Effect from "effect/Effect"`.
- Declare services as classes with `Context.Service` and deterministic language-service keys.
- Give every live implementation an explicit Layer. Compose the dependency graph before providing it.
- In beta.99, use `Layer.effect` with `Effect.acquireRelease` for layer-owned scoped resources.
- Use `Effect.sync` only for operations that are total by contract. Wrap hostile or throwing
  synchronous callbacks with `Effect.try` and a schema-backed boundary error, then recover that
  typed failure deliberately where the host callback is best effort.
- Use `Effect.promise` only when rejection is impossible by contract. Ordinary third-party and
  Node Promises use `Effect.tryPromise`; cleanup failures are mapped to a redacted typed error
  before they are propagated or deliberately recovered.
- Register a finalizer only after the acquisition has established ownership. Generated names,
  candidate paths, and other intentions to acquire are not resources; exclusive file creation,
  opened handles, subscriptions, and child scopes are.
- Default host and third-party Promises to interruptible. An ordered finalizer or irreversible
  commit region may be uninterruptible only when it is narrowly documented, ownership is already
  established, exact-once state publication is included, and the liveness tradeoff is explicit.
  When a foreign API cannot be cancelled and ordering does not require waiting for settlement,
  detach Effect ownership on interruption and arrange safe late cleanup instead of blocking scope
  closure indefinitely.
- Keep implementation-only requirements in Layer construction rather than leaking them through service methods.
- Use `Schema.decodeUnknownEffect` at unknown boundaries. Do not cast decoded JSON. Core JSON HTTP requests require a provider-local response decoder and return an accepted typed body or a rejected status with preserved response text; no public `body: unknown` path exists.
- Represent expected failures with schema-backed tagged errors. Reserve defects for violated invariants.
- Use `Clock`, `Duration`, `Random`, `Config`, `Logger`, queues, deferred values, semaphores, refs, schedules, streams, and scopes instead of corresponding unmanaged globals.
- Create one `ManagedRuntime` from `session_start` at the Pi host boundary. Internal services never call Effect runners.
- The shared Pi session-runtime slot is the minimal imperative island: it creates, replaces, and disposes the runtime that cannot own its own creation. Everything acquired after runtime construction is scoped inside Effect.
- Production session-runtime facades carry the exact `Layer.Error` type and never cast a returned
  Fiber to erase initialization failure. Exported compatibility types may default an omitted
  error argument to conservative `unknown`, but every workspace call site supplies the exact type;
  no runtime error may be defaulted or asserted to `never`.
- Dispose runtimes and close session resources explicitly.
- Effect services own state transitions in `Ref` or `SynchronizedRef`. When Pi requires synchronous rendering, services atomically publish immutable snapshots to a boundary `MutableRef`; renderers only read those snapshots.
- Keep stale-result validation and its commit inside the same serialized transition. Likewise,
  persistence plus authoritative projection publication is one serialized commit whenever
  concurrent callers could otherwise publish an older read after a newer write.
- For atomic file replacement, complete creation, writing, validation, and permissions before a
  narrow uninterruptible rename commit. Nothing fallible follows the rename; owned temporary
  cleanup is best effort and cannot change the committed result.
- Prefer explicit one-argument callbacks such as `Effect.map((value) => decode(value))` over tacit
  higher-order use when a function is overloaded, generic, or accepts optional extra arguments.
- Add spans around provider requests, refreshes, image streams, advisor checkpoints, and resource initialization without recording secrets.

## Beta-specific rules

Pinned declarations are the source of truth when older documentation disagrees:

- Services are `Context.Service`, not `ServiceMap.Service`.
- Layer-owned resources use `Layer.effect`; beta.99 has no `Layer.scoped` constructor.
- `ManagedRuntime.make(layer, { memoMap })` uses an options object.
- HTTP is imported from `effect/unstable/http` and provided separately by a Node HTTP layer. Streaming JSON bodies are encoded through a caller-supplied Codec; true streaming responses expose explicitly named raw bytes and discard operations.
- `@effect/vitest` beta.99 provides `it.effect`, `it.live`, and `layer`; it does not provide the older `it.scoped` helpers.

## Package navigation

Each extension exposes the same readable spine, applied proportionally to its size:

- `src/extension.ts` is the thin Pi entrypoint or registration adapter;
- `src/application.ts` or `src/application/` coordinates session/use-case flow;
- `src/layer.ts` is the application composition root;
- feature directories own vertical capabilities, domain modules hold deterministic policy/contracts,
  `boundary/` wraps host/third-party APIs, and `ui/` or feature render modules consume synchronous
  projections.

Each package's `ARCHITECTURE.md` maps its commands/events, state, resources, and concrete source
layout. Compatibility re-exports may retain older internal paths, but stateful implementations have
one owner. `pi-cosmic-core` remains infrastructure-only and documents its public runtime/platform
layout separately.

## Final service graph

Each extension has one host-owned session runtime. `PiApi` and the package application Layer are composed once at startup; implementation Layers hide their dependencies before entering the runtime.

- `pi-cosmic-core` supplies the managed-runtime facade/session slot, typed HTTP and document adapters, `SafeFile`, `AgentDirectory`, subscription refresh coordination, security utilities, and deterministic test Layers.
- `pi-cosmic-ui` composes config repository, narrow Pi process execution, repository probing, footer host state, and the plain-data footer protocol client.
- Better OpenAI and Better xAI compose provider-local config/auth/request schemas with the shared refresh engine and Cosmic UI client. Better xAI isolates Pi's Promise-shaped model-registry credential lookup behind `ModelRegistryAuth`. OpenAI fast-mode state and persistence are owned by `FastModeService`, with a frozen synchronous request projection and bounded diagnostic ingress. OpenAI additionally scopes image streaming, Sharp, safe input reads, and atomic output writes.
- `pi-code-previews` composes session capability, settings/environment services, scoped Shiki state, and scoped before-write state. Pure diff/layout/rendering remains outside Effect.
- `pi-advisor` composes the parent controller, review queue, child runtime, read-only filesystem, and Pi command adapter. Immediate ingestion remains a bounded synchronous projection into the controller.

No extension owns a telemetry exporter or process-wide Effect runtime.

## State and projection contract

The shared projection primitive uses `SynchronizedRef` to serialize authoritative effectful transitions and publishes cloned, deeply frozen plain-data snapshots only after transition and projection success. Better OpenAI, Better xAI, Cosmic UI, and code-preview settings/write state have adopted it while retaining synchronous renderer boundaries and pre-session snapshots. Code-preview syntax state uses one `SynchronizedRef` plus bounded ingress and publishes immutable metadata with only the current Shiki highlighter capability required by synchronous tokenization. Advisor owns immutable application-domain state separately from resources and publishes a cloned, deeply frozen controller/status snapshot before synchronous command rendering; those commands never inspect queue, runtime, or mutable controller closures. The shared bounded ingress adapter gives synchronous Pi callbacks explicit accepted, dropped, coalesced-latest, and closed results plus scoped worker cleanup. Pure reducers, formatting, parsing of already trusted values, diffing, word matching, and TUI layout stay synchronous.

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

## Quality checks

- `tsconfig.base.json` enables strict TypeScript and core Effect language-service diagnostics for every package.
- `tsconfig.effect.json` enables the workspace's Effect-native diagnostics.
- Each package declares the official `effect-language-service diagnostics` command, and the root `pnpm effect:diagnostics` command runs those package scripts recursively.
- Oxlint, package tests, packaging smoke tests, and code review cover the remaining correctness and integration concerns.
- Architecture conventions that TypeScript, Oxlint, or the Effect language service cannot express are documented guidance. The workspace does not maintain a repository-specific static analyzer or suppression ratchet.

## Upgrade procedure

1. Update all synchronized Effect packages in one commit.
2. Re-run `effect-language-service patch`.
3. Review release notes and the pinned declarations.
4. Run `pnpm effect:lsp:check` and `pnpm effect:diagnostics`.
5. Run focused tests, pack checks, benchmarks, and `pnpm validate`.
