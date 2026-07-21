# Pi and platform boundaries

Effect application code is separated from APIs that Pi or third-party libraries require in another shape.

## Approved boundaries

### Pi registration

Extension factories only register callbacks; they do not acquire background resources. `session_start` creates one managed runtime for the started session, and callbacks delegate to it. A callback may pass Pi's `AbortSignal` to the runtime. The runtime is never recreated per event or command. Runtime creation cannot be owned by the runtime being created, so `pi-cosmic-core` provides one small host-boundary session slot for generation checks, replacement, abort-listener removal, and idempotent disposal; it owns no application polling or state.

### Shutdown

The Pi lifecycle boundary disposes the runtime and interrupts session fibers. Finalizers own timers, subscriptions, streams, file handles, HTTP agents, child sessions, and cached resources.

### Synchronous TUI rendering

Pi render methods remain synchronous. Better OpenAI, Better xAI, Cosmic UI, and code-preview services own state transitions and publish deeply frozen plain snapshots; their renderers only read synchronous projections. Code previews expose one narrowly documented exception: the current Shiki highlighter is a third-party synchronous render capability paired with immutable generation/theme/language metadata. Initialization, language loading, callbacks, replacement, and disposal remain Effect-owned. Advisor publishes its controller state through a deeply frozen synchronous projection; checkpoint and status resource handles never enter that snapshot. Synchronous renderer entrypoints should not import Effect runtimes, full services, or session capabilities. A renderer must not build a Layer, read an effectful Ref, or run an Effect.

### Tool schemas

Pi tool parameter declarations may use TypeBox or literal JSON Schema. Tool execution delegates to Effect immediately. This exception applies to schema representation, not implementation logic.

### Third-party libraries

Promise/callback libraries such as Pi APIs, Sharp, and Shiki are wrapped once with the appropriate Effect constructor in a named adapter. Their native errors are translated into typed domain failures.

### Cross-extension events

Cosmic UI events carry plain data and explicitly checked function capabilities. Providers import the narrow `pi-cosmic-ui/protocol` and `pi-cosmic-ui/client` subpaths, never the extension root. Events never carry Effect services, Layers, refs, scopes, fibers, or runtimes. The host answers discovery synchronously and retains a bounded, ordered pre-session event buffer; once a session starts, `FooterProtocolHost` drains it into a scoped ingress worker. `FooterRegistryService` serializes contribution state, owns surface child scopes and exact-once detach/dispose finalizers, and publishes only a frozen contribution snapshot plus checked render capabilities. Hostile callbacks are isolated by operation name, and bounded diagnostics never retain callback errors or payloads.

## Imperative boundaries

Effect runners are intentionally localized to these call owners:

- `pi-cosmic-core/src/runtime.ts`: the raw managed runtime is narrowed to `run`, `fork`, `runSync`, and idempotent `dispose`;
- `pi-code-previews/src/boundary/settings-one-shot.ts`: the named serialized pre-session public settings compatibility adapter;
- `pi-advisor/src/boundary/executor.ts`: the named Pi/compatibility adapter used at host and test boundaries.

Direct filesystem imports are limited to core `SafeFile` and advisor's two narrow read-only Node adapters. Process, network, worker, VM, and child-process Node modules are rejected outside exact adapters. Reflected environment reads are currently limited to code-preview's environment and serialized one-shot settings boundaries. Raw JSON compatibility boundaries are limited to the named advisor and code-preview JSON adapters. Provider HTTP boundaries cannot expose unknown JSON bodies: provider-local schemas decode accepted JSON responses, rejected responses preserve status and response text without entering errors or telemetry, and streaming JSON requests are schema-encoded before explicitly named raw response bytes reach protocol parsers. Pi's Promise-returning xAI model-registry lookup is isolated by the typed `ModelRegistryAuth` Layer. TypeBox is limited to Pi's advisor tool parameter schema. These locations document the current integration boundaries; changes should be justified in review. All package-local runtime facades were removed.

### Code-preview write and deferred-render boundaries

Before-write correlation is owned by a serialized Effect projection. Tool result rendering performs a non-destructive lookup in a bounded, deeply frozen snapshot so duplicate renders and call-ID reuse remain deterministic; explicit Effectful acknowledgement is available to the owning service rather than being performed by a renderer. Pi's cross-tool `withFileMutationQueue` remains the outer lock and is acquired before the package-local Effect path lock. The former coordinates all Pi file tools; the latter protects the read-before-write/write/correlation transaction inside this extension. Removing either requires integration evidence that cross-tool ordering and local correlation remain atomic.

The public `AsyncPreview` compatibility name now delegates to accurately named deferred same-thread publication. No worker was added: the checked baseline used five `bench:render-boundaries` runs whose representative 250-line diff CPU medians were 6.109–6.346 ms (committed median 6.329 ms) and cancellation publication medians were 2.653–3.033 ms. The harness now performs three warmups plus nine raw timed samples, reports both sample lists and medians, and fails when the diff median exceeds the committed baseline by more than 10%; absolute 50 ms CPU and 100 ms cancellation budgets remain secondary responsiveness guards. The work is pure but a live Theme/TUI result and Shiki capability are not serializable; worker transfer would add complexity without an observed responsiveness problem. Reconsider only if profiling exceeds the blocking budget and a serializable preparation phase improves it without more than a 10% median render regression.

### Advisor synchronous admission and resource ownership

Advisor preserves synchronous Pi admission for observation ordering, cancellation latching, `AgentSession.followUp`, and status ownership. These callbacks only capture bounded/redacted plain data or flip a synchronous generation latch; checkpoint sequencing and cancellation finalization are owned by `CheckpointOrchestrator`, while `AdvisorStatusService` owns delayed/animated status fibers and exact replacement cleanup. Child replacement, reprime, cancellation, and disposal serialize lifecycle detachment and await the third-party `AgentSession.abort()` Promise without a timeout; disposal is ensured even when abort rejects or throws. Startup still reports its configured timeout promptly, but unresolved `createSession` work leaves a lifecycle-owned cleanup barrier: replacement and shutdown wait for late creation, abort settlement, and exact-once disposal before proceeding. This deliberately permits later lifecycle work to wait indefinitely rather than overlap a replacement with an active child finalizer. Semantically asynchronous continuations run in the scoped session runtime. No host callback launches a detached snapshot-publication fork.

### Advisor queue benchmark gate

The Advisor queue benchmark uses three reduced warmups followed by seven full samples (100,000 synchronous ingestions and 500 correlated checkpoints per sample), reports every raw per-operation sample, and compares medians with committed pre-cutover reference-machine baselines of 8.65 µs/ingestion and 0.0475 ms/checkpoint. It fails above 110% of either baseline. These figures are a same-machine regression ratchet rather than portable hardware targets; a failure on materially different hardware must be reproduced against a fresh pre/post baseline on that machine, never waived from one noisy cold sample.

### OpenAI image SSE evidence gate

The image SSE parser remains a sequential fiber-local parser rather than being rewritten into a Stream reducer. Five baseline runs of `vitest run tests/image.test.ts` had focused test times of 132–142 ms (median 133 ms); five post-provider-cutover runs had a 131–140 ms range (median 136 ms, +2.3%). Its bounded buffer, CR/LF state, event assembly, byte limits, and terminal state are local to one consuming fiber, while the response Stream and finalization are already Effect-owned. A reducer rewrite would add allocation and obscure early terminal/cancellation handling without eliminating shared mutation. The characterized suite covers split CRLF, comments, multiline data, `[DONE]`, completed images, provider failures, limits, interruption, and stream finalization. Reconsider only with a clearer implementation whose median regression is at most 10%.

The remaining unsafe Effect calls are localized and documented. The sole process-global `Semaphore.makeUnsafe` occurrence is the core keyed process coordinator: a Layer-local semaphore cannot serialize access to the same file across independently built extension runtimes. JSON-document updates and Advisor failure-log rotation use that coordinator with resolved path keys, and idle key entries are removed after their final user exits. The shared core synchronous-ingress adapter owns exactly one `Queue.offerUnsafe` call; it exposes only bounded plain-data offer results (`accepted`, `dropped`, `coalesced`, or `closed`) while a scoped Effect fiber drains work. Advisor uses that adapter for its capacity-one, coalesced child-runtime control mailbox and has no package-local unsafe Queue offer. Parent host admission and checkpoint cancellation no longer use closure-owned callback sets. Validated `DateTime.makeUnsafe` conversions and the advisor clock boundary's `Fiber.interruptUnsafe` calls are likewise intentional integration points that should remain narrow.

## Forbidden internal boundaries

Application services must not:

- call `Effect.run*` or a managed runtime,
- construct unmanaged Promises or timers,
- use global fetch or direct filesystem I/O,
- expose native `Error` or `unknown` in an Effect error channel,
- leak implementation service requirements through public methods.

## Advisor security

Advisor's read-only filesystem capability receives only the narrow filesystem and path Layers it needs. It must not receive an aggregate Node services Layer because that Layer also exposes process-spawning capabilities. Its exact no-process and no-mutation guarantee remains independently tested.
