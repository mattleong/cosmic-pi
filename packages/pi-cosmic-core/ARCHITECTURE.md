# Cosmic Core architecture

## Purpose

`pi-cosmic-core` is publishable infrastructure shared by the extensions. It does not register a Pi extension and contains no provider- or feature-specific orchestration. Its public barrels and `src/` tree ship as TypeScript and load through Pi/Jiti; there is no generated distribution or plain-Node package contract.

## Public surface

- Package root: managed runtime/session slot, Pi service, projections, refresh/ingress coordination, typed platform/config adapters, security helpers, and subscription formatting compatibility.
- `pi-cosmic-core/testing`: deterministic HTTP/document/lifecycle/telemetry test Layers and bounded worker polling.

## Source map

- `src/runtime/` defines Pi-owned execution boundaries (`runtime.ts`, `session-runtime.ts`, `pi-api.ts`).
- `src/coordination/` provides scoped concurrency primitives (`refresh-coordinator.ts`, `subscription-refresh.ts`, `synchronous-ingress.ts`); the single-flight refresh coordinator serializes ownership and its one merged follow-up through `SynchronizedRef`.
- `src/platform/` contains typed Node, HTTP, document, file, process-coordination, and agent-directory adapters. Schema-document decode failures expose only bounded, sanitized issue paths and never rejected values.
- `src/config/` contains reusable scoped-store, document-ops, and tolerant-field configuration infrastructure.
- `src/projection.ts` publishes immutable synchronous snapshots, rejecting non-finite numbers and true object cycles with typed paths while preserving acyclic shared references.
- Consumers use `effect/Predicate` directly for primitive runtime refinements. `src/runtime-values.ts` retains only the composite object-or-null check and exact runtime type-name classifier that have no single Predicate equivalent.
- `src/security.ts` owns shared redaction/plain terminal sanitization; `src/security/terminal-styled.ts` owns linear per-channel parsing and bounded safe visual-SGR preservation for terminal log UIs that must strip every active control sequence.
- `src/settings-completion.ts` owns pure `/…-settings` argument completion (`completeSettingsArguments`): descriptor-ordered id matching, caller-supplied extra verbs, case-insensitive prefixes (ids match case-insensitively in both stages), and the `null`-on-no-match host contract. It has no UI dependency.
- `src/settings-dispatch.ts` owns pure `/…-settings` argument dispatch (`dispatchSettingsCommand`): a closed OpenInteractive/Help/Diagnostics/Apply/Invalid tagged result with exact finite-value matching and no hidden verb aliases. Hosts own all side effects and message wording; it has no host dependency.
- `src/subscription-format.ts` owns shared subscription countdown/percent/token/status-line formatting helpers.
- `src/host-session.ts` owns pure Pi host session capture helpers (UI mode, trust, cwd/signal). Trust fails closed unless a captured callback returns literal `true`; absent, malformed, false, or throwing host values are untrusted.
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

The host log is rotated at session start after it reaches the 1 MB threshold; it has no
in-session hard cap. High-volume feature logs still need their own bounded or rotating sink — see
`pi-advisor/src/logging/log.ts` for the coordinator-locked rotating pattern.
