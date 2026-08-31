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
- `src/auth/auth.ts` owns credential schemas, the `XaiCredentials` shape, file reads, refresh, and model-registry fallback. These operations return credentials or `undefined` through typed Effects instead of a second result algebra. JWT team extraction is a total synchronous projection: it decodes payload text through `Option` and `Schema.decodeUnknownOption`, and invalid, missing, or blank claims become `undefined`. Decoded tokens remain `Redacted` until the OAuth-refresh or billing HTTP transport constructs its request.
- `src/usage/`, `src/settings/`, and `src/footer/` are the usage, settings, and fallback-footer features. Usage consumers import the owning module directly; there is no private usage barrel. `settings/controller.ts` offers finite argument completions and pure command dispatch (shared `completeSettingsArguments`/`dispatchSettingsCommand` from `pi-cosmic-core`; `diagnostics` is the only diagnostics verb — there is no `debug` alias); bare `/xai-settings` in TUI mode opens a modeless Vim-motion interactive settings list (via the shared `pi-cosmic-ui/manager/settings-surface` composition over the settings-adapter Vim adapter), while the scriptable `id value`, `help`, and `diagnostics` forms remain. The interactive list tracks a separate generation for each setting, so an older settlement cannot replace a newer optimistic value. The current failure restores the latest persisted projection value, or the value captured before that edit when the projection is unavailable. Typed config/setting errors keep their error notification, runtime rejection uses the generic warning, and rollback still runs when notification callbacks throw. Hostile list and render callbacks stay contained at the host boundary.
- `src/usage/controller.ts` owns the usage Context service, `projection.ts` owns frozen projection policy, and `debug.ts` owns deterministic diagnostics. `format.ts` owns provider schemas and parses only the response bodies already decoded by `JsonHttpClient`. A known on-demand cap with unreported spend renders as unavailable; a reported numeric zero renders as `$0`.
- `src/config/` contains configuration schemas and deterministic policy. Resolution applies decoded project fields over global fields over defaults, then clamps the refresh interval to 5 seconds. Each descriptor's dotted setting ID is the authority for its persisted section and key.
- `src/boundary/` contains the model-registry adapter and the package-local Pi host UI adapter (`host-ui.ts`). The named settings UI adapter fail-closes hostile mode/capability getters and guards custom-surface open, rejected thenables, deferred factory invocation, `done`, list updates, render requests, styling/keybindings, and composed render/invalidate/input delegation through `invokeHostCallback`.
- `src/ui/primitives.ts` reads frozen usage projections and emits plain Cosmic UI contributions.

## State and resources

`XaiUsageService` owns refresh state and publishes an immutable synchronous projection. `XaiUsageService` and `ModelRegistryAuth` infer their contracts from their `Context.Service` make Effects, while `layer.ts` and each service keep explicit Layers.

Credential resolution returns a successful due refresh first. A failed provider exchange keeps its still-valid file token. Otherwise the model registry precedes a usable file token, and an expired file's refresh error surfaces only when the registry has no replacement. Rejected-token recovery tries a matching file refresh, then a changed registry token, without retrying the rejected token. A successful OAuth exchange commits through the document store's serialized `modifyObject`. The commit compares the access token, refresh token, and expiry captured before the request. An unchanged tuple receives the refresh result while preserving unrelated fields. A concurrent login skips the stale write and returns the current credentials. Concurrent removal remains missing, malformed current credentials retain their decode error, and document-store failures retain a redacted write error.

Omitted project-trust input is treated as untrusted by the shared usage controller, so project-local configuration requires literal-true trust. The session runtime owns polling, auth/HTTP work, and cleanup. Renderers never run Effects.

## Lifecycle

```text
Pi session_start -> extension -> application -> layer -> XaiUsageService
Pi event/command -> runtime slot -> service transition -> frozen projection -> footer/UI
Pi session_shutdown -> runtime disposal -> projection reset
```
