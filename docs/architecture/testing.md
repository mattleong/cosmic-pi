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

`pi-cosmic-core/testing` publishes in-memory JSON documents, JSON/streaming HTTP adapters, acquisition/release probes, and capture logger/tracer Layers without a Vitest dependency. Capture assertions serialize only span names and attributes, verify the stable operation name, and inject representative URLs, paths, prompts, bodies, tokens, and account IDs to prove absence. Tests cover core HTTP, provider refresh, OpenAI image streaming, Cosmic UI probes, Shiki initialization/degradation logging, and advisor checkpoint decoding.

Test Layers are merged and provided once at the test entry point so resource lifetimes match production. No test installs a global telemetry exporter.

## Validation order

Run the narrow package gate first, then the workspace gate:

```bash
pnpm --filter <package> typecheck
pnpm --filter <package> test
pnpm --filter <package> lint
pnpm validate
```

`pnpm effect:lsp:verify` proves both the patched compiler and every dynamically enumerated package's inherited plugin configuration. `pnpm effect:diagnostics` dynamically runs diagnostics for the same projects. `pnpm architecture:check` first executes positive/negative fixtures and then enforces the exact migration ratchet and direct catalog dependency declarations. Root recursive typecheck and test gates are serialized because focused package hooks reliably build the shared core distribution; this prevents concurrent cleaning builds from mutating the same `pi-cosmic-core/dist` directory.
