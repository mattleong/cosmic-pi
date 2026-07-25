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

Pi owns the TTY; `console.log` from Effect would corrupt the editor/input region, so no host
logger ever writes to stdout/stderr.

`makePiRuntime` / `makePiManagedRuntime` take an optional `PiHostLogTarget`. With one, they
install `piHostFileLoggerLayer`: the span-event logger plus a JSONL sink at
`<agentDirectory>/logs/<packageName>.jsonl` (mode `0o600`, append, batched, flushed when the
runtime scope closes). Without one they fall back to `piHostLoggerLayer`
(`Logger.tracerLogger` only), which has no diagnostic sink of its own because no extension owns
a span exporter. Every session runtime passes a target; pre-session / standalone runners that
bypass the managed runtime still provide the bare `piHostLoggerLayer`.

`piHostFileLoggerLayer` is deliberately `Layer<never, never, never>`. Directory resolution,
directory creation, and file opening are all absorbed into a discarding logger, so a broken log
sink can neither fail a session start nor widen the `Layer.Error` that Pi session-runtime
facades carry. `agentDirectory` is a thunk for the same reason: the Pi host resolves it lazily
and may throw, and that throw must land inside the fail-safe region.

The sink has no size bound. Anything that logs per-turn or per-request needs rotation first —
see `pi-advisor/src/logging/log.ts` for the coordinator-locked rotating pattern.
