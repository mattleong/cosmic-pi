# Architecture

`pi-directory-models` remembers the active model and thinking level for each canonical working directory.

## Ownership

`src/application.ts` owns Pi registration and the session runtime slot. `src/layer.ts` composes the Effect Layer from `DirectoryModelPreferenceService` and `DirectoryModelStore`. The preference service owns restore and remember policy, its one-permit semaphore, and its session-local directory identity cache. Successful identity lookup is cached; a failed lookup remains retryable on a later event.

`src/config/store.ts` is the only persistence door. It canonicalizes the cwd and reads or atomically replaces one Schema-validated document per directory. Host argv, session, model registry, model selection, and thinking-level calls stay in `src/boundary/`. Schema and path-key modules remain pure.

## Lifecycle

Registration captures the presence of Pi's explicit `--model` argument once. Each `session_start` creates one managed runtime and reuses that captured decision. Fresh sessions without `--model` restore or initialize the directory preference. Resume, fork, and reload starts preserve their session model.

Restoration runs before slot activation. The slot activates only after startup and Pi's awaited `setModel` settlement complete, so restoration events are dropped before activation. The `source === "restore"` check remains as defense in depth. The noncancelable `setModel` settlement is the only uninterruptible region; replacement waits for it before starting the next runtime.

Admitted model and thinking events run `remember` under the service semaphore. The service snapshots the live model and thinking level at serialized capture time, so delayed events persist current state rather than stale event data. Events outside an active runtime and malformed host values do not write. `session_shutdown` disposes the runtime.

Preference documents live under `<agent-dir>/pi-directory-models/` as `<readable-basename>--<12-char-sha256>.json`. Each document records its canonical cwd, which the store validates before use.
