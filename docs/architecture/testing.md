# Effect testing

## Test APIs

Effectful tests use the exact beta-compatible `@effect/vitest` API:

- `it.effect` for deterministic Effect tests with test services and Scope,
- `it.live` only when live time or live platform behavior is intentional,
- `layer(...)` for a shared test Layer,
- ordinary Vitest tests for total deterministic functions.

Do not use stale examples containing `it.scoped` or `it.scopedLive`; those helpers are not exported by `@effect/vitest@4.0.0-beta.99`.

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

## Validation order

Run the narrow package gate first, then the workspace gate:

```bash
pnpm --filter <package> typecheck
pnpm --filter <package> test
pnpm --filter <package> lint
pnpm validate
```

`pnpm effect:lsp:check` uses the official language-service patch check, while `pnpm effect:diagnostics` runs the official diagnostics command declared by each package. TypeScript, Oxlint, Effect diagnostics, tests, and review are the architecture safeguards; repository conventions that those tools cannot express remain guidance rather than custom static-analysis rules. Root recursive typecheck and test gates are serialized because focused package hooks reliably build the shared core distribution; this prevents concurrent cleaning builds from mutating the same `pi-cosmic-core/dist` directory.
