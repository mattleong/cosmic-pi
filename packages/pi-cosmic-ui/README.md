# pi-cosmic-ui

Shared, responsive UI for Pi: a composable footer, a unified Activity view for workflows, subagents, and tasks, and the manager building blocks the other Cosmic Pi extensions use.

## Features

- **Custom footer** combining location, Git branch and pull request, session, tokens, context, model, and thinking level with contributions from other extensions such as OpenAI usage.
- **Responsive layout** with density, ordering, and per-item visibility settings.
- **Working indicator** with elapsed time, a current-call estimate (`~18.4 tok/s`), or a reported completed-call average (`24.1 tok/s`).
- **Activity view** that shows workflows, subagents, background tasks, and questions in one place, as a compact live panel above the editor and a full-screen manager.
- **Shared manager chrome** for other extensions: Vim-style navigation, list/detail layouts, status glyphs, settings commands, and full-screen surfaces.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-cosmic-ui"
```

Other Cosmic Pi extensions detect it automatically. Without it, they fall back to Pi's status line and their own managers.

## Usage

| Command               | Action                                               |
| --------------------- | ---------------------------------------------------- |
| `/cosmic-ui settings` | Footer settings, including provider usage visibility |
| `/activity`           | Open the Activity manager                            |

`/subagents` and `/tasks` open the same manager focused on their section. In the manager, use `j`/`k` or the arrows to move, `h`/`l` to collapse or expand, Enter to inspect, `?` for help, and `q` to close. Number keys and letter shortcuts such as `x` (stop) run the selected item's actions; destructive actions ask for confirmation.

### What tok/s measures

The row uses `~` for estimates, with no extra live/completed labels.

- **Live:** the current main-agent call's streamed text, thinking and tool-argument UTF-16 units divided by four, divided by time since Pi's pre-provider context boundary. It appears after one second of observation. This is only a heuristic: language, tokenizer, buffering and hidden reasoning affect it.
- **Completed:** the sum of eligible calls' provider-reported `usage.output` divided by the sum of those same calls' durations. Output already includes reported reasoning tokens. Only successful, tool-use or length-limited completions with positive, valid usage and duration contribute. Missing/zero usage and failed/aborted calls contribute neither tokens nor time. Zero is ambiguous because providers can initialize missing usage to zero.

Both use monotonic time from the main agent's `context_with_system` event to assistant `message_end`. This includes subsequent preparation/authentication, initial latency, hidden reasoning, network stalls and retries—not just model decoding. Tool time, gaps between calls, input/cache tokens and subagent/nested-tool usage are excluded. Completed samples never mix with live estimates; their average is shown whenever no live estimate is available, and resets each agent run.

Prompts freeze the displayed working elapsed time, not provider measurement: a provider may keep generating while a dialog or unavailable UI hides the row. Neither the live estimate nor completed average is a server-side decoding-speed benchmark.

## Configuration

Settings live in `~/.pi/agent/extensions/pi-cosmic-ui.json`, and a project's `.pi/extensions/pi-cosmic-ui.json` can override them. `hidden` lists footer items to hide, such as `"openai.usage"`.

```json
{
  "footer": {
    "enabled": true,
    "density": "auto",
    "order": [
      "model",
      "effort",
      "location",
      "openai.fast",
      "branch",
      "pullRequest",
      "git",
      "context",
      "session",
      "metrics",
      "openai.usage",
      "extensions"
    ],
    "hidden": []
  }
}
```

Hidden usage items stop automatic usage requests. Disabling the footer restores Pi's default footer; visibility choices still apply to the status-line fallback.

## How it works

Cosmic UI is the only extension that replaces the footer. Others publish plain data over a versioned `pi.events` protocol, and Cosmic UI owns layout and rendering. Activity works the same way: producers register providers that publish bounded, revisioned snapshots, and the host validates every action against the current revision before dispatching it. Each Pi session owns a scoped Effect runtime; Git and pull-request polling is single-flight and stops on session replacement or shutdown.

See [docs/activity.md](docs/activity.md) for Activity behavior and the producer protocol, [docs/extension-authors.md](docs/extension-authors.md) for the footer protocol and shared manager APIs, and [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
