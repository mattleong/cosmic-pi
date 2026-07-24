# Architecture

`pi-background-terminals` is an Effect-managed Pi extension for session-scoped local background jobs.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — session lifecycle, tool, `/ps`, and footer wiring.
- `src/config/` — shape/defaults, normalization, and the single persistence store door.
- `src/boundary/local-process.ts` — Node child-process and process-tree adapter.
- `src/boundary/host-ui.ts` — exception-safe Pi status projection.
- `src/job/` — job model, typed errors, bounded logs, projection, and scoped service owner.
- `src/tools/` — `background_terminal` registration and pure rendering, decorated through the public `pi-code-previews` cooperative shell.
- `src/ui/` — pure full-screen `/ps` presentation, interaction, and terminal-text sanitization.

## Ownership

`BackgroundTerminalService` is the only job-registry owner. Each process monitor is forked into the service scope. Closing the session runtime stops every active process tree and awaits settlement. Pi callbacks only execute Effects through the managed session-runtime slot.

The UI and host footer project immutable service snapshots; neither owns subprocesses. Code-preview settings are loaded at session start before the tool definition is wrapped and registered; extensions exchange only the public plain tool-definition protocol.
