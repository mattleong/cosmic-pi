# Architecture

`pi-directory-models` remembers one model and thinking-level preference for each canonical
working directory. It restores that preference in fresh sessions and records subsequent
interactive changes.

## Ownership and boundaries

- [Application](src/application.ts) registers Pi events and owns the managed session-runtime
  slot. [Layer composition](src/layer.ts) supplies the preference service and filesystem store.
- [Preference service](src/preference/service.ts) owns restore/remember policy, serialized
  updates, warning deduplication, and a session-local cache of successful directory lookups.
- [Store](src/config/store.ts) canonicalizes the directory, validates saved documents, and
  atomically replaces them through core's document store. [Schema](src/config/schema.ts) and
  [path keys](src/config/path-key.ts) describe the persisted value and directory identity.
- [Host adapters](src/boundary/) capture CLI preferences, classify the session, and read or
  apply Pi's model and thinking level. The service determines when those operations happen and
  receives only the current-model and model-lookup capability, not the session context.

## Lifecycle and invariants

Each session start replaces the runtime. A fresh session restores or initializes its directory
preference unless the launch explicitly supplied a model or thinking level. Either CLI value
suppresses the whole restore because model and thinking are one preference. Startup uses Pi's
resolved active context to distinguish fresh sessions; resume, fork, and reload retain their
session choices. A failed startup-context read leaves this extension unavailable for that session.

Restoration finishes before activation. Pi's model change cannot be cancelled, so replacement
waits for its settlement before another runtime can restore a model. Events raised by restoration
cannot overwrite the saved preference. Admitted changes capture the live selection under the
service semaphore, preventing delayed events from writing stale event payloads.

Only successful directory identity lookups are cached; failures remain retryable. Directory
identity uses the native realpath so symlink and letter-case aliases resolve to one canonical cwd.
Saved documents include that cwd and are rejected if it differs from the requested directory. The
version, cwd, provider, and model are required; an invalid thinking level is reported and leaves
Pi's current level while the saved model still applies.
Unreadable, invalid, and foreign documents are not overwritten, and each reason has its own
warning. Read, restore, and write failures become bounded warnings rather than breaking the
session. Shutdown disposes the runtime, and inactive events do not write.
Service warnings check the slot's captured authority when published, so neither restoration
nor persistence can report a late warning after its owning session retires.

[Application tests](tests/application.test.ts) exercise restoration, concurrent replacement,
failure recovery, alias identity, and persistence. [CLI tests](tests/host-cli.test.ts) cover
explicit preference detection. User-facing behavior is in the [README](README.md).
