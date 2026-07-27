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
- `src/manager/chrome.ts` exports pure shared manager chrome: fixed-width activity frames and responsive grouped action footers (`pi-cosmic-ui/manager`).
- `src/config/store.ts` is the single configuration persistence door (`CosmicUiConfigStore` Context service plus the resolve/update helpers); `src/config/schema.ts` holds shape and defaults.
- `src/probe/`, `src/settings/`, and `src/working/` are vertical application features.
- `src/working/service.ts` owns the scoped elapsed-time ticker and streamed-output rate estimate for Pi's working row.
- `src/boundary/` isolates hostile synchronous host callbacks, including working-message updates.
- `src/protocol/protocol.ts` is the plain public protocol (package export `pi-cosmic-ui/protocol`). The package root publishes only the default extension; `./protocol`, `./client`, and `./manager` are the named subpaths.
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
