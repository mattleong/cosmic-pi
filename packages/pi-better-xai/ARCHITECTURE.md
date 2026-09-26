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
- `src/auth/auth.ts` turns the `ModelRegistryAuth` key into a `Redacted` token plus total JWT team metadata; Pi's model registry owns credential resolution, refresh, and persistence.
- `src/usage/` and `src/settings/` own usage behavior and provider settings. Usage consumers import the owning module directly; there is no private usage barrel. `settings/controller.ts` registers `/xai-settings` through Cosmic UI's shared settings command shell (`pi-cosmic-ui/boundary/host-settings-command`), which owns completions, help, diagnostics, validation messages, the scriptable `id value` apply, and a required signal: a throwing signal getter makes the settings unavailable. `diagnostics` is the only diagnostics verb. The controller supplies the persistence call and its flat picker: bare `/xai-settings` in TUI mode opens a modeless Vim-motion settings list (the shared `pi-cosmic-ui/manager/settings-surface` composition over the settings-adapter Vim adapter). The list uses Cosmic UI's per-row generation latch, so an older settlement cannot replace a newer optimistic value. The shared apply restores the latest persisted projection value after a failure, or the value captured before that edit when the projection is unavailable. Typed config/setting errors keep their error notification, runtime rejection uses the generic warning, and rollback still runs when notification callbacks throw. Hostile list and render callbacks stay contained at the host boundary.
- `src/usage/controller.ts` owns the usage Context service, `projection.ts` owns frozen projection policy, and `debug.ts` owns deterministic diagnostics. `format.ts` owns provider schemas and pure parsing/formatting of response bodies already decoded by `JsonHttpClient`; `request.ts` owns billing HTTP requests (including the endpoint constants `debug.ts` renders). A monthly 401 re-resolves the registry once and retries only with a different token; a failed re-resolve keeps the 401 result. A known on-demand cap with unreported spend renders as unavailable; a reported numeric zero renders as `$0`.
- `src/config/` contains configuration schemas and deterministic policy. Resolution applies decoded project fields over global fields over defaults, then clamps the refresh interval to 5 seconds. Each descriptor's dotted setting ID is the authority for its persisted section and key.
- `src/boundary/` contains the model-registry adapter (`getProviderAuth`, whose rejection becomes a fixed typed error because Pi errors can carry provider text). The settings list opens on Cosmic UI's shared inline surface (`pi-cosmic-ui/boundary/host-surface`), which fail-closes hostile mode/capability getters and owns the custom-surface open, rejected thenables, factory and `done` latches, and a guarded `done`; a throwing factory reports a failed open. The controller guards render requests, styling/keybindings, and composed render/invalidate/input delegation through `invokeHostCallback`; the shared apply guards the optimistic list update.
- `src/ui/primitives.ts` projects frozen usage into plain contributions. Application orchestration queries Cosmic UI's v2 ownership, readiness, and visibility policy. Cosmic UI owns the custom footer and all visual preferences; this package never calls `setFooter`. When the custom footer is inactive or absent, the sanitized keyed Pi status path respects the same visibility policy. Hidden usage skips automatic requests; `/xai-usage` still fetches on demand. Visibility changes invalidate pending usage results and refresh newly visible usage. Activation publishes the current context; deactivation clears contributions and status before replacement startup.

## State and resources

`XaiUsageService` owns refresh state and publishes an immutable synchronous projection. `XaiUsageService` and `ModelRegistryAuth` infer their contracts from their `Context.Service` make Effects, while `layer.ts` and each service keep explicit Layers.

Omitted project-trust input is treated as untrusted by the shared usage controller, so project-local configuration requires literal-true trust. The session runtime owns polling, auth/HTTP work, and cleanup. Renderers never run Effects.

## Lifecycle

```text
Pi session_start -> extension -> application -> layer -> XaiUsageService
Pi event/command -> runtime slot -> service transition -> frozen projection -> footer/UI
Pi session_shutdown -> runtime disposal -> projection reset
```
