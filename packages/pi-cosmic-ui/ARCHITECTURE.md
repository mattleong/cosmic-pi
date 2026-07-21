# Cosmic UI architecture

## Purpose

Hosts the composable Pi footer, repository information, settings, and the plain-data contribution protocol used by other extensions.

## Host surface

- Settings command registered by `src/settings/controller.ts`.
- Events: session lifecycle, turns, model/thinking/session changes, messages, and file-mutating tool completion.
- Cross-extension events: host query plus footer upsert/remove/invalidate.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application.ts` owns Pi registration, protocol subscriptions, and session orchestration.
- `src/layer.ts` composes config, repository probe, footer registry, protocol host, and host-callback Layers.
- `src/features/footer/installation.ts` owns the synchronous footer installation generation and disposal state machine.
- `src/footer/` contains registry/client behavior and synchronous footer components/layout.
- `src/probe/`, `src/config/`, and `src/settings/` are vertical application features.
- `src/boundary/` isolates hostile synchronous host callbacks.
- `src/protocol.ts` is the plain public protocol; `src/protocol-host.ts` is its scoped ingress host.

## State and resources

`CosmicUiService` publishes frozen config, totals, git, and pull-request projections. `FooterRegistryService` owns contribution lifetimes. The footer renderer reads projections synchronously and does not run Effect.

## Lifecycle

```text
protocol events -> bounded buffer -> scoped protocol host -> registry snapshot
session_start -> application -> layer -> services -> footer installation
Pi changes -> service refresh -> frozen projection -> render request
session_shutdown -> subscriptions/footer/runtime disposed
```
