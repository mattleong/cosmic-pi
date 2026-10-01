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
