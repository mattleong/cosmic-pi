# Cosmic Core architecture

## Purpose

`pi-cosmic-core` is publishable infrastructure shared by the extensions. It does not register a Pi extension and contains no provider- or feature-specific orchestration.

## Public surface

- Package root: managed runtime/session slot, Pi service, projections, refresh/ingress coordination, typed platform/config adapters, security helpers, and subscription formatting compatibility.
- `pi-cosmic-core/testing`: deterministic HTTP/document/lifecycle/telemetry test Layers and bounded worker polling.

## Source map

- `src/runtime/` defines Pi-owned execution boundaries (`runtime.ts`, `session-runtime.ts`, `pi-api.ts`).
- `src/coordination/` provides scoped concurrency primitives (`refresh-coordinator.ts`, `subscription-refresh.ts`, `synchronous-ingress.ts`).
- `src/platform/` contains typed Node, HTTP, document, file, process-coordination, and agent-directory adapters.
- `src/config/` contains reusable scoped-store, document-ops, and tolerant-field configuration infrastructure.
- `src/projection.ts` publishes immutable synchronous snapshots.
- `src/security.ts` owns shared redaction/sanitization.
- `src/subscription-format.ts` owns shared subscription countdown/percent/token/status-line formatting helpers.
- `src/host-session.ts` owns pure Pi host session capture helpers (UI mode, trust, cwd/signal).
- `src/usage-projection.ts` owns shared usage eligibility/clearing projection transitions.
- `src/testing/` contains multi-consumer fakes and probes only.

Public barrels (`index.ts`, `testing.ts`) re-export these modules; consumers import from `pi-cosmic-core` / `pi-cosmic-core/testing`, not internal paths.

## Dependency rule

Core may depend on Effect and platform libraries, but never on an extension package. Extension-specific policies, controllers, UI, session harnesses, and provider schemas stay in their owning package. A helper moves here only after multiple packages require the same contract.

## Lifecycle

```text
Pi session adapter -> makePiManagedRuntime -> application Layer
                  -> makePiSessionRuntimeSlot for replace/start/dispose
scoped services -> finalizers interrupt fibers and release resources
Effect state -> frozen projection -> synchronous host renderer
```

`makePiRuntime` / `makePiManagedRuntime` install `piHostLoggerLayer` (Effect's
`Logger.tracerLogger` only). Pi owns the TTY; `console.log` from Effect would corrupt the
editor/input region. Pre-session / standalone Effect runners that bypass the managed runtime
must provide the same `piHostLoggerLayer`. Packages may still install additional loggers
(for tests or file sinks) via `Logger.layer`.
