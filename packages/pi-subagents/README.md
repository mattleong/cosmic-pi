# pi-subagents

Session-scoped foreground and background subagents for pi.

## Features

- Fresh or forked child sessions, with fresh context as the default.
- Per-run model and thinking-effort selection with parent-session inheritance.
- Full parent tool access except recursive subagent orchestration tools.
- Optional human-readable names and immutable run IDs.
- Immediate child-to-parent completions, progress, warnings, and blocking questions.
- Parent steering, replies, interruption, resumption, renaming, and stopping.
- A full-screen `/subagents` fleet inspector.
- Tool calls rendered through the configurable `pi-code-previews` shell, with expanded structured child-session output and Markdown reports.
- One declared writer per shared working directory.
- Exact session ownership: every child process stops when the parent session ends.

## Commands

- `/subagents` opens the responsive fleet inspector in interactive TUI mode.

Fleet controls:

- `j` / `k` or arrow keys select a run.
- `Ctrl-J` / `Ctrl-K` (`C-j` / `C-k` in the footer) scroll the selected run's session output while preserving live tail-follow at the bottom.
- `Enter` toggles details in narrow layouts.
- `t` toggles technical details such as run ID, PID, cwd, and session file.
- `?` switches compact shortcut help on narrow terminals.
- `m`, `i`, `r`, `n`, and `x` message, interrupt, resume, rename, and stop the selected run.
- `Esc` closes the inspector.

Structured session output groups adjacent repeated tools while retaining compact target summaries, wraps long targets and paths, shows state-specific idle messages and completion age, and labels the child's delivered response as **Final report — sent to parent**. `subagent status` returns a compact labeled metadata summary without activity history; full activity remains in `/subagents`. Background completions are delivered to the parent immediately. The main agent operates the fleet through the `subagent` tool.
