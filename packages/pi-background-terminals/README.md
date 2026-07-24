# pi-background-terminals

Session-scoped background process management for pi.

The main agent uses one `background_terminal` tool to decide when work should run independently of foreground `bash` calls. Supported actions are `start`, `list`, `status`, `logs`, `stop`, `stop_all`, and `clear`.

Use `/ps` to open the full-screen human process manager. It shows live bounded logs and permits explicit stop or clear actions, but does not provide a command-entry field.

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
