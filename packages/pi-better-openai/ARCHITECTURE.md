# Better OpenAI architecture

## Purpose

Adds OpenAI subscription usage, fast-mode request injection, image generation, settings, and footer output to Pi.

## Host surface

- Flag/command: `--fast` and `/fast`.
- Commands/tools: `/openai-usage`, settings commands, and the image tool/command registered by `image.ts`.
- Events: session lifecycle, agent/turn/model/message changes, and `before_provider_request`.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application.ts` coordinates commands, host events, projections, and one session runtime.
- `src/layer.ts` composes usage, fast-mode, image, platform, and file/Sharp Layers.
- `src/usage-controller.ts`, `src/fast-service.ts`, and `src/image.ts` own the major feature resources.
- `src/config/`, `src/fast-controller.ts`, `src/fast-models.ts`, `src/usage.ts`, and `src/image-protocol.ts` contain schemas and deterministic policy/protocol logic.
- `src/boundary/` isolates Pi UI, model registry, and Sharp.
- `src/ui/` and `src/footer/` consume synchronous frozen projections.

## State and resources

Usage, fast mode, and image work are scoped services. They publish immutable projections for synchronous request injection and rendering. Image streaming, file handles, and background refresh work are owned by the session runtime.

## Lifecycle

```text
session_start -> application -> layer -> usage + fast + image services
command/event -> runtime service -> projection -> footer/UI or request injection
session_shutdown -> fibers/resources disposed -> projections reset
```
