# Effect v4 architecture

## Definition

Cosmic-pi is Effect-first. Effect owns application lifecycle, dependencies, failures, concurrency, resources, state transitions, clocks, configuration, persistence, HTTP, logging, and tests. Pure deterministic functions remain pure and may use Effect data modules when they improve the model.

## Code conventions

- Import Effect modules through explicit namespace subpaths, for example `import * as Effect from "effect/Effect"`.
- Declare services as classes with `Context.Service` and deterministic language-service keys.
- Give every live implementation an explicit Layer. Compose the dependency graph before providing it.
- Use `Layer.effect` with `Effect.acquireRelease` for layer-owned scoped resources.
- Use `Effect.sync` only for operations that are total by contract. Wrap hostile or throwing
  synchronous callbacks with `Effect.try` and a schema-backed boundary error, then recover that
  typed failure deliberately where the host callback is best effort.
- Use `Effect.promise` only when rejection is impossible by contract. Ordinary third-party and
  Node Promises use `Effect.tryPromise`; cleanup failures are mapped to a redacted typed error
  before they are propagated or deliberately recovered.
- Register a resource finalizer only after acquisition establishes ownership. Generated names,
  candidate paths, and other intentions to acquire are not resources; exclusive file creation,
  opened handles, subscriptions, and child scopes are. For an ownership claim, install its
  settlement handler before admission, with no-op cleanup while unclaimed, or narrowly mask the
  claim-to-handler handoff. Permit waiting and driver work remain interruptible.
- Default host and third-party Promises to interruptible. An ordered finalizer or irreversible
  commit region may be uninterruptible only when it is narrowly documented, ownership is already
  established, exact-once state publication is included, and the liveness tradeoff is explicit.
  A memoized cleanup must protect the returned cached effect's first-caller handoff as well as
  its body; otherwise interruption can become the permanent cached outcome before cleanup starts.
  When a foreign API cannot be cancelled and ordering does not require waiting for settlement,
  detach Effect ownership on interruption and arrange safe late cleanup instead of blocking scope
  closure indefinitely.
- Keep implementation-only requirements in Layer construction rather than leaking them through service methods.
- Use `Schema.decodeUnknownEffect` at unknown boundaries. Do not cast decoded JSON. Core JSON HTTP requests require a provider-local response decoder and return an accepted typed body or a rejected status with preserved response text; no public `body: unknown` path exists.
- Represent expected failures with schema-backed tagged errors. Reserve defects for violated invariants.
- Use `Clock`, `Duration`, `Random`, `Config`, `Logger`, queues, deferred values, semaphores, refs, schedules, streams, and scopes instead of corresponding unmanaged globals.
- Create one `ManagedRuntime` from `session_start` at the Pi host boundary. Internal services never call Effect runners.
- The shared Pi session-runtime slot is the minimal imperative island: it creates, replaces, and disposes the runtime that cannot own its own creation. Everything acquired after runtime construction is scoped inside Effect. Startup returns any host activation value through the slot; only the current generation receives it in `onActivated`, so packages do not use temporary mutable mailboxes for scoped services or initial projections.
- Production session-runtime facades carry the exact `Layer.Error` type and never cast a returned
  Fiber to erase initialization failure. Exported compatibility types may default an omitted
  error argument to conservative `unknown`, but every workspace call site supplies the exact type;
  no runtime error may be defaulted or asserted to `never`.
- Dispose runtimes and close session resources explicitly.
- Effect services own state transitions in `Ref` or `SynchronizedRef`. When Pi requires synchronous rendering, services atomically publish immutable snapshots to a boundary `MutableRef`; renderers only read those snapshots.
- Cosmic UI has one narrow synchronous-state exception: its footer contribution registry and working row are presentation state driven only by synchronous Pi events, and their only effect is a guarded host UI write. They may hold plain state instead of an Effect service, but they read time only through core's synchronous clock boundaries (`synchronousNow` for wall timestamps, `synchronousMonotonicNow` for durations) and repaint only through the shared host ticker pool.
- A service may instead hold plain mutable state (`Map`, counters) behind a `Semaphore`
  when the state is a keyed registry that a single `Ref` would serialize too coarsely.
  That choice carries one invariant the type system cannot enforce: **every read-modify-write
  that spans a yield point must hold the lock for its whole duration**. Re-validate after any
  `await` — guards checked before an RPC are stale once it returns. `SubagentService` and
  `BackgroundTaskService` use this pattern; new services should prefer `SynchronizedRef`
  unless they have the same shape.
- Shared refresh admission stays masked from owner registration through cleanup installation. Owner work and joiner waiting remain interruptible; identity-checked cleanup settles the shared Deferred and releases admission on interruption.
- Keep stale-result validation, its commit, and consumer context/configuration invalidation
  inside the same serialized transition. Likewise, persistence, private state replacement, and
  projection publication share one commit whenever interruption or concurrent callers could
  otherwise separate them. Publishing inside an effectful `SynchronizedRef` modification callback
  alone does not protect the backing assignment that follows the callback.
- For atomic file replacement, complete creation, writing, validation, and permissions before a
  narrow uninterruptible rename commit. Nothing fallible follows the rename; owned temporary
  cleanup is best effort and cannot change the committed result.
- Prefer explicit one-argument callbacks such as `Effect.map((value) => decode(value))` over tacit
  higher-order use when a function is overloaded, generic, or accepts optional extra arguments.
- Add spans around provider requests, refreshes, image streams, and resource initialization without recording secrets.

## Version policy

Jointly released Effect packages use synchronized exact catalog pins in `pnpm-workspace.yaml`. Independently versioned tooling is pinned separately. Do not use ranges or moving tags for these dependencies. The workspace pins stable `4.0.0`; use its published domain subpaths (`effect/http`, `effect/process`, `effect/rpc`, `effect/socket`, and `effect/encoding`), not the former `effect/unstable/*` paths. Domain APIs may still be marked unstable within a stable release, so review their pinned declarations on upgrades. Keep Effect upgrades isolated and run the full validation gate.

## V4 API rules

Use Effect v4 documentation; pinned declarations are the source of truth when documentation disagrees:

- Services are `Context.Service`, not `ServiceMap.Service`.
- Schema-backed yieldable errors use `Schema.TaggedError`; the earlier `Schema.TaggedErrorClass` name was removed before the RC.
- Layer-owned resources use `Layer.effect` with `Effect.acquireRelease`; there is no `Layer.scoped` constructor.
- `ManagedRuntime.make(layer, { memoMap })` uses an options object.
- Pass parser policy (for example `onExcessProperty: "error"`) explicitly to schema decoders; `parseOptions` annotations no longer apply that policy.
- `Effect.partition` returns successes first, then failures.
- HTTP is imported from `effect/http` and provided separately by a Node HTTP layer. Streaming JSON bodies are encoded through a caller-supplied Codec; true streaming responses expose explicitly named raw bytes and discard operations.
- `@effect/vitest` v4 requires Vitest 5 and provides `it.effect`, `it.live`, and `layer`; it does not provide the older `it.scoped` helpers.

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
- `pi-cosmic-ui` composes its config store, narrow Pi process execution, project probing, footer host state, and the plain-data footer protocol client. Its session-scoped activity registry consumes checked provider capabilities and detached summaries, owns bounded history and the display clock, and publishes the unified persistent tree and `/activity` manager. Feature packages retain authoritative agent, process, and questionnaire state.
- Better OpenAI composes provider-local config and request schemas with the shared refresh engine and Cosmic UI client. It reads subscription credentials only through Pi's model registry, which owns refresh and persistence. OpenAI fast-mode state and persistence are owned by `FastModeService`, with a frozen synchronous request projection and bounded diagnostic ingress returned only through current-session activation. OpenAI additionally scopes image streaming, Sharp, safe input reads, and atomic output writes.
- `pi-code-previews` composes session capability, settings/environment services, scoped Shiki state, before-write state, and animation scheduling. One factory-time public renderer resolver handles builtin/native codemode/MCP and separately source-admitted third-party presentation; originating owner tokens bind replay readiness, captured appearance and scheduler retirement. Pi independently owns native managers, factories, authentication, connections, execution and result storage. Write alone registers a genuine before-write execution hook; owned questionnaire/task/subagent/image definitions keep their normal registrations. Pure diff/layout/rendering remains outside Effect. Pi 1.0.1 is the minimum and 1.0.2 is tested; standalone `pi-mcp-previews` is retired and existing installations require manual removal.
- `pi-ask-user` composes a serialized questionnaire service, a private bounded async registry under that same service, abort-aware TUI/RPC boundaries, pure dialog presentation, scoped external editing, and cooperative questionnaire renderers. Async presenters and delivery fibers belong to a captured child scope, not a tool signal. Separate mount and completion Deferreds distinguish opening from answering; atomic waiter claims suppress automatic custom-message delivery while an await owns the answer. A final interruptible, owner-checked transition acknowledges delivery and releases the claim atomically, without tentative acknowledgement or late rollback. Interruption before that transition preserves delivery; cancellation afterward cannot revoke it. Failed sends retry at most twice through scoped sleeps; only unclaimed terminal entries marked `sent` or `waiter` can be evicted, including explicitly acknowledged failed openings. `sent` means host submission, not model acknowledgement. Tree navigation replaces the runtime, and context filtering uses active-branch custom-entry receipts, not answer messages, to preserve historical delivery while rejecting late revoked messages across repeated activations.
- `pi-background-task` composes a session-scoped task registry, child-process boundary, bounded log buffers, cooperative tool renderer, and synchronous manager projection.
- `pi-subagents` composes a session-scoped three-driver local Pi/Claude/Codex run registry, bounded RPC/JSONL/IPC/native-supervisor boundaries, parent-owned cwd writer pools over cross-process leases, cooperative exact-file claims for unchanged native tools and Bash, structured event timelines, report-generation delivery, cooperative tool renderers and local Pi proxies, and synchronous fleet projection. Subtree stop claims every target and its parent-stop flag, then forks the complete leaf-first traversal into the session scope before restoring caller interruption. Cancelling a waiter cannot abandon later targets. `WorkspaceService` serializes durable writer artifacts, immutable original-baseline revisions, and combined test preparations through the Git boundary. The coordinator owns session-wide worktree/shared-checkout admission, authenticated direct-parent review of exact revisions, and explicit source leases during uncommitted integration. Backend process cleanup and artifact disposal are separate lifecycles; stopping a writer or replacing its session does not discard its proposal or establish recovery authority over old artifacts. Its current package-level design is indexed from [`packages/pi-subagents/ARCHITECTURE.md`](../../packages/pi-subagents/ARCHITECTURE.md).

No extension owns a telemetry exporter or process-wide Effect runtime. Sharp decoding has one module-private immediate semaphore across session runtimes, not a global runtime. Its fixed packaged `.mjs` helper owns native decoding in a one-shot process; the session holds admission through confirmed process cleanup.

## State and projection contract

The shared projection primitive serializes a private authoritative `Ref` with a private `Semaphore`. Lock waiting, transition work, and cloned, deeply frozen snapshot preparation remain interruptible. External publication, internal snapshot publication, and authoritative state replacement share one narrow uninterruptible commit; rejected preparation or publication leaves state and the internal snapshot unchanged. Better OpenAI, Cosmic UI, code-preview settings/write state, background-task state, and subagent runs publish immutable snapshots while retaining synchronous renderer boundaries and pre-session snapshots. Better OpenAI and Cosmic UI revoke each session's publication authority synchronously before cleanup. Already-admitted durable commits may finish updating private state, but cannot republish a cleared boundary projection or call the retired owner's host callbacks. Authority checks run in the same synchronous callback as publication or delivery, not before a yielded Effect or Promise continuation. Immutable log events and frozen cached slices may be structurally shared; projection envelopes and scalar rows still detach and freeze. Code-preview syntax state uses one `SynchronizedRef` plus bounded ingress and publishes immutable metadata with only the current Shiki highlighter capability required by synchronous tokenization. Pure reducers, formatting, parsing of already trusted values, diffing, word matching, and TUI layout stay synchronous.

## Observability contract

Two things emit spans, and they use different names on purpose:

- `Effect.withSpan` marks a **stable operation boundary**. These names are package-prefixed
  (`pi-<package>.<area>.<operation>`), are treated as a public observability surface, and the
  required families below must keep their exact names.
- `Effect.fn("Name.method")` marks an **internal function boundary**, named after the service
  and method it wraps. These are diagnostic aids, not a contract; renaming one alongside its
  function is an ordinary refactor. `Effect.fnUntraced` creates neither an Effect stack-frame
  boundary nor a span. Apply `Effect.withSpan` separately when a stable span is required.

Do not convert between the two to satisfy a naming rule. If an internal boundary becomes
something operators depend on, promote it deliberately: give it a package-prefixed
`Effect.withSpan` and add it to the required families.

Required `withSpan` families are:

- `pi-cosmic-core.runtime.startup`, `pi-cosmic-core.http.{json,streaming}.*`, and `pi-cosmic-core.safe-file.initialize`;
- `pi-better-openai.usage.{initialize,refresh}`;
- `pi-better-openai.image.{request,stream,convert,write}`;
- `pi-cosmic-ui.probe.{git,pull-request}`;
- `pi-code-previews.shiki.initialize`;

Only bounded enums, counts, methods, and status codes may be attributes. URLs, paths, prompts, bodies, credentials, auth values, account/team identifiers, and raw errors are forbidden. The core HTTP adapters disable the upstream client's URL-bearing automatic span and emit safe workspace spans instead. Unknown diagnostics pass through shared redaction before they reach logs or projections.

## Dependency layout

Compiler tooling lives at the workspace root. Runtime dependencies are declared directly by every package that imports them, using the synchronized pnpm catalog. Every Cosmic Pi package publishes and runs TypeScript source through Pi/Jiti; there are no generated package distributions or prerequisite builds. TypeScript projects use ESNext/Bundler resolution. Packages that consume source containing constructor parameter properties explicitly relax `erasableSyntaxOnly`; the stricter workspace default remains in force elsewhere. `pi-cosmic-core` is a normal publishable source package and does not register a Pi extension.

## Quality checks

- `tsconfig.base.json` enables strict TypeScript and configures core Effect language-service diagnostics for every package.
- `tsconfig.effect.json` enables the workspace's Effect-native diagnostics. `strictEffectProvide` applies to production `src/**/*.ts`; tests are Effect entry points that intentionally provide complete test Layers.
- Each package declares the official `effect-tsgo diagnostics` command, and the root `pnpm effect:diagnostics` command runs those package scripts recursively. TypeScript typechecking and Effect diagnostics stay as separate gates so Effect messages are not emitted twice.
- Oxlint, package tests, packaging smoke tests, and code review cover the remaining correctness and integration concerns.
- Narrow repository guards complement these tools: `pnpm layout:check` checks package/test placement and rejects nested package manifests; `pnpm diagnostics:guard` rejects source suppressions and disabled diagnostic configuration. Other architecture conventions remain documented guidance, not a custom architecture analyzer.

## Upgrade procedure

1. Update all synchronized Effect packages in one commit.
2. Update `@effect/tsgo` to a release that supports the pinned TypeScript version.
3. Review release notes and the pinned declarations.
4. Run `pnpm typecheck` and `pnpm effect:diagnostics`.
5. Run focused tests, pack checks, benchmarks, and `pnpm validate`.
