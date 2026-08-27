# pi-background-task

Session-scoped background task management for pi.

The main agent uses one `background_task` tool to decide when work should run independently of foreground `bash` calls. Supported actions are `start`, `list`, `status`, `logs`, `wait`, `stop`, `stop_all`, and `clear`.

`wait` provides a bounded dependency barrier without polling. It can wait for task exit or for literal text in retained or future output. Output waits accept `contains` and an optional `afterCursor`; all waits return `matched`, `completed`, or `timeout` as normal results. `waitSeconds` defaults to the configured `maxWaitSeconds`, which is 30 seconds by default.

Use `/tasks` to open the full-screen human task manager. It uses the same responsive chrome and Vim navigation as `/subagents`: `j/k` move, `h/l` switch list/detail focus, `Ctrl-U` / `Ctrl-D` scroll, `gg/G` jump to the first/last row or the top/bottom of focused output, and `q` closes. Arrow, Home/End, Enter, Escape, and configured Pi selection bindings remain available. The manager also provides shared Braille activity frames, humanized state rows, grouped capability-aware controls, two-press stop confirmation, and technical metadata on demand. Normal rows show `name · state · elapsed`; task IDs, PID, cwd, and the full command appear only after pressing `t`. `f` toggles tail following, `?` switches compact action help, and `c` clears retained background tasks. It does not provide a command-entry field.

The main Pi footer uses natural status text such as `2 background tasks active · 1 failed`. When `pi-cosmic-ui` renders both extensions, subagent status occupies its own line above background-task status.

`background_task` tool calls use the `pi-code-previews` cooperative shell, including its configured background or border treatment and tool-call timing. Log results show a 12-line head/tail preview by default; use `Ctrl+O` (or the configured `app.tools.expand` binding) to reveal the full fetched output. Trusted project preview settings are loaded before the tool is registered for a session.

## Lifecycle

Background tasks are non-interactive in the MVP and are always terminated when the Pi session reloads, switches, forks, or shuts down. Tasks have no default runtime timeout; the agent may provide one per start. A failed or unconfirmed stop remains active in `stopping` and retains capacity until the operating-system process handle confirms exit; the tool reports a typed termination failure rather than fabricating completion.

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

Captured output is bounded and sanitized before TUI rendering. `/tasks` preserves only safe ANSI SGR colors and text styles; cursor movement, screen erasure, terminal-title, hyperlink, clipboard, and other control sequences are removed. Background tasks receive `FORCE_COLOR=1` by default so compatible CLIs highlight piped output, unless the environment already sets `FORCE_COLOR` or `NO_COLOR`. Complete output should be redirected explicitly to a file when required.

Interactive PTYs, persistent reattachment, and remote execution are deferred to later phases.
