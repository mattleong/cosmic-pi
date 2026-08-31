# Architecture

`pi-herdr-btw` is an Effect-managed Pi extension for one reusable blank side session per parent Pi session. `/herdr-btw` focuses or resumes the linked child. `/herdr-btw:new` creates a fresh child and supersedes the link after confirmed startup and child-file validation. The extension never closes user-owned panes.

## Ownership and lifecycle

`src/extension.ts` is the registration entry. `src/application.ts` owns Pi event and command wiring. `src/layer.ts` composes `HerdrClient` into the session-scoped `HerdrBtwService` Layer, so the live application exposes only the workflow service.

`session_start` captures the guarded host session and constructs one managed runtime. The runtime owns command serialization and the Herdr workflows. The session slot publishes the immutable child parent-reference capability only from its generation-checked `onActivated` hook and clears it during deactivation. `session_shutdown` disposes the runtime but does not close panes or child sessions.

The two commands are TUI-only. A single Effect semaphore serializes calls within one extension runtime. Each command first probes the captured parent path through the bounded no-follow session-header boundary and requires its header ID to match the captured parent ID. Parent and child paths must also resolve to distinct regular files before startup or reuse. Command handlers resolve with `HerdrBtwResult`; typed workflow failures and runtime rejection remain Promise failures that the TUI controller reports through the same bounded notification path. Prompt text reaches the command directly and is passed to Herdr as one bounded argument.

## Reusable side session

The parent stores a versioned `pi-herdr-btw/reusable-link` custom entry. Each link includes:

- the owning parent session ID and path
- the child session ID and path
- the live Herdr agent name and terminal ID

Parent ownership fields matter because native Pi forks copy custom entries. The application captures the launch owner once with the rest of the session input and passes that value into the link store. Store construction does not read the host again. Immediately before every restore or record, the store rechecks both live host values and the no-follow header ID against the captured owner. It filters copied ancestor entries before returning a restoration.

Record accepts child facts only. The store stamps version 1 and the captured owner before calling `pi.appendEntry`. An owner mismatch or host failure before that call returns `refused`, which confirms that no append was attempted. A normal return reports `recorded`. Any throw from `appendEntry` reports `uncertain` because persistence may already have happened. The workflow does not reread, retry, prompt, focus, or close after an uncertain record. It reports the uncertainty and retains the pane for inspection.

A new side session does not use `--fork`. After the new pane reaches a stable shell, the session-file boundary reads the Effect clock and exclusively creates a 0600 blank Pi header with `wx`, a preassigned child ID, and no `parentSession` lineage. The service validates that file, then starts Pi with `--session` so the child is resumable even before its first assistant message. Commit requires the launch response to contain the exact pane, terminal, Pi agent name, and path-based `agent_session` evidence. That reported path may be a lexical alias or hardlink, but it must resolve to the prepared child file and remain distinct from the parent file. ID-only startup evidence is not enough. Missing or mismatched session metadata leaves the pane retained and the prior link untouched. The service validates the child header again after startup and only then records the reusable link. A confirmed record remains authoritative if later optional prompt delivery or focus fails, because the child already exists and must not become orphaned.

Reuse validates the linked child header and parent-child file distinction before reading live Herdr state. A snapshot agent becomes a conflict candidate when its name matches the recorded agent, its path metadata is not proven distinct from the child file, or its ID metadata equals the recorded child ID. An unavailable path comparison remains a conflict. This catches pending and wrong `agent_session` metadata instead of starting a duplicate name. One candidate is focused only when its recorded name and terminal, top-level Pi kind, and path-or-ID child identity all match. Multiple candidates or any mismatch fail closed. No candidate prepares a new sibling pane and reopens the child with `--session`.

The resume path takes another snapshot immediately before `agent start` and applies the same conflict rule. If a candidate appeared while the pane was prepared, startup is refused and the empty pane is retained for inspection. This narrows the duplicate-writer race but is not a cross-process session-file lease. A manually launched Pi under an unrelated name and path remains outside this coordination boundary. Child files share the normal project session directory, so Pi's recency-based `--continue` selection may choose a side session.

`/herdr-btw:new` skips link reuse and creates a new blank child. It appends a replacement link only after startup and child validation. Failures before that commit leave the previous link authoritative.

## Live parent reference

Every child launch receives fixed extension flags containing the parent ID, parent file, and owning child ID. Pure parent-link policy resolves a bounded candidate from those markers and the current child identity. The host boundary activates it only when:

- the current child session ID matches the child marker
- the raw parent path differs from the raw child path as a cheap pure rejection
- the bounded no-follow identity comparator confirms distinct parent and child files
- a bounded no-follow parent-header probe succeeds
- the probed parent ID matches the parent marker

`before_agent_start` repeats the filesystem-identity comparison and header probe for every child run. A same-file result or unavailable probe deactivates the reference. It appends a stable system-prompt instruction with the JSON-quoted parent path and expected ID. No transcript content is read or imported. There is no polling, cursor, dedicated tool, automatic synchronization, or return channel.

The synchronous reference value is a plain host projection. The generation-checked application slot controls activation and clearing; the Effect runtime remains the owner of session lifetime.

## Boundaries

- `src/boundary/herdr-client.ts` defines the typed `HerdrClient` service. It alone owns the fixed `herdr` executable, every argument array and deadline, the selected environment, mutation outcome classification, and Effect Schema decoding for pane, agent, process, layout, protocol, and snapshot responses. Workflows call semantic operations and tests replace this owned client rather than the CLI transport.
- `src/boundary/session-file.ts` owns cryptographic child IDs, Effect-clock blank-session creation, header probes, and session-file identity. Its tri-state comparator bounds and normalizes absolute paths, opens regular files read-only with `O_NOFOLLOW` and nonblocking flags, and compares descriptor `dev` and `ino`. Any failed probe returns `unavailable`, never `distinct`. The boundary never uses `SessionManager`, so validation cannot migrate or rewrite a session.
- `src/boundary/host-link-store.ts` is the single persistence door over `pi.appendEntry` and read-only parent session entries. It owns live-owner revalidation, version and parent-field stamping, and append uncertainty classification. `src/boundary/host-parent-reference.ts` owns the synchronous Pi flags, session getters, header probes, ID verification, and prompt-hook bridge.
- `src/btw/service.ts` is the service door. `src/btw/validation.ts` contains preflight, shell readiness, and shared native identity predicates. `src/btw/link.ts`, `marker.ts`, and `policy.ts` hold schemas and pure policy, including child display-name derivation.
- `src/parent-link/policy.ts` owns pure marker and child-candidate resolution plus prompt formatting. The application slot, not the host bridge, owns generation-checked publication.

All Herdr commands use fixed argument arrays with no shell. Outputs and identifiers are bounded and schema-decoded. Parent and child session files must be regular non-symlink files. A mutation-side `BoundedProcessError` is confirmed only for `operation: "spawn"`, before dispatch; stream and later transport failures remain outcome-uncertain. Expected failures are typed `HerdrBtwError` values. Mutating requests with uncertain outcomes are never retried automatically, and any pane created before a later failure is retained rather than closed.
