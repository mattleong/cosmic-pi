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
- `src/usage-controller.ts`, `src/settings/`, and `src/footer/` are the usage, settings, and fallback-footer features.
- `src/config/`, `src/usage.ts`, and `src/identity.ts` contain schemas and deterministic subscription logic.
- `src/boundary/` contains model-registry/host adapters.
- `src/ui/` reads frozen usage projections and emits plain Cosmic UI contributions.

## State and resources

`XaiUsageService` owns refresh state and publishes an immutable synchronous projection. The session runtime owns polling, auth/HTTP work, and cleanup. Renderers never run Effects.

## Lifecycle

```text
Pi session_start -> extension -> application -> layer -> XaiUsageService
Pi event/command -> runtime slot -> service transition -> frozen projection -> footer/UI
Pi session_shutdown -> runtime disposal -> projection reset
```
