# Architecture

`pi-background-task` is an Effect-managed Pi extension for session-scoped local background tasks.

## Source map

- `src/extension.ts` is the thin Pi registration entrypoint; `src/layer.ts` owns session Layer
  composition; `src/application.ts` owns session lifecycle, tool, `/tasks`, footer, and Code Mode
  capability wiring. `src/settings/controller.ts` routes `/tasks status` to the active runtime's
  normalized config and keeps `/tasks` manager actions at Promise-shaped host boundaries.
- `src/config/` — schema/defaults, normalization, and `store.ts` as the single persistence door.
- `src/boundary/local-process.ts` — scoped Effect ChildProcess and process-tree adapter. Effect owns detached shell spawning, output streams, force escalation, and release; the boundary retains immediate graceful signal dispatch, the POSIX post-leader group sweep, and the Windows `taskkill /pid PID /T /F` tree terminator as a raw bounded `Effect.callback` around Node spawn. The terminator is deliberately not a scoped Effect spawner: its interruption cleanup (typically the 2-second timeout) synchronously removes the settle listeners, installs a harmless late-error listener, SIGKILLs, and unrefs without awaiting taskkill's own exit, so a hung taskkill can never hang the interrupting finalizer join. It requests color (`FORCE_COLOR=1` default, explicit `FORCE_COLOR`/`NO_COLOR` honored), and the bounded ingress queue evicts the oldest event when recent output must replace a full queue.
- `src/boundary/host-ui.ts` — exception-safe Pi status projection bridge for the footer and `/tasks`.
- `src/task/` — `bounds.ts` is the pure owner of command, resolved-cwd, name, task-id, and session-id character limits used by both schemas and service admission. The directory also owns the task model with its pure projection helpers (`sortTasksByActivity`, `footerStatus`, and `countTaskStates` as the single owner of the failed/timed-out counting policy), typed errors, bounded logs with shared UTF-8 byte accounting, and the scoped service. Bounded `wait` barriers reuse each task's completion and output wake signals, match literal text across retained chunks, and report timeout as data. Each `logs` or `wait` call retains the record it admitted and re-inspects that record under the registry semaphore, so later retention or clear operations affect only new lookups. One latch-driven worker coalesces output publications onto the configured leading/trailing interval; `totalLogBufferBytes` splits roughly in half between retained logs and per-process ingress buffers divided across `maxRunning`.
- `src/tools/` owns the shared action executor and schema plus `background_task` registration and
  pure collapsed or expanded log rendering. Command details are an action-discriminated union,
  and the public `pi-code-previews` cooperative shell decorates the registered tool.
- `src/code-mode/` and the public `src/protocol.ts` re-export own the versioned plain-data query
  contract for `tools.session.backgroundTask`, including the exact v1 Effect input/output codecs
  and their structural bounds. `output.ts` measures the exact serialized JSON size of the plain
  protocol types; the public protocol does not import package-local task models, services, commands, or
  process adapters. The package-local start-envelope check accounts for normalized request fields,
  generated identity, and immediate terminal metadata. Schema decoding then validates numeric
  metadata and creates a detached, frozen value with undeclared keys removed.
  `src/boundary/host-code-mode.ts` publishes one checked Promise capability bound to the current
  stable Pi session and slot token and decodes requests with the producer-owned input codec.
- `src/ui/` owns pure full-screen `/tasks` presentation (`manager.ts`) and bounded safe-SGR log rows (`styled-log.ts`), built on the `pi-cosmic-ui/manager` chrome, keymap, key-label, and list/detail primitives shared with `/subagents`. Generic selection/pane/layout/detail-scroll/page-size state and framed screen composition delegate to the shared `ListDetailShell` (`pi-cosmic-ui/manager/list-detail-shell`). The shared `listDetailFrame(theme)` supplies border renderers, and `framedFill` frames, clips, and fills raw content lines. The manager keeps follow semantics, stop/clear/technical actions and their confirmation policy, the cached themed log rows, state/row/detail presentation, help copy, geometry constants, and the narrow-only Enter policy. Half/full-page list motions page by the render-computed visible rows. Unfollow (`f`) is sticky: the anchored detail window keeps the viewed slice even before overflow and while new lines arrive, motions that scroll away from the newest lines detach follow without silently re-following at the bottom, and toggling follow back on returns to the newest lines.

## Ownership

`BackgroundTaskService` is the only task-registry owner. Before it acquires the registry permit, it trims command and name, resolves cwd, and applies the shared limits to those normalized values. Oversized metadata therefore cannot allocate an id, enter the registry, fork a monitor, or spawn a process even when a caller bypasses the TypeBox or Code Mode schema. An admitted `logs` or `wait` call captures one `TaskRecord`; wakes and timeouts re-inspect that retained record under the same semaphore. Eviction and `clear` remove discoverability for new calls without failing admitted readers or reinserting removed records. All process monitors share one fixed child scope created before the service shutdown finalizer, so shutdown requests and confirms active process settlement before monitor interruption without accumulating one owner-scope finalizer per historical task. Stop ownership is claimed while interruption is masked, then waits resume interruptibly. If the owner is interrupted, its finalizer force-terminates only an already-settled handle; the monitor force-terminates a handle that arrives later. A stop timeout or process-tree termination failure is a typed `BackgroundTerminationError`; the task remains `stopping`, consumes active capacity, and can become `stopped` only when the process handle's `awaitExit` joins the scoped exit observer after its process-group sweep. `stopAll` settles every captured active task before failing: one task's typed termination failure never interrupts a sibling's graceful-to-force workflow, tasks evicted mid-flight are tolerated, and remaining failures aggregate into one `BackgroundTerminationError` rather than a partial success. Closing the session runtime applies the same ordering to every active process tree. Release first unrefs the upstream Effect handle so its fallback finalizer cannot extend shutdown, then performs this boundary's bounded force-confirmation path; Windows always attempts `taskkill /T /F`, including after a clean leader exit, while POSIX performs the explicit post-leader group sweep. Pi callbacks only execute Effects through the managed session-runtime slot.

Session activation is slot-native: `session_start` captures cwd, trust, and stable session identity
once and starts the managed session-runtime slot with the captured abort signal; the slot
deactivates and disposes the prior runtime before any new-session work. Runtime startup then loads trusted code-preview settings as its first step (an injectable best-effort boundary for lifecycle tests) and returns only `showFooterStatus` as the activation value. The host bridge owns the empty initial and cleared projections; the service publishes later changes. Superseded starts never reach the settings boundary, and only the current-generation activation registers the wrapped `background_task` tool, so stale, aborted, or shutdown-invalidated starts cannot reactivate an older session. The application runner is additionally gated synchronously on slot activation: while a
replacement start is still loading settings the slot already holds the unactivated next runtime,
so stale tool, Code Mode adapter, or `/tasks` calls fail with a typed `PiSessionRuntimeError`
instead of executing against it. The Code Mode query listener is installed before session start,
but responds only for the current stable session while the slot token and top-level
`background_task` activation remain current. It runs the same action Effect as the top-level tool;
no second service or process registry exists. The capability receives Code Mode's current child
output allowance. The input codec first bounds command, name, cwd, and id. Query and capability
normalization also reject empty or oversized session ids. For nested `start`, the shared executor
trims command and name and resolves cwd, then the provider checks a conservative
full successful result before `BackgroundTaskService.start`. Failure cannot allocate an id, insert
a registry record, fork a monitor, or acquire a process. After execution, the provider still bounds
display text, applies collection limits, and measures the exact serialized JSON size before schema
decoding allocates the detached result. The producer-owned output codec rejects invalid metadata,
removes undeclared keys, and the provider freezes the accepted value before returning it.

The UI and host footer project immutable service snapshots; neither owns subprocesses. Code-preview settings are loaded before the tool definition is wrapped and registered; extensions exchange only the public plain tool-definition protocol.
