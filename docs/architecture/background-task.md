# Background task extension specification

Status: implemented MVP

## 1. Summary

Add a `pi-background-task` extension that lets the main agent autonomously start, inspect, and stop long-running local commands without blocking the current agent turn. Users retain a visual manager for observation and emergency control, but operational routing belongs to the agent tool.

The MVP is deliberately a **background task manager**, not a pseudo-terminal implementation. Tasks are non-interactive shell commands with captured output. They are owned by the current Pi session and are terminated during reload, session replacement, fork, or shutdown.

## 2. Goals

- Start a local command and return immediately with a stable task ID.
- Capture bounded, ordered stdout and stderr output.
- Inspect task status and incrementally read logs without aggressive polling.
- Stop one task or all tasks and terminate their process trees reliably.
- Give the main agent one complete management tool and give users a TUI manager for observation and emergency control.
- Make lifecycle ownership explicit with Effect scopes and typed failures.
- Preserve usable behavior in TUI, RPC, JSON, and print modes.

## 3. Non-goals for MVP

- Interactive PTYs or sending stdin to a running task.
- Reattaching after Pi exits or restarts.
- Keeping tasks alive across `/new`, `/resume`, `/fork`, `/clone`, or `/reload`.
- SSH, containers, sandboxes, or remote execution backends.
- Replacing Pi's built-in foreground `bash` tool.
- Automatically injecting task completion into model context or triggering a new turn.
- Persisting complete, unbounded process output.

## 4. Product semantics

### 4.1 Task lifetime

Tasks are session-scoped resources.

- The extension starts no processes from its factory.
- The session runtime is acquired from `session_start` and closed from an idempotent `session_shutdown` handler.
- Scope closure stops every active process tree, waits for bounded cleanup, releases output listeners, and clears extension UI.
- A resumed session does not restore historical tasks. Old tool results remain ordinary session history but do not represent live processes.
- Graceful Pi shutdown is covered. No guarantee is possible after an uncatchable host termination such as `SIGKILL` or machine loss.

### 4.2 Task identity

Each task receives a short, session-local monotonic ID:

```text
task-1
task-2
task-3
```

IDs are never reused within one extension runtime. An optional display name does not replace the ID and need not be unique.

### 4.3 Task states

```text
starting -> running -> exited
                    -> failed
                    -> stopping -> stopped
                    -> timed_out
```

`starting` becomes `running` only after the child emits its spawn event. Spawn errors become `failed`. Terminal states are immutable.

A task snapshot contains:

```ts
interface BackgroundTaskSnapshot {
  readonly id: string;
  readonly name?: string;
  readonly command: string;
  readonly cwd: string;
  readonly state:
    | "starting"
    | "running"
    | "stopping"
    | "exited"
    | "failed"
    | "stopped"
    | "timed_out";
  readonly pid?: number;
  readonly startedAt: number;
  readonly endedAt?: number;
  readonly exitCode?: number | null;
  readonly signal?: string;
  readonly error?: string;
  readonly logCursor: number;
  readonly droppedLogBytes: number;
}
```

### 4.4 Capacity and retention

Recommended defaults:

- Maximum running tasks: 8.
- Maximum retained completed task snapshots: 50.
- Per-task in-memory log buffer: 256 KiB.
- Total in-memory log budget: 2 MiB.
- Stop grace period: 2 seconds.
- Maximum long-poll wait: 30 seconds.

Capacity applies to `starting`, `running`, and `stopping` tasks. When retention exceeds its limit, evict the oldest completed tasks only. Never evict an active task.

The total log budget is split roughly in half: one half bounds retained in-memory logs across all tasks and the other funds per-process ingress buffers divided across the running-task capacity.

### 4.5 Output model

- Capture stdout and stderr independently at the process boundary.
- Merge them into one ordered event stream by arrival order while preserving a `stdout` or `stderr` tag.
- Assign every log event a monotonic cursor.
- Retain only a bounded tail in memory.
- Report the earliest retained cursor and the number of dropped bytes so consumers can detect gaps.
- Decode process bytes incrementally so split UTF-8 code points are not corrupted.
- Normalize neither ANSI escapes nor carriage returns in the domain layer. TUI rendering may sanitize control sequences that could alter the host terminal.
- Do not create an unbounded log file. Users requiring complete output should redirect the command to a project file explicitly.

Example log result:

```ts
interface BackgroundLogSlice {
  readonly id: string;
  readonly events: ReadonlyArray<{
    readonly cursor: number;
    readonly stream: "stdout" | "stderr";
    readonly text: string;
    readonly timestamp: number;
    readonly bytes: number;
  }>;
  readonly nextCursor: number;
  readonly earliestAvailableCursor: number;
  readonly droppedBytes: number;
  readonly state: BackgroundTaskSnapshot["state"];
}
```

## 5. Agent tool

Register one tool named `background_task`.

Use TypeBox for the Pi tool schema and `StringEnum` for `action`. Perform action-specific validation in the application service and model expected failures as tagged errors.

### 5.1 Actions

#### `start`

Inputs:

- `command` — required, non-empty shell command.
- `cwd` — optional path; relative paths resolve against `ctx.cwd`. Any existing local directory is allowed.
- `name` — optional short display name.
- `timeoutSeconds` — optional positive finite runtime limit. When omitted, the task has no runtime timeout.

Returns immediately after spawn succeeds with the initial task snapshot. It does not wait for command completion.

#### `list`

Inputs:

- `state` — optional `active`, `completed`, or `all`; defaults to `all`.

Returns compact snapshots ordered with active tasks first, then newest completed tasks.

#### `status`

Inputs:

- `id` — required.

Returns one complete snapshot.

#### `logs`

Inputs:

- `id` — required.
- `afterCursor` — optional; omit to receive the current tail.
- `tailLines` — optional when `afterCursor` is absent; default 200, maximum 2,000.
- `waitSeconds` — optional long-poll duration from 0 through 30 seconds.

If no newer log event exists and the task is active, wait until output arrives, the task settles, the caller aborts, or `waitSeconds` expires. Return a cursor even when no output arrives. This avoids repeated fixed-delay polling.

#### `stop`

Inputs:

- `id` — required.
- `force` — optional; defaults to false.

Normal stop requests graceful process-tree termination, waits for the configured grace period, then escalates. Force stop escalates immediately. Repeated stop requests are idempotent and await the same terminal transition.

#### `stop_all`

Stops all active tasks concurrently with bounded concurrency and returns their final snapshots in the captured order. Every captured task receives a termination request even when a sibling stop fails with a typed error; only external interruption or a defect interrupts the batch. A task that settles and is evicted between capture and stop is tolerated as success. Remaining failures aggregate into one `BackgroundTerminationError`; a failed batch never reports partial success.

#### `clear`

Removes completed task metadata. Active tasks are unaffected.

### 5.2 Prompt metadata

Suggested prompt snippet:

> Start and manage long-running local commands without blocking the current turn.

Suggested guidelines:

- The main agent should decide whether a command belongs in `background_task` based on whether work can continue independently; use `bash` when the next step immediately depends on command completion.
- Use `background_task` for servers, watchers, long-running test suites, and other processes that should remain active while the agent continues working.
- Use `background_task` log cursors and long polling instead of repeatedly polling at fixed intervals.
- Stop background tasks when they are no longer needed. All tasks are terminated when the Pi session is replaced or shut down.

### 5.3 Tool rendering

Default collapsed rendering should show:

```text
◉ task-3 dev-server  running  18s
  npm run dev
```

Terminal states use success, warning, or error colors. Expanded results include cwd, PID, exit details, dropped-log information, and a bounded log tail. Tool rendering must sanitize terminal control sequences and obey render width. The package decorates its own tool definition with the public `pi-code-previews` cooperative shell after loading trusted session settings, preserving tool ownership while sharing configured shell chrome and timing.

## 6. Human-facing launcher

### `/tasks`

This is the only slash command in the MVP. It opens the interactive task manager in TUI mode and does not accept operational subcommands.

Starting, listing, reading, stopping, and clearing tasks are agent-facing operations exposed through `background_task`. A user who wants work placed in the background asks the main agent naturally rather than manually translating that intent into process commands.

The TUI manager may still provide direct stop and clear controls as an emergency human override. It does not provide a command-entry field or a separate path for starting tasks.

In RPC mode, `/tasks` reports that the manager requires TUI. JSON and print modes have no UI response channel, so the command is a no-op there. Programmatic clients use the `background_task` tool.

## 7. TUI manager

Use a terminal-sized `ctx.ui.custom()` overlay to present the full-screen task manager. The overlay is anchored at the top-left and constrained to 100% of the available terminal rows and columns, so Pi's editor widgets and footer cannot push it outside the viewport. It does not enter a separate OS alternate-screen buffer and is removed when closed. The manager is a projection of service snapshots and never owns process resources.

Recommended wide layout:

```text
╭─ /tasks ─ Background tasks ─────────────────────────────────────────────────╮
│ Tasks                                 │ task-3 · dev-server · running       │
│                                       │                                     │
│ ● task-3  dev-server  18s             │ > npm run dev                       │
│ ● task-4  tests        6s             │                                     │
│ × task-2  worker      31s             │ VITE ready in 312 ms                │
│ ✓ task-1  setup        8s             │ Local: http://localhost:5173/       │
│                                       │                                     │
│                                       │                                     │
├───────────────────────────────────────┴─────────────────────────────────────┤
│ 2 running · 1 failed       ↑↓ select  f follow  x stop  c clear  esc close  │
╰─────────────────────────────────────────────────────────────────────────────╯
```

Behavior:

- Wide terminals show process and log panes side by side.
- Medium terminals stack the task pane above the log pane.
- Narrow terminals show a compact task list; Enter opens the selected task details and logs.
- Up/down or `j`/`k` selects a task.
- Enter focuses the log pane or toggles expanded metadata.
- `f` toggles follow mode for the selected active task.
- `x` arms an in-manager confirmation; pressing `x` again stops the selected active task and Escape cancels.
- `c` clears completed tasks.
- Escape closes `/tasks` but does not stop tasks.
- Service revisions invalidate and rerender the component; no polling timer is required.
- Closing `/tasks` unsubscribes its listener.
- Rendered logs strip dangerous terminal control sequences while retaining safe color only if explicitly supported later.
- `/tasks` uses the shared `listDetailFrame(theme)` border renderers. Shared `framedFill` accepts raw content lines and frames, clips, and fills them.

## 8. Footer status

In TUI mode, publish one status entry:

```text
bg: 2 running
bg: 2 running · 1 failed
```

Task completion never produces a user notification and never triggers an agent turn. Completion is visible through the agent tool, `/tasks`, and footer status. Clear the footer status during session shutdown.

## 9. Process boundary

The MVP uses a local process adapter under `boundary/`. Do not use `pi.exec()` or the public `BashOperations` API as the owner: those APIs expose completion, not the long-lived child handle needed for status, output subscriptions, and process-tree shutdown.

The adapter owns an Effect `ChildProcessHandle` and exposes a narrower Effect-native contract to the domain service. Effect owns detached spawn, standard-stream consumption, force escalation, and scoped release; the adapter retains byte-bounded UTF-8 decoding plus immediate graceful signal and post-leader tree-sweep operations.

```ts
interface LocalProcessHandle {
  readonly pid: number;
  readonly output: Stream.Stream<LocalProcessOutput>;
  readonly awaitExit: Effect.Effect<LocalProcessExit>;
  readonly droppedOutputBytes: () => number;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, LocalProcessError>;
}
```

`output` and `awaitExit` never fail: stream failures surface as synthetic stderr text and exit observation settles with an exit code/signal record. `droppedOutputBytes` reports ingress bytes discarded by the bounded queue so the service can reconcile unobserved drops after exit. Only `terminate` fails typed, with `LocalProcessError`.

Spawn requirements:

- Validate cwd exists and is a directory before spawning.
- Inherit a sanitized copy of the host environment; MVP does not expose arbitrary environment overrides through the tool.
- Use the configured shell or platform default.
- Hide extra windows on Windows.
- Create a process group where supported.
- On POSIX, terminate the process group rather than only the shell PID.
- On Windows, run `taskkill /pid PID /T /F` as a raw bounded callback around Node spawn (hidden window, ignored stdio) with typed zero/nonzero/error mapping and a 2-second timeout, and retry it during finalization. The callback's interruption cleanup is synchronous — remove listeners, keep a harmless late-error listener, SIGKILL, unref — and never awaits taskkill's own exit, so a hung terminator cannot hang a finalizer join. Cleanup after a shell leader has already exited is best effort until a native Job Object boundary is introduced.
- Handle spawn failure, exit, abort, timeout, and late output without double settlement.
- Unref the upstream handle only when bounded release begins, so its fallback finalizer cannot extend session shutdown after this boundary's cleanup deadline.

Termination policy:

1. Mark the task `stopping` atomically.
2. Request graceful process-tree termination.
3. Await exit for `stopGraceMs` using the Effect clock.
4. Escalate to force termination if still active.
5. Await final process settlement before completing stop or scope closure.

The service masks interruption only while it claims stop ownership. Owner waits then resume interruptibly. Interruption forces an already-settled handle, while the monitor forces a handle that arrives later. Internal timeout interruption does not run the owner interruption finalizer.

## 10. Effect ownership

- `extension.ts` registers Pi callbacks only.
- `layer.ts` composes the scoped runtime.
- `application.ts` wires session lifecycle, tools, commands, status, and UI projection through the shared session-runtime slot. Trusted code-preview settings load as the first step of runtime startup, after the slot has deactivated the prior runtime. Startup returns only `showFooterStatus`; the bridge already owns the empty initial and cleared projections. Superseded session starts never reach the settings boundary, and only the current-generation activation registers the tool. Application Effect execution is gated synchronously on slot activation, so stale tool or manager calls made while a replacement start is still loading settings fail with a typed `PiSessionRuntimeError` rather than reaching the unactivated next runtime.
- `BackgroundTaskService` is the sole owner of the task registry and child scopes.
- Process monitors run in one fixed child scope owned by the service; each monitor scopes its process handle, output fiber, and timeout fiber, with a completion Deferred per task.
- Registry mutation is serialized. Concurrent start/stop/exit/shutdown events cannot produce duplicate settlement or lose a task.
- Use Effect child-process acquisition for spawn readiness and `Deferred` for exit and log waiters.
- Use `SubscriptionRef` or an equivalent revisioned projection for TUI/footer updates.
- Use `Clock` for timeouts, durations, and stop escalation so tests can use `TestClock`.
- Run Effects only at named Pi/Node boundary executors.

Expected tagged errors include:

- `InvalidBackgroundCommandError`
- `InvalidBackgroundCwdError`
- `BackgroundTaskNotFoundError`
- `BackgroundTaskCapacityError`
- `BackgroundSpawnError`
- `BackgroundTerminationError`
- `BackgroundRuntimeClosedError`

## 11. Package layout

The package follows the repository's small-extension conventions while nesting the multi-file task feature: `extension.ts`, `layer.ts`, and `application.ts` at the `src/` root; `config/` with its single `store.ts` persistence door; `settings/controller.ts` for the `/tasks` command; `boundary/` for the Pi status bridge and the local-process adapter; `task/` for the Effect-owned domain (service, model with its merged pure projection helpers, errors, bounded log buffer, UTF-8 accounting); `tools/` for the `background_task` registration; `ui/` for pure presentation; and package-root `tests/`. See the package `ARCHITECTURE.md` for the current source map.

`ui/` remains pure; Effect resources stay in `task/`; Node and Pi adapters stay in `boundary/`. Shared process utilities should move to `pi-cosmic-core` only if a second package needs the same abstraction.

Stable service key:

```text
pi-background-task/task/service/BackgroundTaskService
```

The key is part of the package's compatibility surface.

## 12. Configuration

Use one persistence door at `config/store.ts`. Project configuration is read only for trusted projects.

Configuration shape and defaults:

```json
{
  "enabled": true,
  "maxRunning": 8,
  "maxRetained": 50,
  "logBufferBytesPerTask": 262144,
  "totalLogBufferBytes": 2097152,
  "stopGraceMs": 2000,
  "maxLogWaitSeconds": 30,
  "showFooterStatus": true,
  "shellPath": null
}
```

Effect Schema validates persisted unknown data. Invalid fields fall back independently and produce a redacted diagnostic rather than disabling the extension.

## 13. Mode behavior

| Mode  | Agent tool | `/tasks` launcher       | Task manager | Footer status |
| ----- | ---------- | ----------------------- | ------------ | ------------- |
| TUI   | Full       | Opens manager           | Full-screen  | Full          |
| RPC   | Full       | Reports TUI requirement | Unsupported  | None          |
| JSON  | Full       | No-op                   | Unsupported  | None          |
| Print | Full       | No-op                   | Unsupported  | None          |

The tool must remain useful without UI. UI methods and full-screen manager code are guarded with `ctx.mode === "tui"`.

## 14. Testing strategy

### Effect-owned unit tests

Use `@effect/vitest`, scopes, `Deferred`, and `TestClock`.

Cover:

- Start publishes `starting` then `running` after explicit spawn readiness.
- Spawn failure settles exactly once and releases the task scope.
- Capacity rejects excess active tasks but permits starts after completion.
- Output ordering, split UTF-8 decoding, cursor reads, and dropped-byte reporting.
- A log long-poll wakes on output, exit, timeout, caller interruption, and shutdown.
- Concurrent stop requests share one termination workflow.
- Graceful stop escalates only after `TestClock` advances past the grace period.
- Interrupting a stop owner after graceful dispatch forces the settled handle, and a later stop observes `stopped`.
- Runtime timeout produces `timed_out` and terminates the process tree.
- Scope closure stops all tasks and awaits finalizers.
- No start or subscription succeeds after runtime closure.
- Retention evicts only oldest completed tasks.
- Total log budget cannot be exceeded by many noisy tasks.

### Boundary tests

Use short Node child fixtures rather than shell-specific commands where possible.

Cover:

- stdout and stderr capture.
- cwd validation.
- non-zero exit and spawn error mapping.
- graceful and forced termination.
- descendant process cleanup on supported platforms.
- signal/listener cleanup.

Platform-specific process-tree assertions may be conditionally skipped with an explicit reason.

### Pi boundary tests

Keep Promise characterization only at Pi callback boundaries.

Cover:

- Tool action validation and result/error rendering.
- `/tasks` manager launch and non-TUI fallback behavior.
- `session_shutdown` closes the runtime once for quit, reload, new, resume, and fork.
- TUI manager subscription disposal and width-safe rendering.
- Non-TUI fallbacks.

## 15. Security and privacy

- This extension has the same local command authority as Pi's bash tool; it does not add sandboxing.
- Never include inherited environment values in snapshots, logs, telemetry, or errors.
- Do not persist command output automatically.
- Resolve cwd to an absolute path and reject non-directories.
- Sanitize control sequences before rendering captured output in the host TUI.
- Redact shell paths and command text from telemetry attributes unless telemetry policy explicitly permits them.
- Project-local configuration is honored only after project trust.

## 16. Acceptance criteria

The MVP is complete when:

1. The main agent can decide to start a long-running command and receive a task ID without waiting for exit.
2. The user can view all tasks and live bounded logs in `/tasks`.
3. The main agent can list, inspect, long-poll logs, stop, stop all, and clear tasks through one tool without operational slash commands.
4. Output memory remains within configured per-task and total bounds under sustained noisy output.
5. Session shutdown leaves no child process tree after graceful cleanup on supported platforms.
6. Start/stop/exit/shutdown races settle tasks exactly once.
7. No background resource starts during extension factory evaluation.
8. TUI, RPC, JSON, and print behavior follows the mode table.
9. Effect diagnostics, package checks, source-loaded package tests, and `pnpm validate` pass.

## 17. Deferred follow-ups

- PTY-backed interactive sessions with stdin and resize support.
- Process-scoped ownership across session replacement.
- Crash-resilient external supervisor and reattachment.
- SSH, container, and sandbox operations backends.
- Optional bounded disk spooling and log export.
- Port detection and clickable service URLs.
- Explicit dependency relationships between tasks.
- Completion messages queued into model context under an opt-in policy.
