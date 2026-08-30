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
- `src/auth/` owns credential reads (`auth.ts`, `result.ts`) and one credential shape shared by file, refresh, and model-registry results. Decoded access and refresh tokens remain `Redacted` until the OAuth-refresh or billing HTTP transport constructs its request.
- `src/usage/`, `src/settings/`, and `src/footer/` are the usage, settings, and fallback-footer features. Usage consumers import the owning module directly; there is no private usage barrel. `settings/controller.ts` offers finite argument completions and pure command dispatch (shared `completeSettingsArguments`/`dispatchSettingsCommand` from `pi-cosmic-core`; `diagnostics` is the only diagnostics verb — there is no `debug` alias); bare `/xai-settings` in TUI mode opens a modeless Vim-motion interactive settings list (via the shared `pi-cosmic-ui/manager/settings-surface` composition over the settings-adapter Vim adapter), while the scriptable `id value`, `help`, and `diagnostics` forms remain. The interactive list's optimistic cycled value is rolled back to the persisted projection value when an apply fails — typed config/setting errors and Promise-level runtime failures alike — with hostile list/render callbacks contained at the host boundary.
- `src/usage/controller.ts` owns the usage Context service, `projection.ts` owns frozen projection policy, `debug.ts` owns deterministic diagnostics, and `format.ts` owns provider schemas and subscription formatting.
- `src/config/` contains configuration schemas and deterministic policy. Each descriptor's dotted setting ID is the authority for its persisted section and key.
- `src/boundary/` contains the model-registry adapter and the package-local Pi host UI adapter (`host-ui.ts`). The named settings UI adapter fail-closes hostile mode/capability getters and guards custom-surface open, rejected thenables, deferred factory invocation, `done`, list updates, render requests, styling/keybindings, and composed render/invalidate/input delegation through `invokeHostCallback`.
- `src/ui/primitives.ts` reads frozen usage projections and emits plain Cosmic UI contributions.

## State and resources

`XaiUsageService` owns refresh state and publishes an immutable synchronous projection. `XaiUsageService` and `ModelRegistryAuth` infer their contracts from their `Context.Service` make Effects, while `layer.ts` and each service keep explicit Layers. Omitted project-trust input is treated as untrusted by the shared usage controller, so project-local configuration requires literal-true trust. The session runtime owns polling, auth/HTTP work, and cleanup. Renderers never run Effects.

## Lifecycle

```text
Pi session_start -> extension -> application -> layer -> XaiUsageService
Pi event/command -> runtime slot -> service transition -> frozen projection -> footer/UI
Pi session_shutdown -> runtime disposal -> projection reset
```
