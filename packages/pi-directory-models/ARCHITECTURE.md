# Architecture

`pi-directory-models` is an Effect-managed Pi extension that remembers the active model and thinking level for each canonical working directory.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — session lifecycle and model/thinking event wiring.
- `src/config/schema.ts` — persisted preference shape.
- `src/config/store.ts` — the single persistence door; canonicalizes the cwd and reads/writes atomic per-directory documents.
- `src/preference/service.ts` — serialized restore and remember policy.
- `src/boundary/host-cli.ts` — one-off `--model` detection.
- `src/boundary/host-model.ts` — guarded Pi model registry and model/thinking operations, including Schema-decoded synchronous host model and thinking-level capture.
- `src/boundary/host-session.ts` — guarded session capture and fresh-session classification.
- `src/boundary/path-key.ts` — deterministic readable preference filenames.

## Lifecycle

`session_start` creates one managed runtime. Fresh sessions without an explicit `--model` restore or initialize the directory preference. Resume, fork, and reload starts preserve their session model. Interactive model and validated thinking changes are serialized through `DirectoryModelPreferenceService`; malformed thinking events are ignored at the host boundary. Pi's noncancelable `setModel` Promise settlement is the only narrow uninterruptible restore region, so disposal/replacement waits before starting a successor while registry lookup and surrounding reads remain interruptible. `session_shutdown` disposes the runtime.

Preference documents live under `<agent-dir>/pi-directory-models/` and use `<readable-basename>--<12-char-sha256>.json`. Each document contains the full canonical cwd, which is validated before use. Separate files avoid lost updates between Pi instances working in different directories; same-directory writes atomically replace one complete record.
