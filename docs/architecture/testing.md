# Effect testing

## Test APIs

Effectful tests use the exact RC-compatible `@effect/vitest` API:

- `it.effect` for deterministic Effect tests with test services and Scope,
- `it.live` only when live time or live platform behavior is intentional,
- `layer(...)` for a shared test Layer,
- ordinary Vitest tests for total deterministic functions.

Do not use stale examples containing `it.scoped` or `it.scopedLive`; those helpers are not exported by `@effect/vitest@4.0.0-rc.112`.

## Required coverage

Resource-owning services test acquisition and release counts on success, failure, replacement, interruption, and repeated shutdown. Time-dependent behavior uses `TestClock`; sleeping work is forked before the clock is advanced. Tests cover interruption during auth lookup, HTTP requests, streams, configuration writes, image writes, Shiki initialization, advisor checkpoints, session replacement, and shutdown. Shared deterministic platform fakes and acquisition probes live under the published `pi-cosmic-core/testing` test-kit subpath.

Advisor lifecycle tests use `TestClock` to prove that a never-settling child abort reaches forced
disposal at the configured operation deadline and remains reset-required until a clean re-prime.
Promise-boundary tests also prove that timed-out child creation cannot delay replacement or
shutdown, and that a never-installed late session is synchronously disposed exactly once.
Advisor host-boundary tests inject throwing getters, session methods, abort signals, tool metadata,
status renderers, and timer callbacks; replacement tests prove exact listener release. Configuration
tests interrupt inside `afterCommit` and require the renamed document and authoritative publication
to remain aligned. Checkpoint finalizer tests deactivate the outer executor before scope closure and
still require inline cancellation, fiber interruption, and exact-once bookkeeping.

Concurrency tests pause at the exact ownership or publication boundary with `Deferred`, then
force the competing operation through that window. A test named atomic, serialized, stale-safe,
or interruption-safe must fail if the lock, revision check, or finalizer ordering is removed.
Wall-clock timeouts under `it.effect` are not promptness proofs because the test clock advances
only when the test advances it; use completion probes and retain Vitest's timeout only as an outer
hang guard.

Each migrated package must prove:

- no fibers survive shutdown,
- finalizers run on success, failure, and interruption,
- service requirements are fully supplied,
- external data is schema-decoded,
- secrets do not appear in errors, logs, spans, or snapshots.
- cleanup Promises that reject become typed failures rather than defects,
- failed acquisition never releases or deletes a resource owned by another operation,
- atomic file writers never remove an unacquired collision and perform no fallible work after the
  rename commit,
- persistence fakes clone JSON ingress and egress, reject non-JSON values, and do not commit a
  failed effectful mutation.

## Shared test Layers and telemetry capture

`pi-cosmic-core/testing` publishes only helpers with multiple proven consumers: in-memory JSON documents, schema-aware JSON/streaming HTTP adapters, a lifecycle acquisition/release probe, bounded `yieldUntil` polling for scoped workers, and capture logger/tracer Layers with a stable telemetry snapshot. They have no Vitest dependency. Capture assertions serialize only log values plus span names and attributes, verify stable operation names, and inject representative URLs, paths, prompts, bodies, tokens, and account IDs to prove absence.

Test Layers are merged and provided once at the test entry point so resource lifetimes match production. No test installs a global telemetry exporter. Session/Pi harnesses, fault policies, and fiber probes remain package-local because the current host/session and failure shapes are materially different; they should move into core only when a second consumer would use the same contract. Schema boundaries are exercised through the shared schema-aware HTTP/document fakes rather than a second assertion DSL.

Async questionnaire tests separate the TUI factory from the `onHandle` mount handshake and protect the shared dialog permit, waiter claims, cancellation, opening failure, delivery failure, bounded retention, and scope shutdown. Host fakes model Pi's global-pop custom-dialog cleanup so submission and abort must preserve unrelated stacked overlays, including abort before a late mount. Low-yield-budget regressions interrupt before the final atomic waiter acknowledgement and claim release, requiring delivery to remain recoverable with no tentative acknowledgement. Cancellation after that transition cannot revoke its acknowledgement or a successor's claim. Explicitly acknowledged failed openings become evictable; unacknowledged failures remain retained. TestClock covers bounded retries, await recovery, and retry shutdown. History tests use branch receipts to preserve valid answers while rejecting late revoked steering messages across repeated tree navigation and reload. Prompt tests reject competing public prompts at admission and during lazy loading without stealing focus. A returned public `sendMessage` call is not tested as model acknowledgement.

## Ownership regression coverage

- Projection tests interrupt update preparation and lock waiting, then require reuse. Publication tests require the external snapshot, internal snapshot, and authoritative state to commit together. Refresh tests interrupt admission before work starts and require shared waiters to settle and later refreshes to proceed.
- Preview tests hold Pi's outer mutation queue across cancellation, replacement, and shutdown. The caller must settle without its predecessor; releasing that predecessor must not execute the revoked write or enter the replacement runtime.
- Advisor onboarding tests separate factory execution from mount, preserve unrelated overlays, and require typed finish failure even when Pi's custom Promise never settles. Ask User editor tests hold process cleanup through interruption and require file removal and TUI restoration before dialog-permit or session transfer, without waiting for the custom Promise.
- Background process tests interrupt cwd inspection before spawn, exercise graceful-helper timeout and force escalation, and require process-scope helper cleanup. Subagent tests cancel a subtree-stop waiter between descendants and require the complete traversal to continue under session ownership. Failed or interrupted bridge opening must release its child resources while the parent scope stays open.
- Settings tests replace the session during inspection and registry refresh, including a registry Promise that ignores abort. No stale picker or catalog may publish. Cosmic UI tests delay old shutdown and failed-start cleanup across replacement and require replacement state to survive.
- Decoder tests exercise full-page validation, malformed and oversized input, output and format-schema bounds, deadlines, cancellation, and immediate cross-runtime admission. Fault-injected kill failure and incomplete acquisition must leave decoding disabled unless cleanup explicitly confirms exit, on success, failure, and interruption. No raw pixels or native diagnostics may escape. Real-process fixtures prove termination and permit ownership through cleanup; they do not claim an OS memory sandbox or unconditional shutdown deadline.

The packed-consumer check executes Better OpenAI's shipped `.mjs` decoder with a tiny PNG under plain Node in a clean consumer, with bounded time/output and an empty environment. It requires accepted format metadata and no stderr. This protects helper packaging and dependency resolution without a build prerequisite; it is not a Sharp protocol snapshot test.

## Validation order

Workspace tests run at most two packages with four Vitest workers each. Without the worker cap,
each package independently uses nearly every CPU, multiplying contention and starving real-process
fixtures within their hang guards. Keep readiness checks event-driven; increasing test timeouts is
not a substitute for a startup signal or bounded cleanup.

Run the narrow package gate first, then the workspace gate:

```bash
pnpm --filter <package> typecheck
pnpm --filter <package> test
pnpm --filter <package> lint
pnpm validate
```

`pnpm typecheck` checks every workspace project with the unmodified TypeScript 7 compiler, while `pnpm effect:diagnostics` runs `@effect/tsgo`'s dedicated diagnostics command for each package. Keeping the gates separate prevents duplicate Effect output and leaves suggestion-level messages visible without turning them into TypeScript failures. `strictEffectProvide` is enforced for production source; test files are Effect entry points and intentionally provide complete test Layers. TypeScript, Oxlint, Effect diagnostics, tests, and review are complemented by narrow repository guards: `pnpm layout:check` checks package/test placement and declared nested packages; `pnpm diagnostics:guard` rejects source suppressions and disabled diagnostic configuration. Other architecture conventions remain guidance rather than custom static-analysis rules. Pi/Jiti loads workspace and packed package TypeScript source directly; focused and root gates never depend on generated distributions or mutate shared build output.
