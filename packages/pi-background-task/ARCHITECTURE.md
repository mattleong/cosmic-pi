# Architecture

Custom screens use the shared live viewport: centered at 90% of terminal width and height at 125×30 or larger, otherwise full bounds. Resize keeps the same component lifetime and selection state.

`pi-background-task` is an Effect-managed Pi extension for session-scoped local background tasks.

## Source map

- `src/extension.ts` is the thin Pi registration entrypoint; `src/layer.ts` owns session Layer
  composition; `src/application.ts` owns session lifecycle, tool, `/tasks`, footer, and Code Mode
  capability wiring. `src/settings/controller.ts` routes `/tasks status` to the active runtime's
  normalized config and keeps `/tasks` manager actions at Promise-shaped host boundaries. The manager
  opens on Cosmic UI's shared `screen` surface, so closing never pops an overlay stacked above it; a
  failed opening rejects the command.
- `src/config/` — schema/defaults, normalization, and `store.ts` as the single persistence door. The store resolves project over global through core's `makeScopedConfigStore` with no default document, so it never writes and never probes an untrusted project.
- `src/boundary/local-process.ts` — scoped Effect ChildProcess and process-tree adapter. Cwd inspection runs interruptibly before the masked process acquisition and release handoff. Effect owns detached shell spawning, output streams, force escalation, and release; the boundary owns the termination policy over core's process-tree helpers: immediate graceful group signal dispatch with a leader fallback, the POSIX post-leader group sweep, and Windows graceful and force `taskkill` through core's bounded `terminateWindowsProcessTree`. Every core terminator failure maps to the redacted `LocalProcessError`. One process-scope fiber owns the immediately dispatched graceful helper. Repeated graceful requests reuse that attempt; force escalation interrupts and joins it first, then serializes bounded force attempts so a failed attempt can be retried. Graceful timeout does not prevent escalation. Core's terminator cleans up synchronously on interruption (typically the 2-second timeout) without awaiting taskkill's own exit, so a hung taskkill can never hang the interrupting finalizer join. It requests color (`FORCE_COLOR=1` default, explicit `FORCE_COLOR`/`NO_COLOR` honored), and the bounded ingress queue evicts the oldest event when recent output must replace a full queue.
- `src/boundary/host-ui.ts` — exception-safe Pi status projection bridge for the footer and `/tasks`.
- `src/boundary/host-activity.ts` registers session-token-bound Cosmic UI activity summaries from frozen task views through Cosmic UI's `registerRevisionedActivityProvider`. Summaries omit logs and remain root entries because tasks have no `ownerRunId`. The producer redacts credentials before summaries or selected details leave its boundary. Selected details materialize only the chosen task's bounded recent log tail through a revision/session/cancellation-checked capability. Stop declares process-tree confirmation scope, rechecks the item revision, active state, and session, then passes the host abort signal to `BackgroundTaskService`; replacement and shutdown revoke callbacks and registration. `/tasks` remains the advanced manager and footer fallback remains independent.
- `src/task/` — `bounds.ts` is the pure owner of the command, resolved-cwd, name, task-id, and session-id admission limits used by both schemas and service admission, plus the signal, error, and snapshot-count output-contract limits. `schema.ts` is the pure owner of the task contract: the action and state vocabularies, the snapshot, log-metadata, and wait schemas, and the persisted `background_task` details union. Its shared member schemas are part of the frozen v1 Code Mode output contract, so their field and literal order must not change. `model.ts` derives its types from them and intersects domain-only fields such as log events and `awaited` locally. The directory also owns the task model with its pure projection helpers (`sortTasksByActivity`, `footerStatus`, and `countTaskStates` as the single owner of the failed/timed-out counting policy), typed errors, bounded logs with shared UTF-8 byte accounting, and the scoped service. Bounded `wait` barriers reuse each task's completion and output wake signals, match literal text across retained chunks, and report timeout as data. Each wait owns a scoped reference count on its admitted record under the registry semaphore. The task view publishes `awaited` until the last waiter completes, times out, or is interrupted; Cosmic UI uses the same await marker as subagents. Tool and Code Mode waits share this service-owned tracking without changing task state or stopping the process. One latch-driven worker coalesces output publications onto the configured leading/trailing interval; `totalLogBufferBytes` splits roughly in half between retained logs and per-process ingress buffers divided across `maxRunning`.
- `src/tools/` owns the shared action executor and schema plus `background_task` registration and
  pure collapsed or expanded log rendering over the shared Cosmic UI tool header and expansion hint. Command details are the
  shared action-discriminated union and carry metadata only: `logs` details keep cursors and five truncation fields, never
  log events or truncated text. The one exception is a details snapshot's `failureLine`: when a task fails, the service
  keeps the first line of its recent output that names the failure, redacted and at most 64 characters, so the row can say
  why. It lives in the details snapshot schema only; the frozen v1 Code Mode contract never carries it. The public `pi-code-previews` cooperative shell decorates the registered tool with an explicit
  `src/ui/compact-summary.ts` provider. This pure projection decodes the details with the shared task schema,
  distinguishes management completion from task state, and reports failure, cleanup, timeout,
  and output-loss problems as shared `CompactIssue`s with task-scoped codes (`<taskId>:<code>`).
  Each issue has one short human message; agent-facing recovery, cursors, and byte counts live
  only in its expanded `detail`, and retrieval hints are expanded-only `info` issues. Unclassified
  task errors use their first line as the message and keep the full text as detail. A non-zero exit adds its
  `failureLine`, else the meaning of a conventional exit code or signal (127 command not found, 137 killed). Aggregate
  `list`/`stop_all` messages name each task by its unique name, else its ID. Compact expansion uses a content-only callback that preserves fetched text and cursors without parsing log words; the shell owns status and issue rendering. Preview style keeps the original callbacks. Status and failure causes belong in the subject or
  issues, not optional metadata; stopped signals remain cancellation rather than failure.
  Clean exited log slices report successful retrieval, not verified process success; their
  contractual lack of exit codes is not a warning. Snapshot-based status still requires exit
  evidence. Snapshot summaries prefer the optional task name, then ID; live starts use the name
  or command. One detail combines state/exit or wait evidence, and lists combine state counts.
  Failed or stopping tasks, lost logs, and truncated output retain attention.
  Unknown details and outer tool errors retain the original renderer; no process state,
  execution, or lifecycle behavior depends on the collapsed style.
- `src/code-mode/` and the public `src/protocol.ts` re-export own the versioned plain-data query
  contract for `tools.session.backgroundTask` and its bounded Effect codecs. Its explicit input and
  output unions reuse the shared task member schemas; `src/code-mode/protocol.ts` imports only the pure
  task bounds and schemas, never task models, services, commands, or process adapters. The
  `src/protocol.ts` door also re-exports `output.ts`, which loads the shared executor and service
  modules. `output.ts` owns output size checks and projection; `src/boundary/host-code-mode.ts` publishes the session-bound capability.
  Admission and revocation rules are described below.
- `src/ui/` owns pure full-screen `/tasks` presentation (`manager.ts`) and bounded safe-SGR log rows (`styled-log.ts`), built on the `pi-cosmic-ui/manager` chrome, keymap, key-label, and list/detail primitives shared with `/subagents`. Generic selection/pane/layout/detail-scroll/page-size state and framed screen composition delegate to the shared `ListDetailShell` (`pi-cosmic-ui/manager/list-detail-shell`). The shared `manager/style` roles distinguish task identities and technical values while retaining status and log colors. Selected controls use the shared focus treatment only in the active list pane. The shared `listDetailFrame(theme, pane)` supplies muted enclosing frames and current-focus pane edges, `listDetailHeading` styles pane headings, and `detailFieldRows` formats status and technical fields. `framedFill` frames, clips, and fills raw content lines. The manager keeps follow semantics, stop/clear/technical actions and their confirmation policy, the cached themed log rows, state/row/detail presentation, help copy, geometry constants, and Enter-to-inspect navigation in every layout. Technical metadata and logs wrap before windowing; Esc returns from inspection before closing. Half/full-page list motions page by the render-computed visible rows. Unfollow (`f`) is sticky: the anchored detail window keeps the viewed slice even before overflow and while new lines arrive, motions that scroll away from the newest lines detach follow without silently re-following at the bottom, and toggling follow back on returns to the newest lines.

## Operational limits

Tasks have local-user command authority, not a sandbox. Do not record inherited environment values, persist command output automatically, or include command/path data in telemetry. Completion does not inject model context, trigger turns, or send notifications.

Literal output waits match across retained chunks within one stream. Dropped-byte boundaries reset partial matches. Cleanup cannot be guaranteed after host `SIGKILL` or machine loss. Windows post-leader cleanup remains best effort without Job Objects.

## Ownership

`BackgroundTaskService` is the only task-registry owner. Before it acquires the registry permit, it trims command and name, resolves cwd, and applies the shared limits to those normalized values. Oversized metadata therefore cannot allocate an id, enter the registry, fork a monitor, or spawn a process even when a caller bypasses the TypeBox or Code Mode schema. An admitted `logs` or `wait` call captures one `TaskRecord`; wakes and timeouts re-inspect that retained record under the same semaphore. Eviction and `clear` remove discoverability for new calls without failing admitted readers or reinserting removed records. All process monitors share one fixed child scope created before the service shutdown finalizer, so shutdown requests and confirms active process settlement before monitor interruption without accumulating one owner-scope finalizer per historical task. Stop ownership is claimed while interruption is masked, then waits resume interruptibly. If the owner is interrupted, its finalizer force-terminates only an already-settled handle; the monitor force-terminates a handle that arrives later. A stop timeout or process-tree termination failure is a typed `BackgroundTerminationError`; the task remains `stopping`, consumes active capacity, and can become `stopped` only when the process handle's `awaitExit` joins the scoped exit observer after its process-group sweep. `stopAll` settles every captured active task before failing: one task's typed termination failure never interrupts a sibling's graceful-to-force workflow, tasks evicted mid-flight are tolerated, and remaining failures aggregate into one `BackgroundTerminationError` rather than a partial success. Closing the session runtime applies the same ordering to every active process tree. Release first unrefs the upstream Effect handle so its fallback finalizer cannot extend shutdown, then performs this boundary's bounded force-confirmation path; Windows always attempts `taskkill /T /F`, including after a clean leader exit (it passes core no exited-target skip), while POSIX performs the explicit post-leader group sweep. Pi callbacks only execute Effects through the managed session-runtime slot.

Session activation is slot-native: `session_start` captures cwd, trust, and stable session identity
once and starts the managed session-runtime slot with the captured abort signal; the slot
deactivates and disposes the prior runtime before any new-session work. Runtime startup then loads trusted code-preview settings as its first step (an injectable best-effort boundary for lifecycle tests) and returns `showFooterStatus` and the scoped animation scheduler as the activation value. The host bridge owns the empty initial and cleared projections; the service publishes later changes. Superseded starts never reach the settings boundary, and only the current-generation activation registers the wrapped `background_task` tool, so stale, aborted, or shutdown-invalidated starts cannot reactivate an older session. The application runner is additionally gated synchronously on slot activation: while a
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

Each `TaskRecord` owns one mutable `LogBuffer` under the registry semaphore. Its offset-backed
store compacts amortized dead prefixes; consumers retain only cached detached event slices.
Appending or evicting logs never changes an earlier slice or its events.

The UI and host footer project immutable service snapshots; neither owns subprocesses. Extensions exchange only the public plain tool-definition protocol.

The application Layer owns `CodePreviewSchedulerService` in the same session runtime as its tools. Startup returns that scheduler to activation, which passes a token-checked scheduling capability to each cooperative wrapper. Replacement and shutdown close animation fibers; retained wrappers cannot schedule against a stale session. No animation depends on another extension's Jiti module instance.

The side-effect-free `pi-background-task/code-mode` door exports `projectBackgroundTaskCompactSummary({ phase, args, result, isError })`. Standalone rendering delegates to it. An optional `presentationVersion: 2` capability acknowledgement enables the fifth `execute` argument, a best-effort presentation observer; providers acknowledging only the older v1 receipt are not observed. The host derives a versioned semantic receipt from the original command result before guest output projection drops log truncation. Its summary is a plain `CompactSummary` (`action`, `subject`, `compactSubject`, `outcome`, `metadata`, `counters`, `issues`) that Code Mode can use directly. The receipt contains no log text or raw arguments/results. Its schema bounds strings, arrays, and issues through the shared bounded issue schema; overflow drops the summary and explicitly marks evidence incomplete rather than clipping it. Missing receipts from older providers remain incomplete evidence. Observer throws and rejected thenables cannot change execution or its v1 output contract.
