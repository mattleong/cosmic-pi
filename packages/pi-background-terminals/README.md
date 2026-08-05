# pi-background-terminals

Session-scoped background process management for pi.

The main agent uses one `background_terminal` tool to decide when work should run independently of foreground `bash` calls. Supported actions are `start`, `list`, `status`, `logs`, `stop`, `stop_all`, and `clear`.

Use `/ps` to open the full-screen human process manager. It uses the same responsive chrome and Vim navigation as `/subagents`: `j/k` move, `h/l` switch list/detail focus, `Ctrl-U` / `Ctrl-D` scroll, `gg/G` jump to the first/last row or the top/bottom of focused output, and `q` closes. Arrow, Home/End, Enter, Escape, and configured Pi selection bindings remain available. The manager also provides shared Braille activity frames, humanized state rows, grouped capability-aware controls, two-press stop confirmation, and technical metadata on demand. Normal rows show `name · state · elapsed`; job IDs, PID, cwd, and the full command appear only after pressing `t`. `f` toggles tail following, `?` switches compact action help, and `c` clears retained terminal jobs. It does not provide a command-entry field.

The main Pi footer uses natural status text such as `2 background jobs active · 1 failed`. When `pi-cosmic-ui` renders both extensions, subagent status occupies its own line above background-job status.

`background_terminal` tool calls use the `pi-code-previews` cooperative shell, including its configured background or border treatment and tool-call timing. Log results show a 12-line head/tail preview by default; use `Ctrl+O` (or the configured `app.tools.expand` binding) to reveal the full fetched output. Trusted project preview settings are loaded before the tool is registered for a session.

## Lifecycle

Background jobs are non-interactive in the MVP and are always terminated when the Pi session reloads, switches, forks, or shuts down. Jobs have no default runtime timeout; the agent may provide one per start.

## Configuration

Optional configuration may be placed in:

- `~/.pi/agent/extensions/pi-background-terminals.json`
- `<project>/.pi/extensions/pi-background-terminals.json` for trusted projects

```json
{
  "enabled": true,
  "maxRunning": 8,
  "maxRetained": 50,
  "logBufferBytesPerJob": 262144,
  "totalLogBufferBytes": 2097152,
  "stopGraceMs": 2000,
  "maxLogWaitSeconds": 30,
  "showFooterStatus": true
}
```

`shellPath` is an optional string (for example `"shellPath": "/bin/bash"`); when omitted, jobs run in the platform default shell.

Captured output is bounded and sanitized before TUI rendering. Complete output should be redirected explicitly to a file when required.

Interactive PTYs, persistent reattachment, and remote execution are deferred to later phases.
