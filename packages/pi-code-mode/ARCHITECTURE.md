# Architecture

`pi-code-mode` owns one Effect-managed Pi extension. It provides trusted-project configuration,
the session lifecycle, `/code-mode-settings`, and one `code_mode` tool. A tool call runs one
confined JavaScript program over exactly seven supplied Pi built-ins under `tools.pi`: `read`,
`bash`, `edit`, `write`, `grep`, `find`, and `ls`. The private runtime also supplies
`tools.$codemode.search`.

The interpreter is the nested `pi-code-mode-runtime` workspace package under `runtime/` (ADR
0003). Its TypeScript source ships in this package and loads through one computed relative import
in `src/boundary/codemode-runtime.ts`. The nested package name is never resolved at runtime, so a
packed install needs no private registry package and uses the extension's single Effect instance.
Only runtime source and legal or provenance documents ship.

## Grouped ownership

- `src/extension.ts`, `application.ts`, and `layer.ts` own Pi registration, session replacement,
  the private runtime slot input, the synchronous state projection, and Layer composition.
- `src/config/` owns field schemas, defaults, bounds, tolerant scope resolution, provenance, and
  the only persistence door, `CodeModeConfigStore`.
- `src/settings/` owns command dispatch, completions, list behavior, custom integer flow, and
  notifications. `src/boundary/host-ui.ts` is the Promise and callback adapter for Pi dialogs.
- `src/tools/` owns the exact guest catalog, execution admission, UTF-8 limits, progress state,
  result formatting, failure-detail retention, tool registration, active-list reconciliation,
  and renderer ticker cleanup.
- `src/ui/` is pure presentation. `tool-render-details.ts` tolerantly normalizes current and
  legacy details, `tool-renderer.ts` renders calls and results, and `result-output.ts` projects
  small structured results without changing model-visible text.
- `src/boundary/` contains the runtime import, all seven fresh Pi built-in adapters, the guarded
  progress publisher, Pi dialog adapters, and the process-memory deactivation handoff.
- `tests/` covers configuration, atomic commits, lifecycle races, dialogs, adapters, limits,
  interpreter integration, progress, retention, and fail-soft rendering. `runtime/tests/` remains
  owned by the private runtime package.

## Trust and configuration

Global configuration is `<agent-dir>/extensions/pi-code-mode.json`. Project configuration is
`<cwd>/.pi/extensions/pi-code-mode.json`. Fields resolve project over global over default, one
field at a time. Malformed fields fall back independently and produce bounded path-only
diagnostics. Writes preserve unknown fields.

An untrusted project performs no project-document I/O. The project path may exist as inert
metadata, but the extension never stats, reads, or writes it. Availability is
`projectTrusted && config.enabled`.

`CodeModeConfigStore` serializes writes with one semaphore. Before commit it captures the other
scope's document. The committed document then resolves to the next state without post-commit I/O.
A Deferred carries publication from the JSON rename's narrow uninterruptible `afterCommit` region
back to the caller. The renamed document and authoritative frozen projection therefore advance as
one commit. A hostile publication callback becomes a typed `CodeModeConfigError`; the committed
file remains, the prior projection stays authoritative, and a later write re-derives from disk.

## Session lifecycle and publication

`session_start` captures cwd, trust, and an owned signal before replacing the prior runtime. A
capture failure shuts the old slot down. Each private slot input carries its own
`MutableRef<boolean>` publication owner, created immediately before `slot.start`. The Layer
publisher writes `stateRef` only while that owner is true.

`onDeactivated` first sets the owner false, then clears `stateRef` and deactivates `code_mode`.
This ordering blocks a prior session's uninterruptible commit from publishing after replacement
has begun. State remains unavailable until the replacement Layer publishes.

Startup acquires the store and, only when the live snapshot is available, runs preview settings
through `bestEffortHostBootstrap`. The bootstrap is interruptible, contains foreign failures, and
detaches a Promise that ignores cancellation. Startup returns `void`. `onActivated` first checks
both publication ownership and slot-token currency, then rereads the guarded live `stateRef`.
Definition construction, wrapping, registration, and activation retain currency checks before and
after host work. Preview settings always finish before `withCodePreviewShell` wraps the tool.

Replacement and shutdown revoke publication, interrupt startup and session fibers, dispose the
runtime, clear state, and deactivate only `code_mode`. Pi has no unregister operation, so every
old definition also checks its token and the current live availability before execution.

User deactivation survives module recreation through `host-deactivation-handoff.ts`. The old
instance publishes a true-only, TTL-bounded entry keyed only by Pi's stable session id. The next
instance consumes a matching entry. A different or missing id starts active; cwd is never an
identity fallback. Unrelated active-tool names and their order are preserved.

## Settings workflow

The bare TUI command submits one outer session Effect. It selects scope, opens the list, handles a
custom integer prompt, applies the value, and reopens from a fresh snapshot. Pi has one editor
slot, so `done(PromptInteger)` closes the list before `ctx.ui.input` opens.

Every list iteration records the Promises started by preset and `inherit` callbacks. Once the
custom list settles, the outer Effect joins all recorded writes before handling Closed or
PromptInteger, opening input, reading a new snapshot, or reopening. `applySetting` makes these
Promises nonrejecting. The join remains interruptible, so session disposal can end the outer
workflow even while a foreign callback settles late. A preset commit already inside the store's
uninterruptible commit region finishes publication before custom input continues.

All settings checks use one guarded `signalAborted` helper. It invokes the host getter through
`invokeHostCallback` and falls back to `true`. A throwing `aborted` getter therefore exits without
UI, persistence, or notification work. The same guard covers command admission, the active write
callback, list callbacks, input application, and reopen checks.

`host-ui.ts` adapts select, input, and custom dialogs. The custom adapter owns a callback
`AbortController` and exact-once latches. Its finalizer revokes callbacks and calls an available
`done(Closed)` once. A normal PromptInteger remains authoritative. A late factory receives an
inert component. Preset writes use the list signal, ignore stale callbacks, and restore the
persisted row after an active failure.

## Tool execution and limits

The catalog is exactly the seven `tools.pi` leaves plus runtime-owned search. Inputs pass Effect
Schema before dispatch. Fresh Pi definitions execute directly, so nested calls bypass Pi
`tool_call` and `tool_result` middleware, approvals, previews, registered overrides, and
session-specific operations (ADR 0004).

Interpreter confinement limits JavaScript, not supplied-tool authority. Bash has full local-user
process, environment, network, and filesystem authority. Read, edit, and write accept relative,
absolute, and home-relative paths. Mutations happen immediately and cancellation cannot roll them
back. Nested results carry text only; images are refused and built-in result details are dropped.

Each execution applies source, time, call-count, result, cumulative child-output, and discovery
budgets. The final `clampModelVisibleText` bounds all model-visible success, failure, cancellation,
source-refusal, and unexpected-error text by exact UTF-8 bytes without splitting a code point.
Zero bytes yields empty text. Only the stale or missing-state refusal uses a fixed bounded message
because no current configuration exists. Successful nested text and catchable failure text share
one cumulative budget. An output-overrun refusal is itself admitted through `admitFailure`, so
repeated caught overruns cannot create free diagnostic text.

Progress starts immediately. Queued admission and decoded running labels publish synchronously;
status-only changes coalesce to a 16 ms host frame, and settlement flushes the latest snapshot.
Rows never contain nested output. Selection prioritizes active, failed, cancelled, and recent rows
within 32 visible slots, while exact counts include hidden calls. Selected rows and counts are
copied before host publication, so a hostile `onUpdate` cannot alter execution state.

The renderer owns a weak 160 ms ticker. Missing or hostile state, invalidation, keybindings, clock,
and ticker callbacks fall back without affecting execution. The controller captures sanitized
expand keys once when it builds the definition. Pure render code always returns a component, even
when hostile details force its emergency path.

Thrown executions retain copied final rows and counts in a bounded one-shot map. The `tool_result`
hook consumes another copy for the matching Code Mode call because Pi otherwise replaces details
with `{}`. Text and `isError` semantics are unchanged.

## Shipping and validation

The package runs from TypeScript source under Pi/Jiti. `package.json` ships `runtime/src/` and the
runtime's legal or provenance files, but not its workspace manifest or tests. Package gates include
typecheck, Effect diagnostics, lint, format, tests, and a dry pack. Workspace validation also
checks layout, versions, source loading, and packed runtime contents.
