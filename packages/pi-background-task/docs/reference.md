# pi-background-task reference

Detailed tool, manager, and result contracts behind the [README](../README.md). [ARCHITECTURE.md](../ARCHITECTURE.md) owns process, lifecycle, sanitization, and rendering internals; this file links to it rather than repeating them.

## Waiting

`wait` waits for a task to exit or, with `contains` and an optional `afterCursor`, for literal text in retained or future output. All waits return `matched`, `completed`, or `timeout` as normal results. `waitSeconds` defaults to the configured `maxWaitSeconds`, which is 30 seconds by default.

## Task manager

In the Activity view, `h`/`l` change pane or expand and collapse hierarchy, and `t` toggles technical metadata. Task details include bounded recent logs and technical fields; viewing never waits for process exit. `c` on a finished task clears **all finished task records in this session**. Retained Activity summaries may remain as unavailable history, without actions or fresh-ID authority. No command-entry field or workflow-wide execution action is added.

When shared Activity is unavailable, `/tasks` opens its standalone responsive task manager with stop, clear, follow, technical details, and configured Pi navigation. Rejected, cancelled, replaced, or failed admitted openings never open a second fallback surface.

The footer clears when no tasks remain active. Failed and timed-out tasks stay available in `/tasks` and the task tool without persistent footer reminders. When `pi-cosmic-ui` renders both extensions, subagent status occupies its own line above background-task status.

## Transcript cards

Log results show a 12-line head/tail preview by default; use `Ctrl+O` (or the configured `app.tools.expand` binding) to reveal the full fetched output. Set `toolCallCollapsedStyle` to `compact` in `pi-code-previews` settings and reload to hide ordinary output until expansion. Compact summaries and their issues are described in [ARCHITECTURE.md](../ARCHITECTURE.md#source-map).

## Local-extension protocol

The reusable `pi-background-task/code-mode` protocol remains available to local extensions. It shares the top-level tool's task registry and does not expose the service or execute a registered tool definition; its admission checks are described under [Ownership](../ARCHITECTURE.md#ownership).

The custom `pi-code-mode` extension and its `tools.session.backgroundTask` adapter are retired. Native Pi `codemode` can call the registered `background_task` tool through Pi's native tool pipeline; no custom adapter is installed automatically. Started tasks may outlive a foreground call, but not the Pi session.

## Native Code Mode results

`background_task` declares a native Pi `outputSchema`, so native `codemode` scripts receive its `structuredContent` instead of the text. The model-facing text, its 50 KB / 2,000-line bound, and the persisted details are unchanged; the `pi-background-task/code-mode` v1 protocol is separate and also unchanged.

Every successful result carries `contract: "pi-background-task/task"`, `version: 1`, `tool: "background_task"`, and the `action`:

- `start`, `status`, and `stop` return `task`; `list` and `stop_all` return `tasks`.
- `logs` returns `id`, `state`, `finished`, `output`, `truncated`, `nextCursor`, `earliestAvailableCursor`, and `droppedBytes`.
- `wait` returns `outcome` (`matched`, `completed`, or `timeout`), `task`, `nextCursor`, `earliestAvailableCursor`, `droppedBytes`, and `matchCursor` after a match.
- `clear` returns `removed`.

A task has `id`, `state`, `finished`, `startedAt`, `logCursor`, and `droppedLogBytes`, plus optional `name`, `endedAt`, `exitCode` (an integer or `null`), `signal`, `error`, and `cause` (the output line that names why a failed task failed). `finished` is true for every terminal state, including failed, stopped, and timed out; read `state` and `exitCode` for the outcome.

Invalid input, unknown IDs, capacity, spawn, and termination failures reject the call, so the script receives an error. Encoding failures and `stop_all` aggregation are described in [ARCHITECTURE.md](../ARCHITECTURE.md#source-map).

Scripts should follow these rules:

- Print or otherwise record each task ID as soon as `start` returns, before awaiting other work, so the main agent can recover it.
- Don't race launches or stops against script-side deadlines. An abandoned call may still start or stop processes. Use `timeoutSeconds` for a runtime limit and `wait` for a bounded barrier.
- A `wait` timeout is a normal result. It never stops the task; stop tasks explicitly.
- A failed, rejected, or cancelled call or script may already have had effects, such as a started task or a requested stop. Nothing is rolled back. After a failure, the main agent should check `list` or `status`.
- Never reuse checkpointed task IDs, such as values saved with `store()`, after reload, session switch or fork, `/tree` navigation, or shutdown: the fresh registry restarts at `task-1`, so an old ID may name a different, new task. Clear and recreate workflow checkpoints for the current runtime.
- A `tool_result` hook that replaces a result's content without returning `structuredContent` removes the structured data; scripts then receive the text instead.

`logs` `output` prefixes each stderr chunk with `[stderr] ` before clipping, so clipping can remove the first retained prefix; it is `""` when there is no output. With neither `afterCursor` nor `tailLines`, the slice is only the last 200 lines; use `afterCursor: 0` to request all retained output. `truncated` does not report tail selection, and `droppedBytes` separately counts output the task's log buffer already discarded. Clipping is not paging: `nextCursor` remains the latest cursor, so clipped bytes are not read again. Request smaller `tailLines` slices, read incrementally with `afterCursor`, or redirect complete output to a file. Sanitization, redaction, and size bounds for metadata and output are described in [ARCHITECTURE.md](../ARCHITECTURE.md#source-map).

## Settings and captured output

Bare `/tasks settings` in a terminal opens a settings list with a Global row for each setting, plus a Project row when the project is trusted; each row shows the value that scope's file sets, or `inherit`. `/tasks settings maxRunning 16` writes the global file, `/tasks settings project maxWaitSeconds 60` writes the trusted project's file, and `inherit` removes a scope's own value.

`/tasks` preserves only safe ANSI SGR colors and text styles in captured output; cursor movement, screen erasure, terminal-title, hyperlink, clipboard, and other control sequences are removed.

Interactive PTYs, persistent reattachment, and remote execution are deferred to later phases.
