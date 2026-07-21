# Cosmic Core architecture

## Purpose

`pi-cosmic-core` is publishable infrastructure shared by the extensions. It does not register a Pi extension and contains no provider- or feature-specific orchestration.

## Public surface

- Package root: managed runtime/session slot, Pi service, projections, refresh/ingress coordination, typed platform/config adapters, security helpers, and subscription formatting compatibility.
- `pi-cosmic-core/testing`: deterministic HTTP/document/lifecycle/telemetry test Layers and bounded worker polling.

## Source map

- `src/runtime.ts`, `src/session-runtime.ts`, and `src/pi-api.ts` define Pi-owned execution boundaries.
- `src/platform/` contains typed Node, HTTP, document, file, process-coordination, and agent-directory adapters.
- `src/config/` contains reusable scoped/tolerant configuration infrastructure.
- `src/projection.ts` publishes immutable synchronous snapshots.
- `src/refresh-coordinator.ts`, `src/subscription-refresh.ts`, and `src/synchronous-ingress.ts` provide scoped concurrency primitives.
- `src/security.ts` owns shared redaction/sanitization.
- `src/testing/` contains multi-consumer fakes and probes only.

## Dependency rule

Core may depend on Effect and platform libraries, but never on an extension package. Extension-specific policies, controllers, UI, session harnesses, and provider schemas stay in their owning package. A helper moves here only after multiple packages require the same contract.

## Lifecycle

```text
Pi session adapter -> makePiManagedRuntime -> application Layer
                  -> makePiSessionRuntimeSlot for replace/start/dispose
scoped services -> finalizers interrupt fibers and release resources
Effect state -> frozen projection -> synchronous host renderer
```
