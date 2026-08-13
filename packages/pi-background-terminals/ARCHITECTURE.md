# Architecture

`pi-background-terminals` is an Effect-managed Pi extension for session-scoped local background jobs.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — session lifecycle, tool, `/ps`, and footer wiring.
- `src/config/` — `schema.ts` shape/defaults, `options.ts` normalization, and `store.ts` as the single persistence door.
- `src/boundary/local-process.ts` — Node child-process and process-tree adapter; requests color from compatible piped CLIs with a default `FORCE_COLOR=1` while honoring explicit `FORCE_COLOR`/`NO_COLOR`.
- `src/boundary/host-ui.ts` — exception-safe Pi status projection and disposable manager repaint ticker.
- `src/boundary/native-clock.ts` — synchronous clock adapter for Pi render callbacks.
- `src/job/` — job model, typed errors, bounded logs with shared UTF-8 byte accounting (`utf8.ts`), projection, and scoped service owner.
- `src/tools/` — `background_terminal` registration and pure rendering, decorated through the public `pi-code-previews` cooperative shell.
- `src/ui/` — pure full-screen `/ps` presentation and interaction (`manager.ts`), per-stream chunk reassembly plus bounded safe-SGR rows (`styled-log.ts`, over `pi-cosmic-core`'s sanitizer; all active/non-visual controls remain stripped), and collapsed/expanded tool log previews. Manager state frames, responsive grouped footer fitting, and shared layout tiers come from `pi-cosmic-ui/manager`; modeless Vim navigation (half-page `Ctrl-U/D` plus full-page `PgUp/PgDn`) comes from `pi-cosmic-ui/manager/keymap`, reserved-shortcut-filtered configured-key labels come from `pi-cosmic-ui/manager/key-labels`, and the pure list/detail selection, motion, window, and pane-geometry primitives come from `pi-cosmic-ui/manager/list-detail`, shared with `/subagents`. Half/full-page list motions use the render-computed visible list page size, so stacked layouts page by their actual rows rather than the full height. Unfollow (`f`) is sticky: the explicit `follow: false` window anchors the viewed slice even before overflow and while new lines arrive, motions that scroll away from the newest lines detach follow without silently re-following at the bottom, and toggling follow back on returns to the newest lines.

## Ownership

`BackgroundTerminalService` is the only job-registry owner. Each process monitor is forked into the service scope. Closing the session runtime stops every active process tree and awaits settlement. Pi callbacks only execute Effects through the managed session-runtime slot.

The UI and host footer project immutable service snapshots; neither owns subprocesses. Code-preview settings are loaded at session start before the tool definition is wrapped and registered; extensions exchange only the public plain tool-definition protocol.
