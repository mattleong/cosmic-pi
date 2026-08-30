# Architecture

`pi-herdr-btw` is an Effect-managed Pi extension for one reusable blank side session per parent Pi session. `/herdr-btw` focuses or resumes the linked child. `/herdr-btw:new` creates a fresh child and supersedes the link after confirmed startup and child-file validation. The extension never closes user-owned panes.

## Ownership and lifecycle

`src/extension.ts` is the registration entry. `src/application.ts` owns Pi event and command wiring. `src/layer.ts` composes `HerdrClient` into the session-scoped `HerdrBtwService` Layer, so the live application exposes only the workflow service.

`session_start` captures the guarded host session and constructs one managed runtime. The runtime owns command serialization and the Herdr workflows. The session slot publishes the immutable child parent-reference capability only from its generation-checked `onActivated` hook and clears it during deactivation. `session_shutdown` disposes the runtime but does not close panes or child sessions.

The two commands are TUI-only. A single Effect semaphore serializes calls within one extension runtime. Command handlers resolve with `HerdrBtwResult`; typed workflow failures and runtime rejection remain Promise failures that the TUI controller reports through the same bounded notification path. Prompt text reaches the command directly and is passed to Herdr as one bounded argument.

## Reusable side session

The parent stores a versioned `pi-herdr-btw/reusable-link` custom entry. Each link includes:

- the owning parent session ID and path
- the child session ID and path
- the live Herdr agent name and terminal ID

Parent ownership fields matter because native Pi forks copy custom entries. The link store filters copied ancestor entries before returning a restoration, so the workflow does not repeat that ownership check. A malformed unscoped or current-owner record fails closed.

A new side session does not use `--fork`. After the new pane reaches a stable shell, the session-file boundary reads the Effect clock and exclusively creates a 0600 blank Pi header with `wx`, a preassigned child ID, and no `parentSession` lineage. The service validates that file, then starts Pi with `--session` so the child is resumable even before its first assistant message. It validates the header again after startup and only then appends the reusable link. This commit remains authoritative if later optional prompt delivery or focus fails, because the child already exists and must not become orphaned.

Reuse validates the linked child header before reading live Herdr state. A fresh bounded `herdr api snapshot` has three outcomes:

- One matching session path, agent name, and terminal focuses the existing child.
- More than one match or an identity mismatch fails closed.
- No match prepares a new sibling pane and reopens the child with `--session`.

The resume path takes another snapshot immediately before `agent start`. If the child became live while the pane was prepared, startup is refused and the empty pane is retained for inspection. This narrows the duplicate-writer race but is not a cross-process session-file lease. A manually launched or non-Herdr Pi remains outside this coordination boundary. Child files share the normal project session directory, so Pi's recency-based `--continue` selection may choose a side session.

`/herdr-btw:new` skips link reuse and creates a new blank child. It appends a replacement link only after startup and child validation. Failures before that commit leave the previous link authoritative.

## Live parent reference

Every child launch receives fixed extension flags containing the parent ID, parent file, and owning child ID. The child activates the capability only when:

- the current child session ID matches the child marker
- the parent path differs from the child path
- a bounded no-follow parent-header probe succeeds
- the probed parent ID matches the parent marker

`before_agent_start` repeats that identity probe for every child run. It appends a stable system-prompt instruction with the JSON-quoted parent path and expected ID. No transcript content is read or imported. There is no polling, cursor, dedicated tool, automatic synchronization, or return channel.

The synchronous reference value is a plain host projection. The generation-checked application slot controls activation and clearing; the Effect runtime remains the owner of session lifetime.

## Boundaries

- `src/boundary/herdr-client.ts` defines the typed `HerdrClient` service. It alone owns the fixed `herdr` executable, every argument array and deadline, the selected environment, mutation outcome classification, and Effect Schema decoding for pane, agent, process, layout, protocol, and snapshot responses. Workflows call semantic operations and tests replace this owned client rather than the CLI transport.
- `src/boundary/session-file.ts` owns cryptographic child IDs, Effect-clock blank-session creation, and the shared regular non-symlink session-file check used by parent validation and header probes. It opens read-only descriptors with `O_NOFOLLOW` and nonblocking flags, verifies each descriptor is a regular file, bounds header reads, and never uses `SessionManager`, so validation cannot migrate or rewrite a session.
- `src/boundary/host-link-store.ts` is the single persistence door over `pi.appendEntry` and read-only parent session entries.
- `src/btw/service.ts` is the service door. `src/btw/validation.ts` contains internal preflight, shell-readiness, and native identity checks. `src/btw/link.ts`, `marker.ts`, and `policy.ts` hold schemas and pure policy.
- `src/parent-link/` contains pure reference resolution, prompt formatting, and the synchronous Pi host bridge.

All Herdr commands use fixed argument arrays with no shell. Outputs and identifiers are bounded and schema-decoded. Parent and child session files must be regular non-symlink files. Expected failures are typed `HerdrBtwError` values. Mutating requests with uncertain outcomes are never retried automatically, and any pane created before a later failure is retained rather than closed.
