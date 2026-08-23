# Architecture

`pi-background-terminals` is an Effect-managed Pi extension for session-scoped local background jobs.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — session lifecycle, tool, `/ps`, and footer wiring.
- `src/config/` — `schema.ts` shape/defaults, `options.ts` normalization, and `store.ts` as the single persistence door.
- `src/boundary/local-process.ts` — scoped Effect ChildProcess and process-tree adapter; Effect owns detached shell spawning, stdout/stderr streams, force escalation, and release, while the boundary retains immediate graceful signal dispatch and the POSIX post-leader group sweep. It requests color from compatible piped CLIs with a default `FORCE_COLOR=1` while honoring explicit `FORCE_COLOR`/`NO_COLOR`. The ingress queue enforces `ingressBufferBytes` across retained UTF-8 tails and evicts the oldest event when recent output must replace a full queue.
- `src/boundary/host-ui.ts` — exception-safe Pi status projection and disposable manager repaint ticker.
- `src/boundary/native-clock.ts` — synchronous clock adapter for Pi render callbacks.
- `src/job/` — job model, typed errors, bounded logs with shared UTF-8 byte accounting (`utf8.ts`), projection, and scoped service owner. One persistent latch-driven worker coalesces output publications onto the configured leading/trailing interval.
- `src/tools/` — `background_terminal` registration and pure collapsed/expanded log rendering, decorated through the public `pi-code-previews` cooperative shell.
- `src/ui/` — pure full-screen `/ps` presentation and interaction (`manager.ts`) plus per-stream chunk reassembly and bounded safe-SGR rows (`styled-log.ts`, over `pi-cosmic-core`'s sanitizer; all active/non-visual controls remain stripped). Manager state frames, responsive grouped footer fitting, and shared layout tiers come from `pi-cosmic-ui/manager`; modeless Vim navigation (half-page `Ctrl-U/D` plus full-page `PgUp/PgDn`) comes from `pi-cosmic-ui/manager/keymap`, reserved-shortcut-filtered configured-key labels come from `pi-cosmic-ui/manager/key-labels`, and the pure list/detail selection, motion, window, and pane-geometry primitives come from `pi-cosmic-ui/manager/list-detail`, shared with `/subagents`. Half/full-page list motions use the render-computed visible list page size, so stacked layouts page by their actual rows rather than the full height. Unfollow (`f`) is sticky: the explicit `follow: false` window anchors the viewed slice even before overflow and while new lines arrive, motions that scroll away from the newest lines detach follow without silently re-following at the bottom, and toggling follow back on returns to the newest lines.

## Ownership

`BackgroundTerminalService` is the only job-registry owner. All process monitors share one fixed child scope created before the service shutdown finalizer, so shutdown requests and confirms active process settlement before monitor interruption without accumulating one owner-scope finalizer per historical job. A stop timeout or process-tree termination failure is a typed `BackgroundTerminationError`; the job remains `stopping`, consumes active capacity, and can become `stopped` only when the process handle's `awaitExit` joins the scoped exit observer after its process-group sweep. Closing the session runtime applies the same ordering to every active process tree. Release first unrefs the upstream Effect handle so its fallback finalizer cannot extend shutdown, then performs this boundary's bounded force-confirmation path; Windows always attempts `taskkill /T /F`, including after a clean leader exit, while POSIX performs the explicit post-leader group sweep. Pi callbacks only execute Effects through the managed session-runtime slot.

Session activation captures cwd/trust once, increments an application preparation generation, and immediately deactivates the prior runtime before asynchronously loading code-preview settings. Runtime startup returns the initial config and projection as an activation value; only the current activation publishes them to the host bridge. Tool registration and runtime start both reject stale, aborted, or shutdown-invalidated generations, so out-of-order settings completion cannot reactivate an older session. The settings loader is an injectable host boundary for lifecycle tests.

The UI and host footer project immutable service snapshots; neither owns subprocesses. Code-preview settings are loaded at session start before the tool definition is wrapped and registered; extensions exchange only the public plain tool-definition protocol.
