# Effect testing

## Test APIs

Effectful tests use the pinned stable `@effect/vitest` v4 API with Vitest 5:

- `it.effect` for deterministic Effect tests with test services and Scope,
- `it.live` only when live time or live platform behavior is intentional,
- `layer(...)` for a shared test Layer,
- ordinary Vitest tests for total deterministic functions.

Do not use stale examples containing `it.scoped` or `it.scopedLive`; those helpers are not exported by `@effect/vitest@4.0.0`.

## Required coverage

Resource-owning services test acquisition and release counts on success, failure, replacement, interruption, and repeated shutdown. Time-dependent behavior uses `TestClock`; sleeping work is forked before the clock is advanced. Tests cover interruption during auth lookup, HTTP requests, streams, configuration writes, image writes, Shiki initialization, session replacement, and shutdown. Shared deterministic platform fakes and acquisition probes live under the published `pi-cosmic-core/testing` test-kit subpath.

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

`pi-cosmic-core/testing` publishes only helpers with multiple proven consumers: in-memory JSON documents, schema-aware JSON/streaming HTTP adapters, a lifecycle acquisition/release probe, bounded `yieldUntil` polling for scoped workers, paused and checkpoint-interrupting schedulers for deterministic interruption tests, capture logger/tracer Layers with a stable telemetry snapshot, a fake Windows `taskkill` helper, SAFETY-cast Pi host fixtures (`extensionApiFixture`, `extensionContextFixture`, `opaqueFixture`), a frozen identity `plainTheme`, `deferredPromise`, and the scoped real-process IPC harness (`temporaryDirectory`, `spawnIpcChild`, `killChild`) shared by cross-process lock tests. They have no Vitest dependency. Capture assertions serialize only log values plus span names and attributes, verify stable operation names, and inject representative URLs, paths, prompts, bodies, tokens, and account IDs to prove absence.

Test Layers are merged and provided once at the test entry point so resource lifetimes match production. No test installs a global telemetry exporter. Session/Pi harnesses, fault policies, and fiber probes remain package-local because the current host/session and failure shapes are materially different; they should move into core only when a second consumer would use the same contract. Custom-UI tests share `fakeCustomSurfaceHost` from `pi-cosmic-ui/testing`, which models Pi's custom UI host exactly (unchanged from 0.86 through the pinned 1.0.2): a synchronous factory, a separate `onHandle` mount, a global-pop `done`, non-capturing guards, `setWidget`, and one-shot faults at owned hide, guard creation, `done`, and guard hide. Each surface consumer keeps one real-shape integration test on it; the shared close protocol is proved once in `pi-cosmic-ui`. Schema boundaries are exercised through the shared schema-aware HTTP/document fakes rather than a second assertion DSL.

Async questionnaire tests separate the TUI factory from the `onHandle` mount handshake and protect the shared dialog permit, waiter claims, cancellation, opening failure, delivery failure, bounded retention, and scope shutdown. The host fake adapts the shared custom-surface fake, so submission and abort must preserve unrelated stacked overlays, including abort before a late mount, and every close fault must release the FIFO ticket. Low-yield-budget regressions interrupt before the final atomic waiter acknowledgement and claim release, requiring delivery to remain recoverable with no tentative acknowledgement. Cancellation after that transition cannot revoke its acknowledgement or a successor's claim. Explicitly acknowledged failed openings become evictable; unacknowledged failures remain retained. TestClock covers bounded retries, await recovery, and retry shutdown. History tests use branch receipts to preserve valid answers while rejecting late revoked steering messages across repeated tree navigation and reload. Prompt tests reject competing public prompts at admission and during lazy loading without stealing focus. A returned public `sendMessage` call is not tested as model acknowledgement.

## Ownership regression coverage

- Projection tests interrupt update preparation and lock waiting, then require reuse. Publication tests require the external snapshot, internal snapshot, and authoritative state to commit together, including fast-mode durable commits. Refresh tests interrupt admission before work starts and require shared waiters to settle and later refreshes to proceed. Consumer tests pause after final key validation and compete with context, settings, and branch invalidation; removing the shared gate must expose stale publication.
- Preview tests hold a predecessor in Pi's native mutation queue across cancellation, replacement, and shutdown. The caller must settle without that predecessor; releasing that predecessor must not execute the revoked write or enter the replacement runtime.
- Ask User editor tests hold process cleanup through interruption and require file removal and TUI restoration before dialog-permit or session transfer, without waiting for the custom Promise.
- Background process tests interrupt cwd inspection before spawn, exercise graceful-helper timeout and force escalation, and require process-scope helper cleanup. Subagent tests cancel a subtree-stop waiter between descendants and require the complete traversal to continue under session ownership. Failed or interrupted supervisor-connection opening must disconnect its peer while the parent scope stays open; a released scope or ended assignment watch must disconnect without redialing.
- Settings tests replace the session during inspection and registry refresh, including a registry Promise that ignores abort. No stale picker or catalog may publish. Hold an old durable `afterCommit` through retirement and replacement startup failure; private state may finish, but projections, notifications, transport resets, and repaint callbacks must remain revoked. Image tests retire between generation settlement and the queued send, and reject retained old tool/command admission. Cosmic UI tests delay old shutdown and failed-start cleanup across replacement and require replacement state to survive.
- Spawn tests pause a published claim before driver admission, then interrupt and join stop/compensation without leaving settlement or writer ownership pending. Cancellation before a claim must settle while the registry permit remains held.
- Renderer tests exercise actual public resolver callbacks and Pi's `ToolExecutionComponent`, including pre-start replay, trusted first-ready adoption, complete call/result reconstruction, fixed self-shell framing, captured appearance, owner retirement, foreign-owner fallback, later native activation, and inactive selection. Write tests preserve its real before-write hook, mutation-queue cancellation and mutate-then-refresh recovery; other presentation never registers execution definitions.
- Native codemode/MCP SDK tests load Code Previews beside independently owned builtins in either order, preserving schemas, permission hooks, cancellation, stores, output/recovery and native images. Historical MCP aliases require a proven builtin manager rather than guessed remote identities. The packed-consumer check loads published TypeScript through Jiti and executes a real local MCP tool/resource fixture with no provider authentication, verifies builtin manager/tool source ownership and renderer output/image preservation, then requires a closed lifecycle marker and absent process. No production MCP manager factory is intercepted. Native protocol and authentication internals belong to Pi, not workspace tests. Code Previews requires Pi 1.0.1; the workspace pins/tests 1.0.2.
- Background log tests attempt mutation through events, cached slices, clipped tails, and projection rows. Later appends/evictions must preserve old snapshots, UTF-8 byte accounting, and immutable structural sharing.
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

`pnpm typecheck` checks every workspace project with the unmodified TypeScript 7 compiler, while `pnpm effect:diagnostics` runs `@effect/tsgo`'s dedicated diagnostics command for each package. Keeping the gates separate prevents duplicate Effect output and leaves suggestion-level messages visible without turning them into TypeScript failures. `@effect/tsgo@0.47.2` also reports upstream `unstableApiUsage` warnings for Effect HTTP, process, RPC, socket, and SSE APIs; these stay enabled and visible. A stable Effect package version does not stabilize those marked APIs, so exact pins, owned adapters, and lifecycle/compatibility tests remain required. `strictEffectProvide` is enforced for production source; test files are Effect entry points and intentionally provide complete test Layers. TypeScript, Oxlint, Effect diagnostics, tests, and review are complemented by narrow repository guards: `pnpm layout:check` checks package/test placement and declared nested packages; `pnpm diagnostics:guard` rejects source suppressions and disabled diagnostic configuration. Other architecture conventions remain guidance rather than custom static-analysis rules. Pi/Jiti loads workspace and packed package TypeScript source directly; focused and root gates never depend on generated distributions or mutate shared build output.
