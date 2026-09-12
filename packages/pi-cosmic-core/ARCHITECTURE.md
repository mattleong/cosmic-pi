# Cosmic Core architecture

## Purpose

`pi-cosmic-core` is publishable infrastructure shared by the extensions. It does not register a Pi extension and contains no provider- or feature-specific orchestration. Its public barrels and `src/` tree ship as TypeScript and load through Pi/Jiti; there is no generated distribution or plain-Node package contract.

## Public surface

- Package root: managed runtime/session slot, Pi service, projections, refresh/ingress coordination, typed platform/config adapters, security helpers, and subscription formatting compatibility.
- `pi-cosmic-core/testing`: deterministic HTTP/document/lifecycle/telemetry test Layers and bounded worker polling.

## Source map

- `src/runtime/` defines Pi-owned execution boundaries (`runtime.ts`, `session-runtime.ts`, `pi-api.ts`) plus `host-bootstrap.ts`, the shared `Effect.tryPromise` adapter for best-effort Promise prerequisites. The package root exports Effect's scoped `provide` unchanged as `provideBuiltLayer` for host and test entry points. The session slot returns Effect-owned startup values only to the current activation and exposes activation state without duplicating package-local flags. Host bootstrap forwards Effect's abort signal, detaches loaders that ignore cancellation, contains late settlement, and records a redacted debug diagnostic on failure.
- `src/coordination/` provides scoped concurrency primitives (`refresh-coordinator.ts`, `subscription-refresh.ts`, `synchronous-ingress.ts`). The single-flight refresh coordinator transitions ownership and its one merged follow-up through atomic `Ref` updates. Registration through cleanup installation is masked; owner work and joiner waiting remain interruptible. Identity-checked cleanup settles the shared Deferred and permits reuse even when admission is interrupted. Subscription polling uses an rc.112 `Latch` pulse, so `release` wakes only pollers already awaiting it and does not retain early wakes. Subscription validation and commit share a fiber-reentrant transactional lock.
- `src/platform/` contains typed Node, HTTP, document, file, process-coordination, bounded child-process, and agent-directory adapters. `nodeProcessLayer` is an opt-in capability and is never merged into the file or network platform Layers. `node-builtins.ts` is the single raw Node builtin door (`process.getBuiltinModule`) for SafeFile's `O_NOFOLLOW` opens and bigint inode identity checks, pure synchronous containment helpers, and duplex child spawning; Effectful SafeFile normalization uses the injected `Path.Path` service. The bounded process adapter exposes normalized exit evidence and owns detached spawning, output limits, process-group termination, force escalation, and scoped cleanup. Its optional `onCleanup` observer receives explicit exit confirmation during scope finalization on success, failure, and interruption. Kill success alone is insufficient; confirmation checks the acquired handle's exit-backed running state. Failed acquisition reports uncertainty because the platform may own a child before returning a handle. Confirmation has a deadline, but the platform's subsequent finalizer may still wait for OS exit. Schema-document decode failures expose only bounded, sanitized issue paths and never rejected values. Atomic JSON modifications may return `write: false` to complete a lock-protected comparison without creating or rewriting a document or running an after-commit hook.
- `src/http/headers.ts` owns pure case-insensitive header merging shared by Advisor and OpenAI compaction. Later sources win with their casing; null deletes a header without mutating inputs. Provider schemas stay in their packages.
- `src/config/` contains reusable scoped-store, document-ops, and tolerant-field configuration infrastructure.
- `src/projection.ts` serializes private authoritative `Ref` transitions with a private `Semaphore`. Lock waiting, update work, and projection preparation remain interruptible. External publication, internal snapshot publication, and the backing `Ref.set` share one narrow uninterruptible commit. Rejected preparation or publication leaves state and the internal snapshot unchanged. Snapshots reject non-finite numbers and true object cycles with typed paths while preserving acyclic shared references.
- Core code uses exact `effect/Predicate` variants where a named refinement helps. `src/runtime-values.ts` keeps the public object-or-null guard and runtime type-name classifier as direct `typeof` compatibility helpers.
- `src/security.ts` owns shared redaction/plain terminal sanitization. Its JWT helper decodes only the second segment with Effect `Encoding` and `Result`, accepts padded or unpadded Base64URL, ignores later signature segments, and returns `undefined` for a missing or invalid payload. `extractJwtClaim` layers a from-string payload schema on that helper and `redactedTokenSchema` builds the shared `Redacted` OAuth-token field schema with a caller-provided label. `src/security/terminal-styled.ts` owns linear per-channel parsing and bounded safe visual-SGR preservation for terminal log UIs that must strip every active control sequence.
- `src/settings-completion.ts` owns pure `/…-settings` argument completion (`completeSettingsArguments`): descriptor-ordered id matching, caller-supplied extra verbs, case-insensitive prefixes (ids match case-insensitively in both stages), and the `null`-on-no-match host contract. It also owns the write-side settings family: `SettingsOptionDescriptor` with its JSON-string field schemas, the `InvalidSettingError` contract, and the `decodeSettingUpdate` factory that decodes one settings update into a document patch (`sectionSettingValue` composes the dotted-id patch). `makeUsageSettingDescriptors` owns the three shared subscription-usage descriptors and accepts the provider-specific visibility description. Provider schemas and defaults stay in each provider package. It has no UI dependency.
- `src/settings-dispatch.ts` owns pure `/…-settings` argument dispatch (`dispatchSettingsCommand`): a closed OpenInteractive/Help/Diagnostics/Apply/Invalid tagged result with exact finite-value matching and no hidden verb aliases. Hosts own all side effects and message wording; it has no host dependency.
- `src/subscription-format.ts` owns shared subscription countdown/percent/token/status-line formatting helpers.
- `src/host-session.ts` owns pure Pi host session capture helpers (UI mode, trust, cwd/signal). Trust fails closed unless a captured callback returns literal `true`; absent, malformed, false, or throwing host values are untrusted. Best-effort notifications contain synchronous host failures and use pinned `Predicate.isPromiseLike` to attach rejection handlers to returned object or callable thenables.
- `src/usage-projection.ts` owns shared usage eligibility/clearing projection transitions. `src/usage-controller.ts` captures exactly the shared `Path.Path`, `JsonDocumentStore`, `JsonHttpClient`, and `Tracer.Tracer` services in one explicit `Context` pinned onto effects that escape the construction Layer. `UsageRefreshControllerOptions` intentionally takes a provider-only `Context` instead of the former provision callback. The captured shared context is merged second so it overrides provider key collisions; the controller never captures the whole ambient context. The exported `UsageControllerStore<Resolved, E>` remains an unconstrained structural compatibility contract. Controller construction checks it against a private metadata-constrained `ScopedConfigStore` operation set. `synchronizeState` is optional: when omitted, the controller composes eligibility with `withUsageEligibility` and its `hiddenStatusText`. `timedDiagnosticResult` bounds one provider diagnostic fetch at the shared 10-second deadline and maps failures and timeouts onto a sanitized `Result<A, string>`.
- `src/usage-controller.ts` accepts the presentation owner's background-request policy independently of provider config. Hidden usage skips automatic requests; explicit notified requests still fetch. Visibility participates in the refresh key, preventing late results from restoring hidden usage. Core owns no custom-footer renderer.
- `src/testing/` contains multi-consumer fakes and probes only.

Public barrels (`index.ts`, `testing.ts`) re-export these modules; consumers import from `pi-cosmic-core` / `pi-cosmic-core/testing`, not internal paths.

## Native callback context

`src/platform/native-context.ts` exports the scoped `makeNativeContext` factory and its `run`/`current` interface. `node-builtins.ts` owns raw AsyncLocalStorage acquisition. The context carries native callback provenance only, never permission, an Effect context, or an Effect runner. Scope closure withdraws reads and new runs before best-effort native disable; `current()` then returns `undefined`, and `run()` rejects. MCP uses it around SDK HTTP send/onmessage and subscription/progress correlation without replacing the SDK parser. Application owners still check authority separately.

## Duplex process ownership

`src/platform/duplex-process.ts` opens detached macOS processes through `node-builtins.ts` with no shell and an exact caller-supplied environment. Spawn installs lifecycle and pipe-error guards synchronously. One masked ownership handoff installs a cached close finalizer before restoring interruption for startup readiness. Failed or interrupted startup closes immediately, even when the caller's scope remains open.

`duplex-process-io.ts` owns native stream ingress and one interruptible writer fiber in the process's private scope. Write completion waits for Node's write callback, not the boolean return from `write()`. Admission counts active and queued bytes together. Cancelling a queued write drops its buffer; cancelling an active waiter retains its byte charge until the native callback or pipe close releases it. Stdout overflow fails with a bounded tagged error. Root exit does not end readable queues; native EOF or pipe close does. Stderr has independent total-retention and queued-byte caps and supports zero retention.

Close revokes input and joins the writer before `duplex-process-close.ts` performs TERM/KILL escalation. Grace, force, root/group confirmation, and native pipe closure share one cleanup deadline. Only root exit, absent process group, and closed native pipes confirm cleanup. A transient macOS EPERM probe is retried within that budget, never treated as absence. Explicit close, concurrent callers, failed acquisition, and scope release reuse the same cached outcome and cleanup observer result. Pipe error guards remain through native close, including late EPIPE after an unconfirmed cleanup. Descendants that deliberately escape the detached group are outside the guarantee. Native errors, argv, environment, and paths never enter process failures or diagnostics.

## Cross-process ownership

`CrossProcessLock` is an opt-in same-host capability, separate from file and network Layers. Callers supply the actual shared resource namespace, not a session or agent directory. The default private root is `.cosmic-pi-locks-v1` beneath the OS account home returned by `os.userInfo()`, independent of `HOME`. The Node boundary validates ownership, permissions, bounded schema records, and no-follow file opens. Short synchronous filesystem commits use `node-builtins.ts`; polling, authority checks, caller work, and cancellation remain Effect-owned and interruptible.

`acquireTimeoutMs` defaults to 15 seconds and accepts positive finite values up to 2,147,483,647 ms. It bounds admission, not admitted work. `withPermit` and nested filesystem acquisition inherit the earliest monotonic deadline, so upstream queues cannot restart the budget. Local release notifications wake waiters; polling covers other processes. Neither FIFO fairness nor a waiter-count cap is promised. Synchronous filesystem stalls are not preemptible. Timeout or cancellation never expires an admitted or native-pending owner.

Acquisition fsyncs a complete nonempty candidate before atomic publication. A failed post-publication durability check retires that exact quiescent owner before failure. Recovery requires positive PID-death evidence and a quiescent journal, never heartbeat age. Dead-owner recovery leaves a nonempty `.retired-<token>` barrier to prevent a stale reclaimer from moving a successor. Normal release instead uses `.released-<token>` and attempts validated deletion of only that exact owner's record and directory. Successful normal transactions leave no growing release history; failed cleanup may leave a released artifact. Old `.retired`, token-specific recovery barriers, crash candidates, and malformed artifacts remain. There is no online garbage collector, count threshold, or global storage bound.

A lease journals native mutation admission before an uncancellable call. Interruption retains ownership until the actual native completion callback clears the journal and releases the exact owner. A dead `native-pending` owner fails closed. PID death, elapsed time, and a new login do not prove that a separate native service settled. Offline maintenance must stop all participating processes and reclaimers, inspect artifacts individually, and independently establish native settlement before touching pending evidence. Do not erase the lock root or active, malformed, or native-pending evidence as routine cleanup. Core has no reset CLI and cannot automate settlement proof. Callers own durable credential quarantine and recovery messaging; deleting coordination evidence cannot replace that quarantine. Private metadata contains no credential values.

## Network addresses and callback listeners

`src/platform/network-addresses.ts` owns bounded native address resolution behind `NetworkAddresses`.
Its callback can settle after interruption, but a late result cannot open a connection.
`pinnedNetworkLookup` supplies only a copied, caller-approved address set to an HTTP agent. A
hostname or family mismatch fails without another DNS lookup. Consumers own private-address,
URL, redirect, and protocol policy; core does not decide which OAuth destinations are trusted.

`src/platform/http-server.ts` provides the scoped `nodeHttpServerLayer` over Effect Node HTTP
services. `node-builtins.ts` remains the raw native-listener door. The Layer owns acquisition and
listener closure, including closing active connections before joining native shutdown. Consumers
own bind addresses, routes, Host/origin checks, request limits, and callback state. MCP uses it
for an auth-attempt-owned IPv4 loopback listener, not a process-global OAuth server.

The JSON-document API accepts an optional per-call `maxBytes` bound before parsing, including
locked reads. Atomic modifications also reject an oversized serialized replacement before any
write or publication, counting formatting and the trailing newline. The in-memory adapter uses
the same codec and byte representation. Existing callers that omit the bound retain their prior
behavior. Feature stores choose the limit and own structural/schema validation. MCP uses a
1 MiB configuration-document ceiling.

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
