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

Run `/cosmic-ui` to configure footer visibility, density, and media placement. Configuration is read from `~/.pi/agent/extensions/pi-cosmic-ui.json` and may be overridden per project in `.pi/extensions/pi-cosmic-ui.json`.

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

## Extension contributions

The public `pi-cosmic-ui/protocol` subpath exports the versioned `pi.events` channel names and contribution types. A producer first queries for a host and then upserts keyed text, status-placement, or media contributions. Text contributions provide plain text plus a semantic tone, and may declare a line `label` (details entries with a label render as their own labeled line), a theme `color` token, and a `decorates` target (the contribution's text is prefixed onto the target entry, or rendered standalone when the target is absent). Status contributions declare footer placement (region, alignment, priority, order) for a host status entry published through `ctx.ui.setStatus`; the status text keeps flowing through the host, so it still renders without Cosmic UI. Media contributions may attach to the footer's render request, detach when the footer is hidden or replaced, and dispose when removed. Producers must remove their contributions during `session_shutdown`.

Cosmic UI is the sole custom-footer owner when installed. It has no package or runtime dependency on provider-specific extensions and recognizes no extension-specific contribution IDs: placement, labels, colors, and decorations are declared by the contributing extensions themselves. `pi-better-openai` detects the host and contributes fast-mode and subscription-usage primitives when both packages are loaded.

The public `pi-cosmic-ui/manager` subpath provides pure shared chrome for full-screen extension managers: fixed-width activity frames, responsive grouped footer fitting, shared narrow/stacked/wide layout tiers, and a consistent status vocabulary (`◌` pending, animated Braille running, `✓` done, `✗` failed, `⊘` stopped/cancelled, `◒` stopping). `/subagents`, `/ps`, and Code Mode use these primitives so their state animation and status presentation remain aligned; equal-cadence animations share one ref-counted host ticker instead of creating phase-shifted timers per card or overlay. The `pi-cosmic-ui/manager/keymap` subpath (with key-label helpers under `pi-cosmic-ui/manager/key-labels`) provides their shared modeless Vim navigation policy (`j/k`, `h/l`, `Ctrl-u/d` half-page, `PgUp`/`PgDn` full-page, `gg/G`, `/`, `?` contextual help, and `q`) while preserving configured Pi selection bindings and normal text entry; hints never surface editor-style mode names, and configured key labels that collide with screen-reserved shortcuts are filtered from help lines. The `pi-cosmic-ui/manager/list-detail` subpath provides their pure shared list/detail primitives — selection reconciliation, the motion reducer (Esc returns from detail to the list, then closes; `q` always closes), bottom-anchored detail windows with a standardized position label, pane geometry, and row padding. The `pi-cosmic-ui/manager/list-detail-shell` subpath adds a small stateful `ListDetailShell` for generic selection, pane, layout, detail-scroll, page-size, and keymap-chord state. It exports `listDetailFrame(theme)` plus pure framed row, fill, wide, stacked, and screen helpers. `framedFill` accepts raw lines and handles framing, clipping, and empty-row fill. Consuming managers keep Enter policy, actions, prompts, follow behavior, and rendering copy.
