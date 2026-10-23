# Behavioral testing

Tests protect domain behavior, persistence, security, lifecycle, concurrency, cancellation, cleanup, and recovery. They should survive a behavior-preserving refactor. Package architecture documents identify owners; tests establish their observable guarantees.

## What to test

For resource-owning code, exercise success, failed acquisition, interruption, replacement, and repeated shutdown. Prove that cleanup completes, no owned work survives shutdown, and one operation never releases another's resource. Counts are useful when they demonstrate double cleanup or a leak, not as a substitute for observable behavior.

For state and persistence, cover failed writes, stale results, competing mutations, and publication during retirement. Durable state, private state, and synchronous projections must not diverge across the commit boundary. Atomic writers must preserve unacquired collisions and do no fallible work after rename. Persistence fakes clone JSON ingress and egress and must not commit failed mutations.

At untrusted boundaries, exercise malformed and oversized input, schema rejection, redaction, and bounded retention. Include representative secrets in failure paths and inspect errors, logs, spans, and snapshots. Cleanup Promise rejection must remain a typed failure, not a defect.

Avoid tests for bare symbol existence, types already enforced by TypeScript or schemas, exact provider payloads/catalogs, internal call order without behavioral consequences, and exact UI wording, colors, layout, ANSI, or key hints. Test discovery or conditional registration when it can fail at runtime. Test command handlers and UI state transitions rather than wiring snapshots.

## Deterministic concurrency

Use the pinned `@effect/vitest` v4 APIs: `it.effect` for scoped tests with test services, `it.live` when real time or platform behavior is intentional, and `layer` for shared test Layers. Ordinary Vitest tests suit pure functions. The older `it.scoped` helpers are not available.

Use `TestClock` for time-dependent behavior, forking sleeping work before advancing time. Use `Deferred` to pause at an actual ownership or publication boundary, then force a competing operation through the window. An atomicity or cancellation test should fail if its relevant lock, revision check, or cleanup handoff is removed. Completion probes establish prompt settlement; a wall-clock timeout around a test-clock effect is only a hang guard.

Compose complete test Layers at the test entry point so scopes match production. Mock owned domain boundaries rather than external provider protocols. Keep fault policies and package-specific probes local; move a helper into core only when multiple consumers need the same contract.

## Shared fixtures and integration tests

`pi-cosmic-core/testing` supplies deterministic documents and HTTP adapters, lifecycle probes, schedulers, telemetry capture, host fixtures, and real-process helpers. `pi-cosmic-core/testing/sdk` supplies offline Pi sessions. These helpers have no Vitest dependency. Do not install a global telemetry exporter in tests.

Keep focused integration tests where host behavior matters: Pi's mount/close lifecycle, retained history replay, native mutation-queue cancellation, process exit confirmation, packaged helper resolution, and public renderer/source ownership. These prove our adaptation of the pinned dependency; they are not snapshots of its private implementation. Reuse `pi-cosmic-ui/testing`'s custom-surface host to exercise late mounting and unrelated stacked overlays, and prove the shared close protocol once in Cosmic UI.

Tool presentation tests use actual registered definitions or public renderer callbacks through `pi-code-previews/testing`. Exercise expansion, fallback, uncertainty, replay, and lifecycle without invoking execution. Preserve complete arguments, raw output, recovery evidence, and native images. Use `issueMessageStyleProblems` for producer message style, and `pnpm presentation:gallery` for human review of visible states; do not assert exact gallery text. See the [presentation contract](tool-presentation.md#retention-and-validation).

Real-process tests distinguish requesting termination from confirming exit. Keep readiness event-driven and cleanup bounded where the platform permits it. The packed-consumer gate loads published TypeScript through Jiti, exercises native MCP ownership and cleanup with a local fixture, and runs the shipped image decoder under plain Node. This protects source-only installation without depending on provider credentials or a build step.

## Validation order

Run the narrowest relevant package checks before the full workspace gate:

```bash
pnpm --filter <package> test
pnpm --filter <package> check
pnpm validate
```

Package `check` includes TypeScript, Effect diagnostics, type-aware lint, and formatting. The root gate also checks synchronized package versions, workspace tests, and packed consumers. TypeScript and Effect diagnostics run separately to avoid duplicate messages. Only `error`-severity Effect diagnostics fail the gate, so enforced diagnostics are configured as errors. Unstable-API diagnostics are off because the architecture requires several unstable-marked domain modules; exact pins and boundary tests cover that risk.

Tests follow the same Effect diagnostics as source, including `asyncFunction`, `newPromise`, `globalTimers`, and `globalDate`. `tests/**` may read `process.env` and construct `AbortController`s that simulate host signals. Tests reach the file system and paths through Effect `FileSystem` and `Path`, not `node:*` imports; only standalone `tests/fixtures/**` processes may import Node built-ins. Packages without `@effect/platform-node` may use core's Node built-in re-exports, and test-only Node values such as `NodeChildProcess` come from `pi-cosmic-core/testing`. Exact test files that drive Effect from host callbacks are exempt from `runEffectInsideEffect`.

The workspace runner limits package and Vitest concurrency to avoid starving process fixtures, and disallows focused tests. Do not compensate for missing readiness or cleanup signals by merely raising timeouts. Source and packed-consumer checks must not require generated distributions or mutate shared build output. Run both focused tests and the full gate after architecture changes; broaden testing further only when failures or remaining risk justify it.
