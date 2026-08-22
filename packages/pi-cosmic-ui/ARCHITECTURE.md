# Cosmic UI architecture

## Purpose

Hosts the composable Pi footer, repository information, elapsed working-time indicator, settings, and the plain-data contribution protocol used by other extensions.

## Host surface

- Settings command registered by `src/settings/controller.ts`.
- Events: session lifecycle, turns, model/thinking/session changes, messages, and file-mutating tool completion.
- Cross-extension events: host query plus footer upsert/remove/invalidate.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application.ts` owns Pi registration, protocol subscriptions, and session orchestration. Startup hands the working-timer service to the current activation through the runtime slot; failed or superseded startup cannot publish it.
- `src/layer.ts` composes config, repository probe, footer registry, protocol host, and host-callback Layers.
- `src/footer/installation.ts` owns the synchronous footer installation generation and disposal state machine.
- `src/footer/component.ts` assembles synchronous footer lines and surfaces from detached projections.
- `src/boundary/host-footer-projection.ts` materializes hostile Pi getters behind the host-callback boundary; `src/boundary/host-usage.ts` Schema-decodes non-negative finite usage, context, and model numbers before arithmetic or rendering.
- `src/footer/builtin-contributions.ts` projects detached host/application data into built-in text contributions.
- The remaining `src/footer/` modules own registry/client behavior and pure responsive layout. Text/status contributions are terminal-sanitized, and surface layout preserves only exact anchored Kitty/iTerm image lines plus safe visual SGR on ordinary lines.
- `src/manager/chrome.ts` exports pure shared manager chrome: fixed-width starting/Braille activity frames, responsive grouped action footers, the shared narrow/stacked/wide layout tiers (`managerLayoutTier`), and the unified status vocabulary (`◌` pending, Braille running, `✓` done, `✗` failed, `⊘` stopped/cancelled, `◒` stopping) through `managerNoticeGlyph` / `managerStateGlyph` (`pi-cosmic-ui/manager`).
- `src/manager/keymap.ts` (`pi-cosmic-ui/manager/keymap`) exports the pure full-screen key resolver (internal navigation/search/text-input/confirmation/busy contexts), Vim chord handling, distinct half-page (`Ctrl-U/D`) and full-page (`PgUp/PgDn` plus configured `tui.select.pageUp/pageDown`) motions, the printable decoder (`decodeFullScreenPrintable`, which rejects DEL as a control key in both raw and Kitty encodings), and the pure `pageSteps` full/half page-step arithmetic shared by full-screen list surfaces. The busy context resolves only Esc/configured cancel to `cancel` and `q`/`Q` to `quit` and swallows every other key, so overlays with an in-flight operation stay dismissible without exposing navigation or shortcuts.
- `src/manager/key-labels.ts` (`pi-cosmic-ui/manager/key-labels`) exports effective key-label formatting for the current host keyboard (`formatFullScreenKeyId`, `fullScreenKeybindingLabel`) and reserved-key label filtering (`filterReservedKeyLabel`). Known modifiers format explicitly (`ctrl` → `C-`, `shift` → `⇧`, `alt` → `A-`, `super` → `⌘`); an unknown modifier keeps its own name as `<name>-` instead of borrowing the command glyph. Reserved-key filtering also drops shift-modified printable labels (`⇧J`) by their effective printable and treats a bare configured `/` key safely; a `/` key inside a multi-key label is indistinguishable from the slash-delimited label separator, so that exact edge is deliberately deferred (label left unchanged) rather than parsed unsafely.
- `src/manager/list-detail.ts` (`pi-cosmic-ui/manager/list-detail`) exports the pure, closed list/detail manager primitives shared by `/subagents` and `/ps`: selection clamping/reconciliation over row identities, the shared modeless motion reducer (standardized Esc: detail returns to the list, the list closes; `q` always closes), bottom-anchored detail windows with the standardized position label, wide/stacked pane geometry, centered row windows, exact-width row padding, and reserved-shortcut confirmation resolution. Detail windows reserve the position row only when more than one row exists — a one-row window always shows content and omits the label — and follow is tri-state: `true` pins to the newest lines, an explicit `false` keeps the viewed slice anchored even from the bottom while new lines arrive, and `undefined` means the caller has no follow policy so scroll 0 keeps tracking the newest lines. The module has no domain imports and takes no host callbacks; Enter/confirm policy, row rendering, actions, prompts, and follow behavior stay caller-owned.
- `src/manager/settings-adapter.ts` (`pi-cosmic-ui/manager/settings-adapter`) exports the shared modeless settings hint copy with the `?` help toggle (`fullScreenSettingsHint`), the pure `settingsHintRenderer` (theme-dim `renderHint` factory over the shared copy; SettingsList surfaces advertise `C-u/d/PgUp/PgDn page` as one motion because the adapter translates both to the same page input), `VimSettingsAdapter`, and `settingsSurfaceBridge`, the minimal focus/render bridge for `ctx.ui.custom` settings surfaces — callers keep ownership of their host guards (`safeHostUi`/`hostQuery`/…) by passing `invoke`/`afterInput`. User-facing hints never surface mode names; footer usage percentages are labeled `used` (context) and `left` (provider capacity). `VimSettingsAdapter` explicitly couples to the pinned pi-tui SettingsList's private `searchInput` (including its `setValue`), `applyFilter`, and `submenuComponent` internals; Esc leaving search never forwards a close to the child and instead clears the typed filter text and re-applies the empty filter so a dismissed search cannot keep filtering the list invisibly. That contract is documented on the adapter's bridge type and must be reviewed directly when pi-tui is upgraded.
- `src/manager/settings-surface.ts` exports the pure shared `ctx.ui.custom` settings-surface composition `createSettingsListSurface` (`pi-cosmic-ui/manager/settings-surface`): caller header chrome + `SettingsList` + `VimSettingsAdapter` (shared hint renderer) + `settingsSurfaceBridge`, returning the composed focusable surface plus the list for optimistic value updates. Host-boundary safety remains injected and caller-owned (guarded `requestRender`, `bridge.invoke`, change/cancel callbacks); the module absorbs no `safeHostUi`/`recoverHostUi`/`hostQuery` ownership.
- `src/config/store.ts` is the single configuration persistence door (`CosmicUiConfigStore` Context service plus the resolve/update helpers); `src/config/schema.ts` holds shape and defaults.
- `src/probe/`, `src/settings/`, and `src/working/` are vertical application features. `src/probe/pi-exec.ts` is the sole Git/`gh` process boundary; it disables optional locks for every background Git probe while leaving `gh` arguments unchanged.
- `src/working/service.ts` owns the scoped elapsed-time ticker and streamed-output rate estimate for Pi's working row.
- `src/boundary/` isolates hostile synchronous host callbacks, including working-message updates.
  `host-ui-ticker-pool.ts` multiplexes equal-cadence animation consumers onto one Effect fiber per
  cadence. One pool-level Effect `Scope` owns those fibers, so synchronous unsubscribe can interrupt
  one cadence and idempotent disposal closes and awaits the whole pool without a Promise registry.
  One throwing callback cannot starve its peers. The exported host-status owner remains
  cross-extension, but Cosmic UI rotates it during session shutdown and awaits the old pool so a
  later session receives a fresh pool without inheriting timer fibers.
- `src/protocol/protocol.ts` is the plain public protocol (package export `pi-cosmic-ui/protocol`). The package root publishes only the default extension; `./protocol`, `./boundary/host-status`, `./client`, `./manager`, `./manager/keymap`, `./manager/key-labels`, `./manager/list-detail`, `./manager/settings-adapter`, and `./manager/settings-surface` are the named subpaths.
- `src/protocol/host.ts` is the scoped protocol ingress host.
- `src/protocol/service.ts` is the session host service (`CosmicUiService`; Context keys follow file paths under `protocol/`).

## State and resources

`CosmicUiService` publishes frozen config, totals, git, and pull-request projections. `FooterRegistryService` owns contribution lifetimes. The footer renderer reads projections synchronously and does not run Effect.

## Lifecycle

```text
protocol events -> bounded buffer -> scoped protocol host -> registry snapshot
session_start -> application -> layer -> services -> footer installation
agent_start + streaming deltas -> working timer/rate estimate -> Pi working message -> agent_end reset
Pi changes -> service refresh -> frozen projection -> render request
session_shutdown -> subscriptions/footer/runtime disposed -> shared ticker pool rotated and awaited
```
