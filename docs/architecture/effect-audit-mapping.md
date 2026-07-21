# Effect v4 audit implementation mapping

This file maps the numbered migration program to the implemented ownership boundary. The detailed contracts and exceptions remain authoritative in `effect-v4.md` and `pi-boundaries.md`.

1. Behavioral baselines: package lifecycle, queue, projection, protocol, and renderer characterization tests.
2. Architecture guidance: shared TypeScript configuration, Oxlint, official Effect language-service diagnostics, and package tests.
3. Process coordination: core `ProcessCoordinator`; JSON documents and Advisor failure logs use resolved keyed locks.
4. Schema-first HTTP: typed accepted responses, raw rejected text, and schema-encoded streaming requests.
5. Tolerant configuration: core scoped repository and field-level recovery adopted by providers and Cosmic UI.
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
17. Advisor queue: bounded Effect queues, atomic queue state, and scoped steering ingress. Cancellation, reset, and disposal interrupt and join the queue worker—including runtime-abort finalizers—before replacement or completion.
18. Advisor child runtime: child scope ownership, bounded control/event ingress, and Deferred completion bridge. Replacement, reprime, cancellation, and disposal await `AgentSession.abort()` settlement exactly; rejection is isolated only after settlement and disposal is ensured.
19. Advisor controller: one immutable `AdvisorApplicationState` owns configuration, pause/start flags, metrics, trajectory summaries, recovery provenance, counters, and reducer state. Every nested metrics update clones and replaces the snapshot through the state store; host contexts, timers, queues, runtimes, and scopes remain resource-only. Queue summaries are first committed as plain state before the frozen synchronous projection is published.
20. Closure: bounded redacted recovery diagnostics, Effect-native lifecycle/time tests where the subject is not a Promise host boundary, updated architecture documentation, benchmark gates, and full workspace validation.

Conditional decisions are evidence-backed rather than incomplete work: the SSE reducer and worker-thread options were deliberately not adopted because the retained implementations were clearer and stayed within the documented performance budgets.
