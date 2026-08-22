# Better OpenAI architecture

## Purpose

Adds OpenAI subscription usage, fast-mode request injection, provider-native compaction, image generation, settings, and footer output to Pi.

## Host surface

- Flag/command: `--fast` and `/fast`.
- Commands/tools: `/openai-usage`, settings commands, and the image tool/command registered under `src/image/`.
- Events: session lifecycle, agent/turn/model/message changes, `session_before_compact`, `before_provider_headers`, and `before_provider_request`.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application.ts` coordinates commands, host events, projections, and one session runtime.
- `src/layer.ts` composes usage, fast-mode, image, platform, and file/Sharp Layers.
- `src/auth/` owns Codex OAuth credential reads (`codex-auth.ts`, `result.ts`); decoded and registry access tokens remain `Redacted` until the usage or image HTTP transport constructs its authorization header.
- `src/usage/index.ts`, `src/fast/service.ts`, `src/compaction/`, and `src/image/` own the major feature resources.
- `src/usage/controller.ts` is the usage Context service door; `projection.ts` owns frozen projection policy and `debug.ts` owns deterministic diagnostics.
- `src/image/service.ts` is the image Context service door and orchestration path; `input.ts`, `stream.ts`, and `output.ts` isolate safe input reads, bounded Effect SSE decoding, generated-byte validation, and atomic publication.
- The remaining `src/image/` modules own types, pure helpers, host registration, and protocol.
- `src/config/`, `src/fast/controller.ts`, `src/fast/routing.ts`, `src/fast/models.ts`, `src/usage/format.ts`, and `src/image/protocol.ts` contain schemas and deterministic policy/protocol logic.
- `src/boundary/` isolates Pi UI, provider-header and cached-transport adaptation, model registry, schema-encoded and response-bounded OpenAI compaction HTTP, and Sharp.
- `src/ui/primitives.ts`, `src/ui/notify-text.ts`, and `src/footer/` consume synchronous frozen projections; `notify-text.ts` formats bounded host-notification failure details; the image tool renders through the `pi-code-previews` cooperative shell.
- `src/settings/controller.ts` registers settings commands/pickers with finite argument completions and pure command dispatch (shared `completeSettingsArguments`/`dispatchSettingsCommand` from `pi-cosmic-core`; `diagnostics` is the only diagnostics verb — there is no `debug` alias and the picker's diagnostics item id is `diagnostics`) and composes the hierarchical settings surface through the shared `pi-cosmic-ui/manager/settings-surface` factory (this package's `safeHostUi` guard stays injected at the boundary).

## State and resources

Usage, fast mode, compaction, and image work are scoped services. They publish immutable projections for synchronous request injection and rendering. Omitted project-trust input is treated as untrusted; project-local configuration is read only after literal-true trust. OpenAI checkpoints live in normal branch-local Pi compaction entries under typed extension details; their kept boundary preserves the original Pi transcript for tree navigation. Image streaming, file handles, and background refresh work are owned by the session runtime.

## Lifecycle

```text
session_start -> application -> layer -> abort-aware preview-settings bootstrap
                              -> usage + fast + image services -> current-session activation
current-session activation -> register image command/tool with captured preview shell settings
command/event -> runtime service -> projection -> footer/UI or request injection
Pi compaction trigger -> OpenAI /responses/compact -> custom checkpoint -> request projection
session_shutdown -> fibers/resources disposed -> projections reset
```
