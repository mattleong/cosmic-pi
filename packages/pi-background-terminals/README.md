# pi-background-terminals

Session-scoped background process management for pi.

The main agent uses one `background_terminal` tool to decide when work should run independently of foreground `bash` calls. Supported actions are `start`, `list`, `status`, `logs`, `stop`, `stop_all`, and `clear`.

Use `/ps` to open the full-screen human process manager. It shows live bounded logs and permits explicit stop or clear actions, but does not provide a command-entry field.

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
  "showFooterStatus": true,
  "shellPath": null
}
```

Captured output is bounded and sanitized before TUI rendering. Complete output should be redirected explicitly to a file when required.

Interactive PTYs, persistent reattachment, and remote execution are deferred to later phases.
