# Architecture

`pi-herdr-fork` is an Effect-managed Pi extension with one deterministic command. `/herdr-fork` creates a native Pi fork in the calling pane's current Herdr tab and deliberately transfers ownership to the user after startup.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — Pi session runtime lifecycle and command wiring.
- `src/settings/controller.ts` — `/herdr-fork` host command registration and TUI feedback.
- `src/boundary/herdr-client.ts` — fixed scoped Effect/Herdr child-process and Effect Schema protocol boundary, with injectable executable/process seams limited to deterministic tests.
- `src/boundary/host-session.ts` — guarded Pi session, inherited Herdr environment, and parent-session file capture.
- `src/boundary/host-notifier.ts` — best-effort Pi notification boundary.
- `src/fork/errors.ts` — schema-backed expected failures and outcome classification.
- `src/fork/policy.ts` — pure split, agent-name, and initial-prompt policies.
- `src/fork/service.ts` — preflight, launch sequencing, ownership validation, focus, and user handoff.
- `tests/` — command, policy, sequencing, topology, and uncertain-outcome coverage.

## Lifecycle

The extension factory registers callbacks and `/herdr-fork` but starts no process. `session_start` atomically captures cwd, signal, and initial aborted state through the shared guarded session boundary, then captures immutable parent-session and Herdr routing inputs. Capture failure or an already-aborted session fails closed; the exact captured signal is passed to the one managed runtime and the raw host getter is never reread. `session_shutdown` disposes only that runtime; it never closes a successfully handed-off pane.

The command is TUI-only and can run without waiting for the main agent to settle. It receives its optional prompt directly from Pi, so no model or shell expands command arguments.

## Boundaries

The Herdr client captures and allowlists inherited routing once, invokes only the fixed `herdr` executable with argument arrays and no shell, and decodes JSON responses with Effect Schema. Each command is an asynchronous scoped Effect child resource: timeout, caller interruption, or scope closure terminates its process group and waits for bounded close confirmation. Stdout and stderr are independently byte-bounded; overflow terminates the child and fails closed. Process transport failures retain the existing confirmed read-only versus outcome-uncertain mutation classification, while recognized structured mutation precondition rejections remain confirmed not applied.

The service requires protocol 17 or newer, a current Herdr Pi integration, a regular non-symlink parent session file, and inherited caller-pane identity before topology mutation. It targets `pane current --current`, verifies the split remains in the same workspace/tab, then requires sustained shell ownership across a bounded read-only `pane process-info` readiness window before dispatching `agent start`. It requires the atomic startup response to match the exact pane, terminal, workspace, tab, agent name, and Pi runtime before reporting success. Native child-session metadata is also validated when present, but it is not required because the Pi integration can report it after interactive readiness; this user-owned handoff never adopts identity from a later lookup.

## Ownership

Topology creation is managed only until the forked Pi is confirmed. The successful pane is user-owned and intentionally survives the parent Pi session. The package persists no topology record and performs no shutdown cleanup or later adoption.

A failed mutating request is outcome-uncertain and is never retried automatically, except when Herdr returns a recognized structured precondition rejection such as `agent_pane_busy`; that is confirmed not applied. Read-only shell readiness inspections may repeat within a fixed deadline. Once a split has occurred, one structural Effect ownership region covers topology validation, shell readiness, startup, prompting, and focus. Every later failure retains the exact pane for inspection without changing its confirmed/uncertain classification, rather than risk closing a fork whose startup result is ambiguous.

## Security

The command accepts only an optional bounded initial prompt. It accepts no executable, session selector, working directory, environment, arbitrary Pi arguments, or Herdr target. Prompt text receives a fixed non-flag prefix and is passed as one process argument.

The fork is not isolated: it shares the parent's project directory and normal Pi configuration, and it may mutate files concurrently. Conversation context is a point-in-time native fork and is not synchronized afterward.
