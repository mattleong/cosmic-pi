# pi-background-task

Session-scoped background tasks for Pi. The agent can start long-running commands, keep working, and come back for their output, while you watch and control them from `/tasks`.

## Features

- **One agent tool**, `background_task`, with `start`, `list`, `status`, `logs`, `wait`, `stop`, `stop_all`, and `clear` actions.
- **Bounded waits** for a task to exit or for text to appear in its output, without polling.
- **Task manager** in the shared Activity view: browse tasks, read recent logs, follow output, stop or clear tasks.
- **Footer status** for active tasks only, such as `2 background tasks active`.
- **Native codemode results:** scripts receive structured task data instead of text.
- **Process-tree cleanup** when the session reloads, switches, forks, navigates the tree, or shuts down.

## Install

```bash
pi install npm:pi-background-task
```

Install `pi-cosmic-ui` too for the shared Activity view; without it, `/tasks` opens a standalone manager.

## Usage

Ask the agent to run something in the background, such as a dev server, a long test suite, or a build watcher. It starts the task, carries on, and uses `wait` or `logs` when it needs the result.

- `/tasks` opens the manager. Use `j`/`k` or the arrows to move, Enter for details, `f` to follow output, `x` to stop a task, `c` to clear finished tasks, and `q` to close.
- `/tasks settings` edits settings. Run `/tasks settings help` to list them, or `/tasks settings status` to see the active values.

## Configuration

Optional JSON in `~/.pi/agent/extensions/pi-background-task.json`, or `.pi/extensions/pi-background-task.json` in a trusted project. Changes apply after `/reload`.

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

Set `shellPath` to run tasks in a specific shell instead of the platform default.

## How it works

Each Pi session owns its task registry, bounded log buffers, and wait barriers. Tasks are non-interactive, run with your own permissions, and have no default timeout. Output is sanitized before it reaches the TUI and is not credential-redacted. A stop that can't confirm the process exited keeps the task in `stopping` rather than reporting it finished. Task IDs restart at `task-1` with each new session runtime, so IDs from an earlier runtime must not be reused.

See [docs/reference.md](docs/reference.md) for the tool, manager, and codemode result contracts, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
