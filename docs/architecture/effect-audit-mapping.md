# Effect v4 audit implementation mapping

This file maps the numbered migration program to the implemented ownership boundary. The detailed contracts and exceptions remain authoritative in `effect-v4.md` and `pi-boundaries.md`.

1. Behavioral baselines: package lifecycle, queue, command-snapshot, protocol, and renderer characterization tests.
2. Architecture guidance: shared TypeScript configuration, Oxlint, official Effect language-service diagnostics, and package tests.
3. Process coordination: core `ProcessCoordinator`; JSON documents and Advisor failure logs use resolved keyed locks.
4. Schema-first HTTP: typed accepted responses, raw rejected text, and schema-encoded streaming requests.
5. Tolerant configuration: core scoped store and field-level recovery adopted by providers and Cosmic UI.
6. Projection/ingress primitives: core frozen projection and bounded synchronous ingress.
7. Test infrastructure: shared deterministic document/HTTP Layers, lifecycle probe, bounded worker polling, stable telemetry snapshots, and Effect-native lifecycle tests. Session/failure/fiber helpers remain local where no identical second consumer exists.
8. xAI boundaries: refined schemas and `ModelRegistryAuth` adapter.
9. OpenAI fast mode: session-owned `FastModeService` and frozen request projection.
10. OpenAI SSE: retained sequential fiber-local parser after the documented performance/evidence gate.
11. Cosmic UI: scoped protocol host, registry resource ownership, and hostile callback isolation.
12. Code-preview settings: one serialized authority with persistence barrier and frozen projection.
13. Code-preview syntax: scoped initialization/language ownership and renderer-only Shiki projection.
14. Code-preview writes: atomic correlation state and non-destructive frozen lookup.
15. Deferred previews: measured same-thread path retained; worker creation was not justified.
16. Advisor boundaries: config/failure/notification services and typed queue errors.
17. Advisor queue: one immutable `SynchronizedRef` state owns disposal, the committed cursor, one internal-token running or cancelling entry, 16 FIFO queued entries, and wake rearming. Lifecycle calls the scoped queue factory directly; there is no queue service Layer or work `Queue`. Pure transitions return after-commit barrier, callback, worker, and completion decisions. Cancellation, reset, and disposal interrupt and join the queue worker, including runtime-abort finalizers, before replacement or request completion. A separate bounded coalesced ingress owns steering delivery, and rc.111 `getUnsafe` supplies synchronous queue properties without a second projection.
18. Advisor child runtime: child scope ownership, bounded control/event ingress, and Deferred completion bridge. The configured operation timeout bounds explicitly interruptible `AgentSession.abort()` settlement; rejection, timeout, or interruption force-detaches and synchronously disposes the child behind a reset-required gate. Timed-out creation detaches Promise ownership only after registering exact-once synchronous late cleanup, and child acquisition registers its finalizer before restoring interruption.
19. Advisor controller: one immutable `AdvisorApplicationState` owns configuration, visible-only session metrics, trajectory summaries, recovery provenance, counters, and reducer state. Pure reducers coalesce session initialization, genuine-user-request admission, cancellation, and committed configuration; `cancellationEpoch` is the sole committed-config invalidator. Host contexts, instruction paths, the last candidate, timers, queues, runtimes, and scopes remain resource-only. There is no controller projection: each command captures one readonly snapshot from one application-state read plus queue activity, orchestrator active count, and the last-candidate ref, then settings retain it across modal yields. Guarded session inputs and dynamic host methods are bounded and redacted. Checkpoints retain admission identity across restart, then use one owner generation, one full stale predicate, and one idempotent review settler; a pre-registered resource scope makes Layer/runtime publication epoch-gated before dynamic cleanup. Persistent recovery has one identity-checked pure reducer: guidance keeps delivery state and records acknowledgement, receipt, and routing; card-only keeps delivery state with open findings and no receipt; no delivery rolls dedupe and emission state back and restores the budget with correction consumed. Checkpoint cancellation remains finalizer-owned after slot deactivation, and commands plus onboarding publish authoritative config through the same JSON rename `afterCommit` path.
20. Closure: bounded redacted recovery diagnostics, Effect-native lifecycle/time tests where the subject is not a Promise host boundary, updated architecture documentation, benchmark gates, and full workspace validation.

Conditional decisions are evidence-backed rather than incomplete work: the SSE reducer and worker-thread options were deliberately not adopted because the retained implementations were clearer and stayed within the documented performance budgets.
