# Better xAI architecture

## Purpose

Adds xAI subscription-usage refresh, settings, status commands, and footer output to Pi.

## Host surface

- Command: `/xai-usage` plus the settings commands registered by `settings/controller.ts`.
- Events: `session_start`, `turn_end`, `model_select`, and `session_shutdown`.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application.ts` registers commands/events and coordinates one session runtime.
- `src/layer.ts` composes the xAI application Layer.
- `src/auth/` owns credential reads (`auth.ts`, `result.ts`); decoded access and refresh tokens remain `Redacted` until the OAuth-refresh or billing HTTP transport constructs its request.
- `src/usage/index.ts`, `src/settings/`, and `src/footer/` are the usage, settings, and fallback-footer features. `settings/controller.ts` offers finite argument completions and pure command dispatch (shared `completeSettingsArguments`/`dispatchSettingsCommand` from `pi-cosmic-core`; `diagnostics` is the only diagnostics verb — there is no `debug` alias); bare `/xai-settings` in TUI mode opens a modeless Vim-motion interactive settings list (via the shared `pi-cosmic-ui/manager/settings-surface` composition over the settings-adapter Vim adapter), while the scriptable `id value`, `help`, and `diagnostics` forms remain. The interactive list's optimistic cycled value is rolled back to the persisted projection value when an apply fails — typed config/setting errors and Promise-level runtime failures alike — with hostile list/render callbacks contained at the host boundary.
- `src/usage/controller.ts` owns the usage Context service, `projection.ts` owns frozen projection policy, `debug.ts` owns deterministic diagnostics, and `format.ts` owns provider schemas and subscription formatting.
- `src/config/` contains configuration schemas and deterministic policy.
- `src/boundary/` contains the model-registry adapter and the Pi host adapters (`host-callback.ts`, `host-notifier.ts`, `host-ui.ts`).
- `src/ui/primitives.ts` reads frozen usage projections and emits plain Cosmic UI contributions.

## State and resources

`XaiUsageService` owns refresh state and publishes an immutable synchronous projection. The session runtime owns polling, auth/HTTP work, and cleanup. Renderers never run Effects.

## Lifecycle

```text
Pi session_start -> extension -> application -> layer -> XaiUsageService
Pi event/command -> runtime slot -> service transition -> frozen projection -> footer/UI
Pi session_shutdown -> runtime disposal -> projection reset
```
