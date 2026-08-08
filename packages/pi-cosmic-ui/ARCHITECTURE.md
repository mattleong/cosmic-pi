# Cosmic UI architecture

## Purpose

Hosts the composable Pi footer, repository information, elapsed working-time indicator, settings, and the plain-data contribution protocol used by other extensions.

## Host surface

- Settings command registered by `src/settings/controller.ts`.
- Events: session lifecycle, turns, model/thinking/session changes, messages, and file-mutating tool completion.
- Cross-extension events: host query plus footer upsert/remove/invalidate.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application.ts` owns Pi registration, protocol subscriptions, and session orchestration.
- `src/layer.ts` composes config, repository probe, footer registry, protocol host, and host-callback Layers.
- `src/footer/installation.ts` owns the synchronous footer installation generation and disposal state machine.
- `src/footer/component.ts` assembles synchronous footer lines and surfaces from detached projections.
- `src/boundary/host-footer-projection.ts` materializes hostile Pi getters behind the host-callback boundary.
- `src/footer/builtin-contributions.ts` projects detached host/application data into built-in text contributions.
- The remaining `src/footer/` modules own registry/client behavior and pure responsive layout.
- `src/manager/chrome.ts` exports pure shared manager chrome: fixed-width activity frames, responsive grouped action footers, the shared narrow/stacked/wide layout tiers (`managerLayoutTier`), and the notice glyph vocabulary (`managerNoticeGlyph`) (`pi-cosmic-ui/manager`).
- `src/manager/keybindings.ts` exports the pure full-screen key resolver (internal navigation/search/text-input/confirmation contexts), Vim chord handling, distinct half-page (`Ctrl-U/D`) and full-page (`PgUp/PgDn` plus configured `tui.select.pageUp/pageDown`) motions, effective key-label formatting, reserved-key label filtering (`filterReservedKeyLabel`), and the shared modeless settings hint copy with the `?` help toggle (`fullScreenSettingsHint`) (`pi-cosmic-ui/manager/keybindings`). Reserved-key filtering also drops shift-modified printable labels (`⇧J`) by their effective printable and treats a bare configured `/` key safely; a `/` key inside a multi-key label is indistinguishable from the slash-delimited label separator, so that exact edge is deliberately deferred (label left unchanged) rather than parsed unsafely. User-facing hints never surface mode names; footer usage percentages are labeled `used` (context) and `left` (provider capacity).
- `src/config/store.ts` is the single configuration persistence door (`CosmicUiConfigStore` Context service plus the resolve/update helpers); `src/config/schema.ts` holds shape and defaults.
- `src/probe/`, `src/settings/`, and `src/working/` are vertical application features.
- `src/working/service.ts` owns the scoped elapsed-time ticker and streamed-output rate estimate for Pi's working row.
- `src/boundary/` isolates hostile synchronous host callbacks, including working-message updates.
- `src/protocol/protocol.ts` is the plain public protocol (package export `pi-cosmic-ui/protocol`). The package root publishes only the default extension; `./protocol`, `./client`, `./manager`, and `./manager/keybindings` are the named subpaths.
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
session_shutdown -> subscriptions/footer/runtime disposed
```
