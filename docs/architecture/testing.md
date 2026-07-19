# Effect testing

## Test APIs

Effectful tests use the exact beta-compatible `@effect/vitest` API:

- `it.effect` for deterministic Effect tests with test services and Scope,
- `it.live` only when live time or live platform behavior is intentional,
- `layer(...)` for a shared test Layer,
- ordinary Vitest tests for total deterministic functions.

Do not use stale examples containing `it.scoped` or `it.scopedLive`; those helpers are not exported by `@effect/vitest@4.0.0-beta.99`.

## Required coverage

Resource-owning services test acquisition and release counts. Time-dependent behavior uses `TestClock`; sleeping work is forked before the clock is advanced. Tests cover interruption during auth lookup, HTTP requests, streams, configuration writes, image writes, Shiki initialization, advisor checkpoints, session replacement, and shutdown.

Each migrated package must prove:

- no fibers survive shutdown,
- finalizers run on success, failure, and interruption,
- service requirements are fully supplied,
- external data is schema-decoded,
- secrets do not appear in errors, logs, spans, or snapshots.

## Validation order

Run the narrow package gate first, then the workspace gate:

```bash
pnpm --filter <package> typecheck
pnpm --filter <package> test
pnpm --filter <package> lint
pnpm validate
```

`pnpm effect:lsp:verify` proves both the patched compiler and every package's inherited plugin configuration. `pnpm architecture:check` enforces the migration ratchet.
