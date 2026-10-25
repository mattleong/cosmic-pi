# pi-background-task

Session-scoped background tasks for Pi. The agent can start long-running commands, keep working, and come back for their output, while you watch and control them from `/tasks`.

## Features

- **One agent tool**, `background_task`, with `start`, `list`, `status`, `logs`, `wait`, `stop`, `stop_all`, and `clear` actions.
- **Bounded waits** for a task to exit or for any of a few texts to appear in its output, without polling. Each wait is capped by the `maxWaitSeconds` setting and returns the matched line and the task's recent output.
- **Opt-in exit notices:** a task started with `notify` messages the agent when it finishes, or only when it fails, waking an idle agent instead of leaving it to poll.
- **Activity view** from `pi-cosmic-ui`: browse tasks, read recent logs, follow output, stop or clear tasks.
- **Footer status** while tasks are active, such as `2 background tasks running`; the count includes tasks still starting or stopping.
- **Native codemode results:** scripts receive structured task data instead of text.
- **Process-group cleanup** when the session reloads, switches, forks, navigates the tree, or shuts down, and when Pi exits abruptly. Processes that start their own session or process group, such as daemons, aren't tracked.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-background-task"
pi install "$PWD/packages/pi-cosmic-ui"   # required for /tasks
```

`/tasks` opens the shared Activity view from `pi-cosmic-ui`; without it, `/tasks` only shows a notice. The tool works either way.

## Usage

Ask the agent to run something in the background, such as a dev server, a long test suite, or a build watcher. It starts the task, carries on, and uses `wait` or `logs` when it needs the result.

- `/tasks` opens background tasks in Activity. Use `j`/`k` or the arrows to move, Enter for details, `f` to follow output, `x` to stop a task, `c` to clear finished tasks, and `q` to close.
- `/tasks settings` edits settings. Run `/tasks settings help` to list them, or `/tasks settings status` to see the active values.

## Configuration

Optional JSON in `~/.pi/agent/extensions/pi-background-task.json`, or `.pi/extensions/pi-background-task.json` in a trusted project. Changes apply when the session's task runtime restarts: after `/reload`, a session switch or fork, or `/tree` navigation.

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

Tasks run in Pi's shell, normally bash, with Pi's `shellPath` and `shellCommandPrefix` settings, as its `bash` tool does. Set this package's `shellPath` to run tasks in another shell instead, without Pi's prefix. `maxWaitSeconds` goes up to 3600. In `/tasks settings`, the two byte settings also accept sizes such as `512KiB` or `4m`.

## How it works

Each Pi session owns its task registry, bounded log buffers, and wait barriers. Tasks are non-interactive: stdin stays open but is never written, so watchers keep running and a command that prompts or reads stdin waits until it is stopped; give such commands `</dev/null` or non-interactive flags. They run with your own permissions and have no default timeout. Output is sanitized as it arrives; `logs` shows it without credential redaction, while the Activity view redacts credentials it recognizes. A stop that can't confirm the process exited keeps the task in `stopping` rather than reporting it finished; stopping it again forces it. Cleanup reaches each task's own process group and nothing that detaches from it, and no cleanup runs if Pi itself is killed with `SIGKILL` or the machine goes down. Task IDs are random tokens that belong to one session runtime, so IDs from an earlier runtime must not be reused.

See [docs/reference.md](docs/reference.md) for the tool, Activity, and codemode result contracts, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
