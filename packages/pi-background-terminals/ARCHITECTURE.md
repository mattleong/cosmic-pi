# Architecture

`pi-background-terminals` is an Effect-managed Pi extension for session-scoped local background jobs.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — session lifecycle, tool, `/ps`, and footer wiring.
- `src/config/` — `schema.ts` shape/defaults, `options.ts` normalization, and `store.ts` as the single persistence door.
- `src/boundary/local-process.ts` — Node child-process and process-tree adapter.
- `src/boundary/host-ui.ts` — exception-safe Pi status projection and disposable manager repaint ticker.
- `src/boundary/native-clock.ts` — synchronous clock adapter for Pi render callbacks.
- `src/job/` — job model, typed errors, bounded logs with shared UTF-8 byte accounting (`utf8.ts`), projection, and scoped service owner.
- `src/tools/` — `background_terminal` registration and pure rendering, decorated through the public `pi-code-previews` cooperative shell.
- `src/ui/` — pure full-screen `/ps` presentation, interaction, terminal-text line normalization over `pi-cosmic-core`'s `stripTerminalControls`, and collapsed/expanded tool log previews. Manager state frames and responsive grouped footer fitting come from `pi-cosmic-ui/manager`, shared with `/subagents`.

## Ownership

`BackgroundTerminalService` is the only job-registry owner. Each process monitor is forked into the service scope. Closing the session runtime stops every active process tree and awaits settlement. Pi callbacks only execute Effects through the managed session-runtime slot.

The UI and host footer project immutable service snapshots; neither owns subprocesses. Code-preview settings are loaded at session start before the tool definition is wrapped and registered; extensions exchange only the public plain tool-definition protocol.
