# pi-cosmic-ui

Composable, responsive UI elements for pi. Cosmic UI provides a custom footer that combines pi's location, session, token, context, model, thinking, and extension-status information with contributions from other extensions. Active extension statuses render according to each extension's declared placement, with generic defaults for extensions that declare none. While an agent is running, Pi's working row also shows elapsed time and estimated output speed (for example, `Working · 2m 14s · ~18.4 tok/s`). The estimate uses Pi's four-characters-per-token heuristic across streamed text, thinking, and tool-call arguments. Its generation clock pauses during tool execution, while the working elapsed time continues to show total agent wall time.

## Install

```bash
pi install npm:pi-cosmic-ui
```

For local development, load Cosmic UI by itself or together with Better OpenAI:

```bash
pi -e ./packages/pi-cosmic-ui
pi -e ./packages/pi-cosmic-ui -e ./packages/pi-better-openai
```

## Configure

Run `/cosmic-ui` for all footer settings, including OpenAI usage, xAI usage, and the fast indicator. Provider settings no longer have footer modes or usage-display switches.

- Usage is `automatic` on eligible models or `hidden`. Hidden usage stops automatic requests, but `/openai-usage` and `/xai-usage` still fetch on demand.
- Hiding the fast indicator does not disable fast mode.
- Disabling the custom footer restores Pi's default footer. Provider visibility preferences still apply to its status-line fallback.

Configuration is read from `~/.pi/agent/extensions/pi-cosmic-ui.json` and may be overridden per project in `.pi/extensions/pi-cosmic-ui.json`. The `hidden` list stores visibility preferences; for example, `["openai.usage"]` hides OpenAI usage.

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
    "hidden": [],
    "mediaPlacement": "inline-right"
  }
}
```

Unknown configuration fields are preserved by the settings UI. Known fields are decoded independently, so an invalid value does not discard valid siblings.

Each active Pi session owns one scoped Effect runtime. Git and pull-request polling is single-flight, uses the current callback context, and is interrupted on session replacement, abort, or shutdown. Background Git probes disable optional locks so status refreshes do not contend with concurrent repository operations.

## Activity

`/activity` opens the session ownership tree. The compact view above the editor shows at most eight rows, with overflow counts and a needs-you shortcut section. Agent children keep their parent hierarchy. Commands and questions appear beneath an owner only when their producer supplies that relationship; otherwise they remain roots. Completed children stay with their parent, and finished root branches become collapsed history. Retention keeps at most 128 removable completed items per branch and 1,024 across the session, plus 100 finished roots. Live rows and their ancestors are never pruned; omitted history is labeled.

Both views label items as `SUBAGENT`, `TASK`, or `QUESTION`. Agent rows show the actual selected profile when supplied by the provider; hierarchy is conveyed by connectors rather than parent/child annotations. Tree connectors and expand/collapse markers show ownership; attention shortcuts and selected details include the owner path. Narrow layouts prioritize type and profile before the task name or separate state/time column. Collapsed branches summarize waiting, blocked, and failed descendants. Routine states use row icons and animations instead of repeated status labels or starting/awaiting counts. Explicitly awaited subagents also show `◎` beside their state icon; other rows reserve the same space so icons and names stay aligned when an await begins or ends. Waiting, blocked, and failed states keep explicit text. Before startup has live rows to show, one animated icon beside Activity signals work in progress. Detailed inspection still shows the selected item's state. The manager highlights the selected row across its width; when all work finishes, the persistent view becomes one quiet history summary.

In `/activity`, use the shared arrow/Vim navigation and page keys. Enter opens details, `c` collapses or expands a branch, `f` focuses or leaves a branch, and `n` cycles through items needing input. Number keys invoke the selected item's listed actions, `a` pages through longer action lists, and `r` refreshes lazy details. Explicit detail refresh preserves the viewed log position, including when viewing the previous end of the output. A fixed freshness indicator marks older details without shifting the logs, and late refresh results cannot replace a newer request. Destructive actions require a separate confirmation. Esc returns to the list, then closes; `q` closes immediately. The manager closes before handing control to a producer, so questionnaires still use Ask User's own renderer.

Producers import `registerActivityProvider` and `ActivityItem` from `pi-cosmic-ui/activity`. Register once per producer session with `pi.events`, the exact `ctx.sessionManager.getSessionId()`, a stable provider ID, a synchronous `snapshot()` returning plain summaries, and `invoke(itemId, actionId, revision, signal)`. Call `publish()` after changes and `dispose()` during session teardown. `parent: { providerId, itemId }` is explicit ownership, never an inference from labels or start times.

Every item includes a stable `id`, `kind`, `title`, `status`, and `revision`. Statuses distinguish pending, running, stopping, blocked, needs-input, done, failed, and cancelled. Optional `startedAt`, `endedAt`, and `updatedAt` are finite epoch milliseconds for elapsed/update information. Optional `summary`, static `detail`, and `{ id, label, confirmation? }` actions must contain display-safe information, not credentials or raw provider errors. Destructive actions must supply a `confirmation` prompt that describes their scope, including affected descendants. The host validates, sanitizes, detaches, and freezes summaries. Snapshots are limited to 512 items per provider and 16 actions per item. Details are limited to 16,384 characters. Use optional `getDetail(itemId, revision, signal): Promise<string>` for logs or other lazy detail. It runs only when the user opens or refreshes details, and previous detail remains marked stale when the item updates. Revisions must change whenever the item or its available actions change.

`onAvailability(available)` and `isAvailable()` report acknowledged replacement ownership, not merely that Cosmic UI was discovered. Producers must keep their old panel until availability becomes true and restore it when availability becomes false. RPC and headless sessions never acknowledge the TUI replacement. The host checks its activation nonce, session registration, item revision, and action membership before dispatch. Replayed old registrations cannot enter a replacement host. Invalid or oversized snapshots withdraw acknowledgement, and the next valid publication can recover. Producers must honor the supplied cancellation signal and also check their current session generation, revision, ownership, and action policy immediately before operating.

## Extension contributions

The public `pi-cosmic-ui/protocol` subpath exports the versioned `pi.events` channel names and contribution types. A producer first queries for a host and then upserts keyed text, status-placement, or media contributions. Text contributions provide plain text plus a semantic tone, and may declare a line `label` (details entries with a label render as their own labeled line), a theme `color` token, and a `decorates` target (the contribution's text is prefixed onto the target entry, or rendered standalone when the target is absent). Status contributions declare footer placement (region, alignment, priority, order) for a host status entry published through `ctx.ui.setStatus`; the status text keeps flowing through the host, so it still renders without Cosmic UI. Media contributions may attach to the footer's render request, detach when the footer is hidden or replaced, and dispose when removed. Producers must remove their contributions during `session_shutdown`.

Cosmic UI is the sole custom-footer owner among Cosmic extensions. It has no runtime dependency on providers. Its settings name the supported contribution IDs, while producers declare placement, labels, colors, and decorations. The v2 host query/state protocol reports footer ownership, settings readiness, and hidden IDs. Providers wait for settings readiness before automatic requests, honor visibility even when the custom footer is disabled, and use keyed Pi status entries when no custom footer is active. Host state changes include visibility updates, not just installation changes. There are no old-protocol aliases or footer-setting migrations.

The public `pi-cosmic-ui/manager` subpath provides pure shared chrome for full-screen extension managers: fixed-width activity frames, responsive grouped footer fitting, shared narrow/stacked/wide layout tiers, and a consistent status vocabulary (`◌` pending, animated Braille running, `✓` done, `✗` failed, `⊘` stopped/cancelled, `◒` stopping). `/subagents`, `/tasks`, and Code Mode use these primitives so their state animation and status presentation remain aligned; equal-cadence animations share one ref-counted host ticker instead of creating phase-shifted timers per card or overlay. The `pi-cosmic-ui/manager/keymap` subpath (with key-label helpers under `pi-cosmic-ui/manager/key-labels`) provides their shared modeless Vim navigation policy (`j/k`, `h/l`, `Ctrl-u/d` half-page, `PgUp`/`PgDn` full-page, `gg/G`, `/`, `?` contextual help, and `q`) while preserving configured Pi selection bindings and normal text entry; hints never surface editor-style mode names, and configured key labels that collide with screen-reserved shortcuts are filtered from help lines. The `pi-cosmic-ui/manager/list-detail` subpath provides their pure shared list/detail primitives — selection reconciliation, the motion reducer (Esc returns from detail to the list, then closes; `q` always closes), bottom-anchored detail windows with a standardized position label, pane geometry, and row padding. The `pi-cosmic-ui/manager/list-detail-shell` subpath adds a small stateful `ListDetailShell` for generic selection, pane, layout, detail-scroll, page-size, and keymap-chord state. It exports `listDetailFrame(theme)` plus pure framed row, fill, wide, stacked, and screen helpers. `framedFill` accepts raw lines and handles framing, clipping, and empty-row fill. Consuming managers keep Enter policy, actions, prompts, follow behavior, and rendering copy.
