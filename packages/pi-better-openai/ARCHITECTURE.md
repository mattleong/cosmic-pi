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
- `src/auth/codex-auth.ts` owns synchronous lossy JWT and registry parsing plus effectful auth-file and model-registry resolution. The reads stay concurrent and interruptible. Decoded tokens remain `Redacted` until usage or image HTTP code constructs an authorization header.
- `src/usage/controller.ts`, `src/fast/service.ts`, `src/compaction/service.ts`, and `src/image/service.ts` are the feature Context service doors.
- `src/usage/projection.ts` owns frozen usage projection policy, `debug.ts` owns deterministic diagnostics, and `format.ts` owns usage protocol decoding and formatting.
- `src/image/register.ts` owns image host names, registration, result formatting, and renderer guards. `service.ts` captures one context/config snapshot, resolves request options once, and orchestrates auth, HTTP, validation, and saving. `protocol.ts` builds requests from those resolved values and schema-decodes provider events into a normalized internal union.
- `src/image/input.ts` owns input MIME detection and workspace containment. `stream.ts` owns bounded SSE framing and terminal outcomes. `output.ts` owns strict base64 decoding, output-format metadata, output containment, generated-byte validation, and publication. `types.ts` retains only contracts and constants shared across those owners.
- `src/config/schema.ts` owns config shapes and defaults, `options.ts` owns setting descriptors and update decoding, and `store.ts` is the persistence door. `src/fast/controller.ts`, `src/fast/routing.ts`, `src/fast/models.ts`, and `src/image/protocol.ts` contain deterministic policy and protocol logic.
- `src/boundary/` isolates Pi UI, provider-header and cached-transport adaptation, schema-encoded and response-bounded OpenAI compaction HTTP, and Sharp. Footer and usage projection code call the shared `pi-cosmic-core` OAuth host helper directly.
- `src/ui/primitives.ts`, `src/ui/notify-text.ts`, and `src/footer/` consume synchronous frozen projections; `notify-text.ts` formats bounded host-notification failure details; the image tool renders through the `pi-code-previews` cooperative shell.
- `src/settings/controller.ts` registers settings commands with finite argument completions and pure command dispatch from `pi-cosmic-core`. It owns write settlement, authoritative projection refresh, category-summary reconciliation, and the outer `pi-cosmic-ui/manager/settings-surface` adapter with the package's guarded host rendering. `src/settings/ui/panel.ts` projects config descriptors to upstream `SettingItem` values and owns the `SettingsList` category submenus and diagnostic text panels. The outer adapter owns search; the small nested category lists do not create a second search input. `diagnostics` remains the only diagnostics verb, and its picker item id is `diagnostics`.

## State and resources

Usage, fast mode, compaction, and image work are scoped services. They publish immutable projections for synchronous request injection and rendering. Fast mode retains one `Semaphore` and one `Ref` to serialize transitions before publishing its frozen boundary snapshot. Persisted transitions pass that publication through config persistence's durable `afterCommit`, so the committed document and authoritative fast state cannot diverge. Fast-mode startup returns its scoped injection ingress through the session slot, so only the current activation can install it and deactivation immediately restores a no-op boundary. Omitted project-trust input is treated as untrusted; project-local configuration is read only after literal-true trust. OpenAI checkpoints live in normal branch-local Pi compaction entries under typed extension details; their kept boundary preserves the original Pi transcript for tree navigation. Image streaming, file handles, and background refresh work are owned by the session runtime. Image publication commits at the exclusive hard link. After that link succeeds, verification may report a positive identity mismatch but never removes the destination, which may already be a foreign replacement. Finalization removes only the identity-verified owned temporary file.

## Lifecycle

```text
session_start -> application -> layer -> abort-aware preview-settings bootstrap
                              -> usage + fast + image services -> current-session activation
current-session activation -> register image command/tool with captured preview shell settings
command/event -> runtime service -> projection -> footer/UI or request injection
Pi compaction trigger -> OpenAI /responses/compact -> custom checkpoint -> request projection
session_shutdown -> fibers/resources disposed -> projections reset
```
