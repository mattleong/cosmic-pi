# pi-cosmic-ui

Shared, responsive UI for Pi: a composable footer, a unified Activity view for workflows, subagents, and tasks, and the manager building blocks the other Cosmic Pi extensions use.

## Features

- **Custom footer** combining location, Git branch and pull request, session, tokens, context, model, and thinking level with contributions from other extensions such as OpenAI and xAI usage.
- **Responsive layout** with density, ordering, and per-item visibility settings.
- **Working indicator** with elapsed time and estimated output speed, such as `Working · 2m 14s · ~18.4 tok/s`.
- **Activity view** that shows workflows, subagents, background tasks, and questions in one place, as a compact live panel above the editor and a full-screen manager.
- **Shared manager chrome** for other extensions: Vim-style navigation, list/detail layouts, status glyphs, settings commands, and full-screen surfaces.

## Install

```bash
pi install npm:pi-cosmic-ui
```

Other Cosmic Pi extensions detect it automatically. Without it, they fall back to Pi's status line and their own managers.

## Usage

| Command               | Action                                               |
| --------------------- | ---------------------------------------------------- |
| `/cosmic-ui settings` | Footer settings, including provider usage visibility |
| `/activity`           | Open the Activity manager                            |

`/subagents` and `/tasks` open the same manager focused on their section. In the manager, use `j`/`k` or the arrows to move, `h`/`l` to collapse or expand, Enter to inspect, `?` for help, and `q` to close. Number keys and letter shortcuts such as `x` (stop) run the selected item's actions; destructive actions ask for confirmation.

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
      "xai.usage",
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
