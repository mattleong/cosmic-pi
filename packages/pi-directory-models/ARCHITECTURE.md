# Architecture

`pi-directory-models` is an Effect-managed Pi extension that remembers the active model and thinking level for each canonical working directory.

## Source map

- `src/extension.ts`: thin Pi registration entrypoint.
- `src/layer.ts`: session Layer composition.
- `src/application.ts`: session lifecycle and model/thinking event wiring.
- `src/config/schema.ts`: persisted preference shape.
- `src/config/path-key.ts`: pure, deterministic readable preference filenames.
- `src/config/store.ts`: the single persistence door; canonicalizes the cwd and reads/writes atomic per-directory documents.
- `src/preference/service.ts`: serialized restore and remember policy.
- `src/boundary/host-cli.ts`: one-off `--model` detection.
- `src/boundary/host-model.ts`: guarded Pi model registry and model/thinking operations, including Schema-decoded synchronous host model and thinking-level capture.
- `src/boundary/host-session.ts`: fresh-session classification over the shared `pi-cosmic-core` host session capture.

## Lifecycle

`session_start` creates one managed runtime. Fresh sessions without an explicit `--model` restore or initialize the directory preference. Resume, fork, and reload starts preserve their session model.

Restoration runs inside pre-activation startup: the session slot activates only after the whole startup Effect, including Pi's awaited `setModel` settlement, resolves. Model events emitted by restoration are therefore dropped before activation, with `source === "restore"` kept as defense in depth. Pi's noncancelable `setModel` Promise settlement is the only narrow uninterruptible region: runtime disposal or replacement waits for it before starting a successor, while registry lookup and surrounding reads remain interruptible.

Admitted model and thinking events run `DirectoryModelPreferenceService.remember` under one semaphore, which snapshots the live session model and Pi's current thinking level so a delayed host event re-persists the current state idempotently rather than a stale one. Events arriving before activation or after shutdown, and malformed events at the host boundary, are ignored without a write or warning. `session_shutdown` disposes the runtime.

Preference documents live under `<agent-dir>/pi-directory-models/` and use `<readable-basename>--<12-char-sha256>.json`. Each document contains the full canonical cwd, which is validated before use. Separate files avoid lost updates between Pi instances working in different directories; same-directory writes atomically replace one complete record.
