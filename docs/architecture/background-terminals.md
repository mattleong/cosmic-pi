# Background terminals extension specification

Status: implemented MVP

## 1. Summary

Add a `pi-background-terminals` extension that lets the main agent autonomously start, inspect, and stop long-running local commands without blocking the current agent turn. Users retain a visual manager for observation and emergency control, but operational routing belongs to the agent tool.

The MVP is deliberately a **background job manager**, not a pseudo-terminal implementation. Jobs are non-interactive shell commands with captured output. They are owned by the current Pi session and are terminated during reload, session replacement, fork, or shutdown.

## 2. Goals

- Start a local command and return immediately with a stable job ID.
- Capture bounded, ordered stdout and stderr output.
- Inspect job status and incrementally read logs without aggressive polling.
- Stop one job or all jobs and terminate their process trees reliably.
- Give the main agent one complete management tool and give users a TUI manager for observation and emergency control.
- Make lifecycle ownership explicit with Effect scopes and typed failures.
- Preserve usable behavior in TUI, RPC, JSON, and print modes.

## 3. Non-goals for MVP

- Interactive PTYs or sending stdin to a running job.
- Reattaching after Pi exits or restarts.
- Keeping jobs alive across `/new`, `/resume`, `/fork`, `/clone`, or `/reload`.
- SSH, containers, sandboxes, or remote execution backends.
- Replacing Pi's built-in foreground `bash` tool.
- Automatically injecting job completion into model context or triggering a new turn.
- Persisting complete, unbounded process output.

## 4. Product semantics

### 4.1 Job lifetime

Jobs are session-scoped resources.

- The extension starts no processes from its factory.
- The session runtime is acquired from `session_start` and closed from an idempotent `session_shutdown` handler.
- Scope closure stops every active process tree, waits for bounded cleanup, releases output listeners, and clears extension UI.
- A resumed session does not restore historical jobs. Old tool results remain ordinary session history but do not represent live processes.
- Graceful Pi shutdown is covered. No guarantee is possible after an uncatchable host termination such as `SIGKILL` or machine loss.

### 4.2 Job identity

Each job receives a short, session-local monotonic ID:

```text
term-1
term-2
term-3
```

IDs are never reused within one extension runtime. An optional display name does not replace the ID and need not be unique.

### 4.3 Job states

```text
starting -> running -> exited
                    -> failed
                    -> stopping -> stopped
                    -> timed_out
```

`starting` becomes `running` only after the child emits its spawn event. Spawn errors become `failed`. Terminal states are immutable.

A job snapshot contains:

```ts
interface BackgroundJobSnapshot {
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

- Maximum running jobs: 8.
- Maximum retained terminal snapshots: 50.
- Per-job in-memory log buffer: 256 KiB.
- Total in-memory log budget: 2 MiB.
- Stop grace period: 2 seconds.
- Maximum long-poll wait: 30 seconds.

Capacity applies to `starting`, `running`, and `stopping` jobs. When retention exceeds its limit, evict the oldest completed jobs only. Never evict an active job.

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
  }>;
  readonly nextCursor: number;
  readonly earliestAvailableCursor: number;
  readonly droppedBytes: number;
  readonly state: BackgroundJobSnapshot["state"];
}
```

## 5. Agent tool

Register one tool named `background_terminal`.

Use TypeBox for the Pi tool schema and `StringEnum` for `action`. Perform action-specific validation in the application service and model expected failures as tagged errors.

### 5.1 Actions

#### `start`

Inputs:

- `command` — required, non-empty shell command.
- `cwd` — optional path; relative paths resolve against `ctx.cwd`. Any existing local directory is allowed.
- `name` — optional short display name.
- `timeoutSeconds` — optional positive finite runtime limit. When omitted, the job has no runtime timeout.

Returns immediately after spawn succeeds with the initial job snapshot. It does not wait for command completion.

#### `list`

Inputs:

- `state` — optional `active`, `completed`, or `all`; defaults to `all`.

Returns compact snapshots ordered with active jobs first, then newest completed jobs.

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

If no newer log event exists and the job is active, wait until output arrives, the job settles, the caller aborts, or `waitSeconds` expires. Return a cursor even when no output arrives. This avoids repeated fixed-delay polling.

#### `stop`

Inputs:

- `id` — required.
- `force` — optional; defaults to false.

Normal stop requests graceful process-tree termination, waits for the configured grace period, then escalates. Force stop escalates immediately. Repeated stop requests are idempotent and await the same terminal transition.

#### `stop_all`

Stops all active jobs concurrently with bounded concurrency and returns their final snapshots.

#### `clear`

Removes completed job metadata. Active jobs are unaffected.

### 5.2 Prompt metadata

Suggested prompt snippet:

> Start and manage long-running local commands without blocking the current turn.

Suggested guidelines:

- The main agent should decide whether a command belongs in `background_terminal` based on whether work can continue independently; use `bash` when the next step immediately depends on command completion.
- Use `background_terminal` for servers, watchers, long-running test suites, and other processes that should remain active while the agent continues working.
- Use `background_terminal` log cursors and long polling instead of repeatedly polling at fixed intervals.
- Stop background jobs when they are no longer needed. All jobs are terminated when the Pi session is replaced or shut down.

### 5.3 Tool rendering

Default collapsed rendering should show:

```text
◉ term-3 dev-server  running  18s
  npm run dev
```

Terminal states use success, warning, or error colors. Expanded results include cwd, PID, exit details, dropped-log information, and a bounded log tail. Tool rendering must sanitize terminal control sequences and obey render width. The package decorates its own tool definition with the public `pi-code-previews` cooperative shell after loading trusted session settings, preserving tool ownership while sharing configured shell chrome and timing.

## 6. Human-facing launcher

### `/ps`

This is the only slash command in the MVP. It opens the interactive process manager in TUI mode and does not accept operational subcommands.

Starting, listing, reading, stopping, and clearing jobs are agent-facing operations exposed through `background_terminal`. A user who wants work placed in the background asks the main agent naturally rather than manually translating that intent into process commands.

The TUI manager may still provide direct stop and clear controls as an emergency human override. It does not provide a command-entry field or a separate path for starting jobs.

In RPC mode, `/ps` reports that the manager requires TUI. JSON and print modes have no UI response channel, so the command is a no-op there. Programmatic clients use the `background_terminal` tool.

## 7. TUI manager

Use a terminal-sized `ctx.ui.custom()` overlay to present the full-screen process manager. The overlay is anchored at the top-left and constrained to 100% of the available terminal rows and columns, so Pi's editor widgets and footer cannot push it outside the viewport. It does not enter a separate OS alternate-screen buffer and is removed when closed. The manager is a projection of service snapshots and never owns process resources.

Recommended wide layout:

```text
╭─ /ps ─ Background processes ────────────────────────────────────────────────╮
│ Processes                             │ term-3 · dev-server · running       │
│                                       │                                     │
│ ● term-3  dev-server  18s             │ > npm run dev                      │
│ ● term-4  tests        6s             │                                     │
│ × term-2  worker      31s             │ VITE ready in 312 ms                │
│ ✓ term-1  setup        8s             │ Local: http://localhost:5173/       │
│                                       │                                     │
│                                       │                                     │
├───────────────────────────────────────┴─────────────────────────────────────┤
│ 2 running · 1 failed       ↑↓ select  f follow  x stop  c clear  esc close │
╰─────────────────────────────────────────────────────────────────────────────╯
```

Behavior:

- Wide terminals show process and log panes side by side.
- Medium terminals stack the process pane above the log pane.
- Narrow terminals show a compact process list; Enter opens the selected process details and logs.
- Up/down or `j`/`k` selects a job.
- Enter focuses the log pane or toggles expanded metadata.
- `f` toggles follow mode for the selected active job.
- `x` arms an in-manager confirmation; pressing `x` again stops the selected active job and Escape cancels.
- `c` clears completed jobs.
- Escape closes `/ps` but does not stop jobs.
- Service revisions invalidate and rerender the component; no polling timer is required.
- Closing `/ps` unsubscribes its listener.
- Rendered logs strip dangerous terminal control sequences while retaining safe color only if explicitly supported later.

## 8. Footer status

In TUI mode, publish one status entry:

```text
bg: 2 running
bg: 2 running · 1 failed
```

Job completion never produces a user notification and never triggers an agent turn. Completion is visible through the agent tool, `/ps`, and footer status. Clear the footer status during session shutdown.

## 9. Process boundary

The MVP uses a local process adapter under `boundary/`. Do not use `pi.exec()` or the public `BashOperations` API as the owner: those APIs expose completion, not the long-lived child handle needed for status, output subscriptions, and process-tree shutdown.

The adapter owns Node's `ChildProcess` and exposes an Effect-native contract to the domain service.

```ts
interface LocalProcessHandle {
  readonly pid: number;
  readonly events: Stream.Stream<ProcessEvent, ProcessBoundaryError>;
  readonly awaitExit: Effect.Effect<ProcessExit, ProcessBoundaryError>;
  readonly terminate: (mode: "graceful" | "force") => Effect.Effect<void, ProcessBoundaryError>;
}
```

Spawn requirements:

- Validate cwd exists and is a directory before spawning.
- Inherit a sanitized copy of the host environment; MVP does not expose arbitrary environment overrides through the tool.
- Use the configured shell or platform default.
- Hide extra windows on Windows.
- Create a process group where supported.
- On POSIX, terminate the process group rather than only the shell PID.
- On Windows, use `taskkill /T` for active process trees and retry it during finalization. Cleanup after a shell leader has already exited is best effort until a native Job Object boundary is introduced.
- Handle spawn error, exit, close, abort, timeout, and late output without double settlement.
- Remove listeners and decoder state in a finalizer.

Termination policy:

1. Mark the job `stopping` atomically.
2. Request graceful process-tree termination.
3. Await exit for `stopGraceMs` using the Effect clock.
4. Escalate to force termination if still active.
5. Await final process settlement before completing stop or scope closure.

## 10. Effect ownership

- `extension.ts` registers Pi callbacks only.
- `layer.ts` composes the scoped runtime.
- `application.ts` wires session lifecycle, tools, commands, status, and UI projection.
- `BackgroundTerminalService` is the sole owner of the job registry and child scopes.
- Each job gets a child scope containing its process handle, output fiber, timeout fiber, and completion Deferred.
- Registry mutation is serialized. Concurrent start/stop/exit/shutdown events cannot produce duplicate settlement or lose a job.
- Use `Deferred` for spawn readiness, exit, and log waiters.
- Use `SubscriptionRef` or an equivalent revisioned projection for TUI/footer updates.
- Use `Clock` for timeouts, durations, and stop escalation so tests can use `TestClock`.
- Run Effects only at named Pi/Node boundary executors.

Expected tagged errors include:

- `InvalidBackgroundCommandError`
- `InvalidBackgroundCwdError`
- `BackgroundJobNotFoundError`
- `BackgroundJobCapacityError`
- `BackgroundSpawnError`
- `BackgroundTerminationError`
- `BackgroundRuntimeClosedError`

## 11. Package layout

```text
packages/pi-background-terminals/
  index.ts
  package.json
  tsconfig.json
  ARCHITECTURE.md
  src/
    extension.ts
    layer.ts
    application.ts
    config/
      schema.ts
      options.ts
      store.ts
    settings/
      controller.ts
    boundary/
      host-ui.ts
      local-process.ts
      native-clock.ts
    job/
      service.ts
      model.ts
      errors.ts
      log-buffer.ts
      projection.ts
    tools/
      background-terminal.ts
    ui/
      log-preview.ts
      manager.ts
      sanitize.ts
  tests/
    application.test.ts
    config.test.ts
    host-ui.test.ts
    job-service.test.ts
    local-process.test.ts
    log-buffer.test.ts
    projection.test.ts
    sanitize.test.ts
    settings-controller.test.ts
    tool.test.ts
    ui-manager.test.ts
```

This follows the repository's small-extension conventions while nesting the multi-file job feature. `ui/` remains pure; Effect resources stay in `job/`; Node and Pi adapters stay in `boundary/`. Shared process utilities should move to `pi-cosmic-core` only if a second package needs the same abstraction.

Stable service key:

```text
pi-background-terminals/job/service/BackgroundTerminalService
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
  "logBufferBytesPerJob": 262144,
  "totalLogBufferBytes": 2097152,
  "stopGraceMs": 2000,
  "maxLogWaitSeconds": 30,
  "showFooterStatus": true,
  "shellPath": null
}
```

Effect Schema validates persisted unknown data. Invalid fields fall back independently and produce a redacted diagnostic rather than disabling the extension.

## 13. Mode behavior

| Mode  | Agent tool | `/ps` launcher          | Process manager | Footer status |
| ----- | ---------- | ----------------------- | --------------- | ------------- |
| TUI   | Full       | Opens manager           | Full-screen     | Full          |
| RPC   | Full       | Reports TUI requirement | Unsupported     | None          |
| JSON  | Full       | No-op                   | Unsupported     | None          |
| Print | Full       | No-op                   | Unsupported     | None          |

The tool must remain useful without UI. UI methods and full-screen manager code are guarded with `ctx.mode === "tui"`.

## 14. Testing strategy

### Effect-owned unit tests

Use `@effect/vitest`, scopes, `Deferred`, and `TestClock`.

Cover:

- Start publishes `starting` then `running` after explicit spawn readiness.
- Spawn failure settles exactly once and releases the job scope.
- Capacity rejects excess active jobs but permits starts after completion.
- Output ordering, split UTF-8 decoding, cursor reads, and dropped-byte reporting.
- A log long-poll wakes on output, exit, timeout, caller interruption, and shutdown.
- Concurrent stop requests share one termination workflow.
- Graceful stop escalates only after `TestClock` advances past the grace period.
- Runtime timeout produces `timed_out` and terminates the process tree.
- Scope closure stops all jobs and awaits finalizers.
- No start or subscription succeeds after runtime closure.
- Retention evicts only oldest completed jobs.
- Total log budget cannot be exceeded by many noisy jobs.

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
- `/ps` manager launch and non-TUI fallback behavior.
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

1. The main agent can decide to start a long-running command and receive a job ID without waiting for exit.
2. The user can view all jobs and live bounded logs in `/ps`.
3. The main agent can list, inspect, long-poll logs, stop, stop all, and clear jobs through one tool without operational slash commands.
4. Output memory remains within configured per-job and total bounds under sustained noisy output.
5. Session shutdown leaves no child process tree after graceful cleanup on supported platforms.
6. Start/stop/exit/shutdown races settle jobs exactly once.
7. No background resource starts during extension factory evaluation.
8. TUI, RPC, JSON, and print behavior follows the mode table.
9. Effect diagnostics, package checks, tests, builds, and `pnpm validate` pass.

## 17. Deferred follow-ups

- PTY-backed interactive sessions with stdin and resize support.
- Process-scoped ownership across session replacement.
- Crash-resilient external supervisor and reattachment.
- SSH, container, and sandbox operations backends.
- Optional bounded disk spooling and log export.
- Port detection and clickable service URLs.
- Explicit dependency relationships between jobs.
- Completion messages queued into model context under an opt-in policy.
