# Cosmic Core architecture

## Purpose

`pi-cosmic-core` is publishable infrastructure shared by the extensions. It does not register a Pi extension and contains no provider- or feature-specific orchestration. Its public barrels and `src/` tree ship as TypeScript and load through Pi/Jiti; there is no generated distribution or plain-Node package contract.

## Public surface

- Package root: managed runtime/session slot, Pi service, projections, refresh/ingress coordination, typed platform/config adapters, security helpers, and subscription formatting compatibility.
- `pi-cosmic-core/testing`: deterministic HTTP/document/lifecycle/telemetry test Layers and bounded worker polling.

## Source map

- `src/runtime/` defines Pi-owned execution boundaries (`runtime.ts`, `session-runtime.ts`, `pi-api.ts`) plus `host-bootstrap.ts`, the shared `Effect.tryPromise` adapter for best-effort Promise prerequisites. The package root exports Effect's scoped `provide` unchanged as `provideBuiltLayer` for host and test entry points. The session slot returns Effect-owned startup values only to the current activation and exposes activation state without duplicating package-local flags. Host bootstrap forwards Effect's abort signal, detaches loaders that ignore cancellation, contains late settlement, and records a redacted debug diagnostic on failure.
- `src/coordination/` provides scoped concurrency primitives (`refresh-coordinator.ts`, `subscription-refresh.ts`, `synchronous-ingress.ts`). The single-flight refresh coordinator transitions ownership and its one merged follow-up through atomic `Ref` updates. Subscription polling uses an rc.111 `Latch` pulse, so `release` wakes only pollers already awaiting it and does not retain early wakes. Subscription validation and commit share a fiber-reentrant transactional lock.
- `src/platform/` contains typed Node, HTTP, document, file, process-coordination, bounded child-process, and agent-directory adapters. `nodeProcessLayer` is an opt-in capability and is never merged into the file or network platform Layers. `node-builtins.ts` is the single raw Node builtin door (`process.getBuiltinModule`) for SafeFile's `O_NOFOLLOW` opens and bigint inode identity checks plus the pure synchronous containment helpers; Effectful SafeFile normalization uses the injected `Path.Path` service. The bounded process adapter exposes normalized exit evidence and owns detached spawning, output limits, process-group termination, force escalation, and scoped cleanup. Schema-document decode failures expose only bounded, sanitized issue paths and never rejected values. Atomic JSON modifications may return `write: false` to complete a lock-protected comparison without creating or rewriting a document or running an after-commit hook.
- `src/config/` contains reusable scoped-store, document-ops, and tolerant-field configuration infrastructure.
- `src/projection.ts` publishes immutable synchronous snapshots, rejecting non-finite numbers and true object cycles with typed paths while preserving acyclic shared references.
- Core code uses exact `effect/Predicate` variants where a named refinement helps. `src/runtime-values.ts` keeps the public object-or-null guard and runtime type-name classifier as direct `typeof` compatibility helpers.
- `src/security.ts` owns shared redaction/plain terminal sanitization. Its JWT helper decodes only the second segment with Effect `Encoding` and `Result`, accepts padded or unpadded Base64URL, ignores later signature segments, and returns `undefined` for a missing or invalid payload. `extractJwtClaim` layers a from-string payload schema on that helper and `redactedTokenSchema` builds the shared `Redacted` OAuth-token field schema with a caller-provided label. `src/security/terminal-styled.ts` owns linear per-channel parsing and bounded safe visual-SGR preservation for terminal log UIs that must strip every active control sequence.
- `src/settings-completion.ts` owns pure `/…-settings` argument completion (`completeSettingsArguments`): descriptor-ordered id matching, caller-supplied extra verbs, case-insensitive prefixes (ids match case-insensitively in both stages), and the `null`-on-no-match host contract. It also owns the write-side settings family: `SettingsOptionDescriptor` with its JSON-string field schemas, the `InvalidSettingError` contract, and the `decodeSettingUpdate` factory that decodes one settings update into a document patch (`sectionSettingValue` composes the dotted-id patch). It has no UI dependency.
- `src/settings-dispatch.ts` owns pure `/…-settings` argument dispatch (`dispatchSettingsCommand`): a closed OpenInteractive/Help/Diagnostics/Apply/Invalid tagged result with exact finite-value matching and no hidden verb aliases. Hosts own all side effects and message wording; it has no host dependency.
- `src/subscription-format.ts` owns shared subscription countdown/percent/token/status-line formatting helpers.
- `src/host-session.ts` owns pure Pi host session capture helpers (UI mode, trust, cwd/signal). Trust fails closed unless a captured callback returns literal `true`; absent, malformed, false, or throwing host values are untrusted. Best-effort notifications contain synchronous host failures and use pinned `Predicate.isPromiseLike` to attach rejection handlers to returned object or callable thenables.
- `src/usage-projection.ts` owns shared usage eligibility/clearing projection transitions. `src/usage-controller.ts` captures exactly the shared `Path.Path`, `JsonDocumentStore`, `JsonHttpClient`, and `Tracer.Tracer` services in one explicit `Context` pinned onto effects that escape the construction Layer. `UsageRefreshControllerOptions` intentionally takes a provider-only `Context` instead of the former provision callback. The captured shared context is merged second so it overrides provider key collisions; the controller never captures the whole ambient context. The exported `UsageControllerStore<Resolved, E>` remains an unconstrained structural compatibility contract. Controller construction checks it against a private metadata-constrained `ScopedConfigStore` operation set. `synchronizeState` is optional: when omitted, the controller composes eligibility with `withUsageEligibility` and its `hiddenStatusText`. `timedDiagnosticResult` bounds one provider diagnostic fetch at the shared 10-second deadline and maps failures and timeouts onto a sanitized `Result<A, string>`.
- `src/usage-controller.ts` accepts the presentation owner's background-request policy independently of provider config. Hidden usage skips automatic requests; explicit notified requests still fetch. Visibility participates in the refresh key, preventing late results from restoring hidden usage. Core owns no custom-footer renderer.
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
