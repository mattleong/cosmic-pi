# pi-subagents

Session-scoped foreground and background subagents for pi.

## Features

- Fresh or forked child sessions, with fresh context as the default.
- Per-run model and thinking-effort selection with parent-session inheritance.
- Full parent tool access except recursive subagent orchestration tools.
- Optional human-readable names and immutable run IDs.
- Child-to-parent progress, warnings, and blocking questions.
- Parent steering, replies, interruption, resumption, renaming, and stopping.
- A full-screen `/subagents` fleet inspector.
- Tool calls rendered through the configurable `pi-code-previews` shell, with expanded structured child-session output and Markdown reports.
- One declared writer per shared working directory.
- Exact session ownership: every child process stops when the parent session ends.

## Commands

- `/subagents` opens the fleet inspector in interactive TUI mode.

The main agent operates the fleet through the `subagent` tool.
