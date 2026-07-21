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

Each migrated package must prove:

- no fibers survive shutdown,
- finalizers run on success, failure, and interruption,
- service requirements are fully supplied,
- external data is schema-decoded,
- secrets do not appear in errors, logs, spans, or snapshots.

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
