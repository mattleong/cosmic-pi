# pi-background-task reference

Detailed tool, manager, and result contracts behind the [README](../README.md). [ARCHITECTURE.md](../ARCHITECTURE.md) owns process, lifecycle, sanitization, and rendering internals; this file links to it rather than repeating them.

## Parameters

The tool keeps one flat parameter schema for provider portability, but each action accepts only its own fields: `start` takes `command`, `cwd`, `name`, and `timeoutSeconds`; `list` takes `state`; `status` takes `id`; `logs` takes `id`, `afterCursor`, `tailLines`, and `waitSeconds`; `wait` takes `id`, `until`, `contains`, `afterCursor`, and `waitSeconds`; `stop` takes `id` and `force`; `stop_all` takes `force`; `clear` takes nothing. Null and blank optional fields count as omitted. A field the action doesn't use is ignored when it holds a placeholder (`""`, `false`, or `0`); any other value rejects the call before it touches a task, so `stop_all` or `clear` with an `id` never widens into acting on every task. Likewise, an exit `wait` ignores an empty `contains` and an `afterCursor` of `0`, and `logs` treats `tailLines: 0` as omitted. `logs` rejects `afterCursor` combined with a nonzero `tailLines`. `timeoutSeconds: 0` on `start` is rejected; omit it for no timeout. Invalid arguments are reported with the field, its allowed values, and a bounded copy of what was received. Native codemode calls go through the same validation.

`command` runs exactly as submitted, whitespace included, and may hold up to 64 KiB of UTF-8, enough for heredocs and long file lists; write longer scripts to a file and run that. The shell receives the command as a single argument, and Linux limits one argument to 128 KiB. Task snapshots, results, and the task manager show the first 2,048 characters of the command.

## Waiting

`wait` waits for a task to exit or, with `contains` and an optional `afterCursor`, for literal text in retained or future output. All waits return `matched`, `completed`, or `timeout` as normal results. `waitSeconds` defaults to the configured `maxWaitSeconds`, which is 30 seconds by default, and a larger `waitSeconds` is capped at that setting. The text result reports the applied limit and whether the setting capped it; native codemode receives the limit as `appliedWaitSeconds`. A timeout leaves the task running; call `wait` again to keep waiting. `maxWaitSeconds` can be raised to 3,600 seconds; cancelling the tool call ends a wait at once without affecting the task.

An output wait without `afterCursor` scans all retained output, so text printed before the call, such as an earlier `compiled successfully` from a watcher, matches at once. Pass the `nextCursor` of an earlier `logs` or `wait` result as `afterCursor` to wait only for newer output. Waits match the plain text `logs` returns, within one stream: colors never split a phrase, the `[stderr] ` label is not part of the output, and a match never spans output that was discarded.

## Cursors

Every retained chunk of a task's output has a cursor, and every cursor in a result can be passed back as `afterCursor`: `nextCursor` continues after that result, and `earliestAvailableCursor` reads from the oldest retained output. An `afterCursor` ahead of the task's latest cursor, such as one kept from an earlier runtime's task with the same ID, is rejected with the latest cursor in the error.

A `logs` read with `afterCursor` returns the oldest output after it that fits the result, and its `nextCursor` names the last output included, so repeating the read with each `nextCursor` reads everything retained exactly once. A read without `afterCursor` returns the newest output, by default the last 200 lines; `tailLines` changes this, and a value above 2,000 is capped at 2,000. With `waitSeconds`, a read that finds no output to return waits for some, up to the `maxWaitSeconds` setting; a larger `waitSeconds` is capped at that setting. The text result begins with a `[<id> state=… cursor=… earliest=…]` line, where `cursor` is that result's `nextCursor`. When the result leaves retained output out, a further line says how much and which `afterCursor` reads it. Output the log buffer discarded is reported on its own line; no read can recover it.

## Stopping and listing

`stop` on a task that already finished, including one that finished while the call was arriving, stops nothing and says so. `stop_all` stops every active task at once, so they share one grace window, and reports only the tasks it stopped. `list` with a `state` filter describes an empty result by that filter.

## Task manager

In the Activity view, `h`/`l` change pane or expand and collapse hierarchy, and `t` toggles technical metadata. Task details include bounded recent logs and technical fields; viewing never waits for process exit. `c` on a finished task clears **all finished task records in this session**. Retained Activity summaries may remain as unavailable history, without actions or fresh-ID authority. No command-entry field or workflow-wide execution action is added.

When shared Activity is unavailable, `/tasks` opens its standalone responsive task manager with stop, clear, follow, technical details, and configured Pi navigation. Its details for a finished task show the exit code, signal, start error, and failure cause when they are known. Rejected, cancelled, replaced, or failed admitted openings never open a second fallback surface.

The footer counts every active task, including tasks still starting or stopping, and clears when no tasks remain active. Failed and timed-out tasks stay available in `/tasks` and the task tool without persistent footer reminders. When `pi-cosmic-ui` renders both extensions, subagent status occupies its own line above background-task status.

## Transcript cards

Log results show a 12-line head/tail preview by default; use `Ctrl+O` (or the configured `app.tools.expand` binding) to reveal the full fetched output. Set `toolCallCollapsedStyle` to `compact` in `pi-code-previews` settings and reload to hide ordinary output until expansion. Compact rows distinguish a completed management action from task success and retain failure, timeout, cleanup, and output-loss issues. A running task reads as neutral rather than successful, and a confirmed stop reads as success. Log rows name the task whose output they show. Failure causes render from the result's details, so a hook that rewrites the result text doesn't change them. Expansion preserves the submitted arguments, fetched text, cursors, and recovery details.

## Native Code Mode results

Native Pi `codemode` calls the registered `background_task` tool through Pi's native tool pipeline. Started tasks may outlive a foreground call. Session cleanup and Pi's host-exit guard terminate each task's original process group, but processes that start their own session or process group are not tracked, and nothing is cleaned up after host `SIGKILL` or machine loss; see the [process lifecycle](process-lifecycle.md#process-group-termination).

`background_task` declares a native Pi `outputSchema`, so native `codemode` scripts receive its `structuredContent` instead of the text. The model-facing text, its 50 KB / 2,000-line bound, and the persisted details are unchanged.

Every successful result carries `contract: "pi-background-task/task"`, `version: 1`, `tool: "background_task"`, and the `action`:

- `start`, `status`, and `stop` return `task`; `stop` also returns `alreadyFinished`, which is true when the task had already finished and nothing was stopped. `list` and `stop_all` return `tasks`; for `stop_all`, these are the tasks it stopped.
- `logs` returns `id`, `state`, `finished`, `output`, `truncated`, `nextCursor`, `earliestAvailableCursor`, and `droppedBytes`.
- `wait` returns `outcome` (`matched`, `completed`, or `timeout`), `task`, `nextCursor`, `earliestAvailableCursor`, `droppedBytes`, `appliedWaitSeconds` (the limit after the `maxWaitSeconds` cap), and `matchCursor` after a match.
- `clear` returns `removed`.

A task has `id`, `state`, `finished`, `startedAt`, `logCursor`, and `droppedLogBytes`, plus optional `name`, `endedAt`, `exitCode` (an integer or `null`), `signal`, `error`, and `cause` (the output line that names why a failed task failed). `finished` is true for every terminal state, including failed, stopped, and timed out; read `state` and `exitCode` for the outcome.

Invalid input, unknown IDs, capacity, spawn, and termination failures reject the call, so the script receives an error. `stop_all` attempts every captured active task before reporting aggregate termination failures. If structured-result encoding fails after an action, the error retains the original text and display details but has no structured result; the action is not rolled back or repeated. Read that receipt before retrying.

Scripts should follow these rules:

- Print or otherwise record each task ID as soon as `start` returns, before awaiting other work, so the main agent can recover it.
- Don't race launches or stops against script-side deadlines. An abandoned call may still start or stop processes. Use `timeoutSeconds` for a runtime limit and `wait` for a bounded barrier.
- A `wait` timeout is a normal result. It never stops the task; stop tasks explicitly.
- A failed, rejected, or cancelled call or script may already have had effects, such as a started task or a requested stop. Nothing is rolled back. After a failure, the main agent should check `list` or `status`.
- Never reuse checkpointed task IDs, such as values saved with `store()`, after reload, session switch or fork, `/tree` navigation, or shutdown: the fresh registry restarts at `task-1`, so an old ID may name a different, new task. Clear and recreate workflow checkpoints for the current runtime.
- A `tool_result` hook that replaces a result's content without returning `structuredContent` removes the structured data; scripts then receive the text instead.

`logs` `output` is the same plain text the text result shows: each stderr line starts with `[stderr] `, and a line break separates the streams when one switches mid-line. It is `""` when there is no output. Structured results page independently of the text result, within 1 MiB of UTF-8 instead of 50 KB, so their `nextCursor` can be later; both follow the [cursor rules](#cursors). `truncated` is true when the result leaves retained output out, the same output the text result's notice line reports for that result: after an `afterCursor` read, more output follows `nextCursor`; a read without `afterCursor` shows the newest output, limited by `tailLines` or size, and earlier output is readable from `earliestAvailableCursor`. `droppedBytes` separately counts output the task's log buffer already discarded. Result metadata such as names, errors, and failure causes is terminal-sanitized, credential-redacted, and bounded. Log output is terminal-sanitized but not credential-redacted.

## Settings and captured output

Bare `/tasks settings` in a terminal opens a settings list with a Global row for each setting except `shellPath`, plus a matching Project row when the project is trusted; each row shows the value that scope's file sets, or `inherit`. `/tasks settings maxRunning 16` writes the global file, `/tasks settings logBufferBytesPerTask 512KiB` sets a byte setting with a case-insensitive binary `k`/`KB`/`KiB` or `m`/`MB`/`MiB` suffix (the file stores bytes), `/tasks settings project maxWaitSeconds 60` writes the trusted project's file, and `inherit` removes a scope's own value. `shellPath` takes a free-form path, so set it with `/tasks settings shellPath /bin/zsh` or in the JSON file. A settings file that isn't a readable JSON object shows as unavailable in the list, is never overwritten by a change, and is ignored when the session starts. Wrong-typed fields are ignored individually, and numbers are clamped to their allowed ranges.

Settings are read when the session's task runtime starts, so changes apply after `/reload`, a session switch or fork, or `/tree` navigation. `/tasks settings status` shows the values the current runtime started with.

`logBufferBytesPerTask` bounds each task's retained output and `totalLogBufferBytes` bounds all tasks' retained output together; the total is raised to at least the per-task value. Each retained chunk also counts a fixed overhead of about 100 bytes, so a flood of tiny writes keeps less text. Output still on its way to the buffer has a separate per-task bound of 64 to 256 KiB that neither setting reduces.

Captured output is normalized per stream as it arrives, including sequences split across writes. Color and text-style (SGR) sequences are kept; cursor movement, screen erasure, terminal titles, hyperlinks, clipboard writes, other escape sequences, carriage returns, and other control characters are removed. A sequence still open after 4 KiB is discarded so it cannot hide the output that follows. `logs`, `wait`, and transcript cards use the text without colors. The Activity view, which `/tasks` normally opens, shows plain text and redacts credentials it recognizes, such as bearer tokens and `api_key=` values. Only the standalone manager, which `/tasks` opens when Activity is unavailable, shows the colors; like `logs` output, it does not redact credentials.

Interactive PTYs, persistent reattachment, and remote execution are deferred to later phases.
