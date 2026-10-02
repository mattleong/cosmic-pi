# pi-background-task

Session-scoped background task management for pi.

The main agent uses one `background_task` tool to decide when work should run independently of foreground `bash` calls. Supported actions are `start`, `list`, `status`, `logs`, `wait`, `stop`, `stop_all`, and `clear`.

`wait` provides a bounded dependency barrier without polling. It can wait for task exit or for literal text in retained or future output. Output waits accept `contains` and an optional `afterCursor`; all waits return `matched`, `completed`, or `timeout` as normal results. `waitSeconds` defaults to the configured `maxWaitSeconds`, which is 30 seconds by default.

Use `/tasks` to open the full-screen human task manager. The manager uses the same responsive chrome and Vim navigation as `/subagents`: `j/k` move, `h/l` switch list/detail focus, `Ctrl-U` / `Ctrl-D` scroll, `gg/G` jump to the first/last row or the top/bottom of focused output, and `q` closes. Arrow, Home/End, Enter, Escape, and configured Pi selection bindings remain available. The manager also provides shared Braille activity frames, humanized state rows, grouped capability-aware controls, two-press stop confirmation, and technical metadata on demand. Normal rows show `name · state · elapsed`; task IDs, PID, cwd, and the full command appear only after pressing `t`. `f` toggles tail following, `?` switches compact action help, and `c` clears finished tasks after a second `c` confirms. It does not provide a command-entry field.

The main Pi footer shows only active tasks, such as `2 background tasks active`, and clears when none remain. Failed and timed-out tasks stay available in `/tasks` and the task tool without persistent footer reminders. When `pi-cosmic-ui` renders both extensions, subagent status occupies its own line above background-task status.

`background_task` tool calls use the `pi-code-previews` cooperative shell, including its configured background or border treatment and tool-call timing. Log results show a 12-line head/tail preview by default; use `Ctrl+O` (or the configured `app.tools.expand` binding) to reveal the full fetched output. Trusted project preview settings are loaded before the tool is registered for a session.

Set `toolCallCollapsedStyle` to `compact` in `pi-code-previews` settings and reload to hide ordinary output until expansion. Summaries distinguish the management call from the background process state. Failed exits, cancellation, unconfirmed cleanup, wait timeouts, and discarded or truncated output remain visible. Missing or unrecognized details retain the original renderer. The default `preview` style is unchanged.

## Local-extension protocol

The reusable `pi-background-task/code-mode` protocol remains available to local extensions. Its provider checks stable Pi session identity, current runtime slot ownership, and top-level `background_task` activation on each call; it shares the same task registry, bounded logs, wait barriers, and shutdown cleanup. It does not expose the service or execute a registered tool definition.

The custom `pi-code-mode` extension and its `tools.session.backgroundTask` adapter are retired. Native Pi `codemode` can call the registered `background_task` tool through Pi's native tool pipeline; no custom adapter is installed automatically. Started tasks may outlive a foreground call, but not the Pi session.

## Native Code Mode results

`background_task` declares a native Pi `outputSchema`, so native `codemode` scripts receive its `structuredContent` instead of the text. The model-facing text, its 50 KB / 2,000-line bound, and the persisted details are unchanged; the `pi-background-task/code-mode` v1 protocol is separate and also unchanged.

Every successful result carries `contract: "pi-background-task/task"`, `version: 1`, `tool: "background_task"`, and the `action`:

- `start`, `status`, and `stop` return `task`; `list` and `stop_all` return `tasks`.
- `logs` returns `id`, `state`, `finished`, `output`, `truncated`, `nextCursor`, `earliestAvailableCursor`, and `droppedBytes`.
- `wait` returns `outcome` (`matched`, `completed`, or `timeout`), `task`, `nextCursor`, `earliestAvailableCursor`, `droppedBytes`, and `matchCursor` after a match.
- `clear` returns `removed`.

A task has `id`, `state`, `finished`, `startedAt`, `logCursor`, and `droppedLogBytes`, plus optional `name`, `endedAt`, `exitCode` (an integer or `null`), `signal`, `error`, and `cause` (the output line that names why a failed task failed). The command, cwd, and pid are never included. `finished` means only that the task state is terminal: failed, stopped, and timed-out tasks are finished too, so it is not proof that the command succeeded, that the process exited, or that cleanup completed. Read `state` and `exitCode` for the outcome.

Only successes carry a contract. Invalid input, unknown IDs, capacity, spawn, and termination failures reject the call, so the script receives an error; `stop_all` never reports partial success. If a result cannot be encoded, the call becomes an error without structured data that still contains the original text, including task IDs.

Scripts should follow these rules:

- Print or otherwise record each task ID as soon as `start` returns, before awaiting other work, so the main agent can recover it.
- Don't race launches or stops against script-side deadlines. An abandoned call may still start or stop processes. Use `timeoutSeconds` for a runtime limit and `wait` for a bounded barrier.
- A `wait` timeout is a normal result. It never stops the task; stop tasks explicitly.
- A failed, rejected, or cancelled call or script may already have had effects, such as a started task or a requested stop. Nothing is rolled back. After a failure, the main agent should check `list` or `status`.
- Task IDs belong to the current session runtime. Reload, session switch or fork, `/tree` navigation, and shutdown terminate tasks and start a fresh registry whose IDs restart at `task-1`, so an old ID may name a different, new task. Never reuse checkpointed IDs, such as values saved with `store()`, across those boundaries; clear and recreate workflow checkpoints for the current runtime.
- A `tool_result` hook that replaces a result's content without returning `structuredContent` removes the structured data; scripts then receive the text instead.

Metadata strings (`name`, `signal`, `error`, and `cause`) are terminal-sanitized, credential-redacted, and bounded; task IDs are unchanged. `logs` `output` is the requested slice of combined stdout and stderr with terminal controls removed and each stderr chunk prefixed `[stderr] ` before clipping, as in the text. Clipping can remove the first retained prefix. It is **not** credential-redacted. It holds at most the newest 1 MiB of UTF-8 and is `""` when there is no output. With neither `afterCursor` nor `tailLines`, the slice is only the last 200 lines; use `afterCursor: 0` to request all retained output. `truncated` reports only payload clipping, not tail selection; `droppedBytes` separately counts output the task's log buffer already discarded. Clipping is not paging: `nextCursor` remains the latest cursor, so clipped bytes are not read again. Request smaller `tailLines` slices, read incrementally with `afterCursor`, or redirect complete output to a file. Tasks run with the local user's authority; there is no sandbox.

## Lifecycle

Background tasks are non-interactive. Session reload, switch, fork, successful `/tree` navigation, and shutdown initiate process-tree cleanup. Cleanup cannot be guaranteed after host `SIGKILL` or machine loss; Windows post-leader cleanup is best effort without Job Objects. Tasks have no default runtime timeout; the agent may provide one per start. A failed or unconfirmed stop remains active in `stopping` and retains capacity until the operating-system process handle confirms exit; the tool reports a typed termination failure rather than fabricating completion.

## Configuration

Optional configuration may be placed in:

- `~/.pi/agent/extensions/pi-background-task.json`
- `<project>/.pi/extensions/pi-background-task.json` for trusted projects

```json
{
  "enabled": true,
  "maxRunning": 8,
  "maxRetained": 50,
  "logBufferBytesPerTask": 262144,
  "totalLogBufferBytes": 2097152,
  "stopGraceMs": 2000,
  "maxWaitSeconds": 30,
  "showFooterStatus": true
}
```

`shellPath` is an optional string (for example `"shellPath": "/bin/bash"`); when omitted, tasks run in the platform default shell.

`/tasks settings` edits these values from Pi. Bare in a terminal it opens a settings list with a Global row for each setting, plus a Project row when the project is trusted; each row shows the value that scope's file sets, or `inherit`. `/tasks settings maxRunning 16` writes the global file, `/tasks settings project maxWaitSeconds 60` writes the trusted project's file, and `inherit` removes a scope's own value. Changes apply after `/reload`. `/tasks settings status` prints the normalized settings active in the current session without rereading the files, and `/tasks settings help` lists every setting.

Captured output is bounded and sanitized before TUI rendering. `/tasks` preserves only safe ANSI SGR colors and text styles; cursor movement, screen erasure, terminal-title, hyperlink, clipboard, and other control sequences are removed. Background tasks receive `FORCE_COLOR=1` by default so compatible CLIs highlight piped output, unless the environment already sets `FORCE_COLOR` or `NO_COLOR`. Complete output should be redirected explicitly to a file when required.

Interactive PTYs, persistent reattachment, and remote execution are deferred to later phases.
