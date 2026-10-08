# Architecture

`pi-directory-models` remembers the active model and thinking level for each canonical working directory.

## Ownership

`src/application.ts` owns Pi registration and the session runtime slot. `src/layer.ts` composes `Layer.effect` directly from the `Context.Service` `make` functions for `DirectoryModelPreferenceService` and `DirectoryModelStore`. The services do not export one-use Layer aliases. The preference service owns restore and remember policy, its one-permit semaphore, and its session-local directory identity cache. It caches only a successful identity lookup, so a later event retries after a failure.

`src/config/store.ts` is the only persistence door. It canonicalizes the cwd and reads or atomically replaces one Schema-validated document per directory. Host argv, session, model registry, model selection, and thinking-level calls stay in `src/boundary/`. Fallback-only model capture uses core's no-throw host callback and tolerant decode helpers, while restoration keeps typed failures for reads and mutations. Schema and path-key modules remain pure.

## Lifecycle

Registration checks Pi's argv once for an exact `--model <value>` or `--thinking <value>` pair before the end-of-options `--`. Bare terminal flags and tokens after the marker do not count. The service treats model and thinking as one atomic preference, so either explicit CLI value suppresses the whole restore or initialization. Every `session_start` first captures cwd and its optional signal. A `new` start is fresh without reading session entries. Only `startup` asks Pi's `buildSessionContext` helper to resolve the active leaf, and an empty resolved message list marks it as fresh. A startup context failure leaves directory preferences unavailable for that session. Resume, fork, and reload starts are nonfresh and do not read session entries or the leaf. Fresh sessions without an explicit CLI preference restore or initialize the directory preference.

Restoration runs before slot activation. The slot activates only after startup and Pi's awaited `setModel` settlement complete, so restoration events are dropped before activation. The `source === "restore"` check remains as defense in depth. The noncancelable `setModel` settlement is the only uninterruptible region; replacement waits for it before starting the next runtime.

Admitted model and thinking events run `remember` under the service semaphore. The service snapshots the live model and thinking level at serialized capture time, so delayed events persist current state rather than stale event data. Events outside an active runtime and malformed host values do not write. `session_shutdown` disposes the runtime.

Preference documents live under `<agent-dir>/pi-directory-models/` as `<readable-basename>--<12-char-sha256>.json`. Each document records its canonical cwd, which the store validates before use.
