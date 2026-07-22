# Code Previews architecture

## Purpose

Provides syntax-highlighted previews, structured diffs, safer write/edit presentation, settings, and cooperative tool-shell APIs.

## Host surface

- Commands: preview health and settings (`settings/controller.ts`, `commands/health.ts`).
- Events: `session_start` and `session_shutdown`.
- Tool surface: renderer registration for supported built-in tools and the public cooperative shell wrapper.

## Source map

- `src/extension.ts` is the thin Pi package entrypoint.
- `src/application/lifecycle.ts` coordinates runtime replacement, settings startup, syntax initialization, and renderer activation.
- `src/application/capability.ts` is the canonical named bridge used by synchronous callers.
- `src/application/service.ts` is the canonical session application service; its Context key follows the `application/service` path.
- `src/application/projection.ts` owns deferred/scheduled projection helpers for synchronous renderers.
- `src/layer.ts` is the sole application Layer composition root.
- `src/config/store.ts` is the settings persistence **door** (Effect `CodePreviewSettingsService` plus promise/compat helpers). Rooms: `schema`, `defaults`, `definitions`, `values`, `state`, `env`, `environment-service`, `document-store`, and internal `service.ts` (Context key retained).
- `src/settings/` owns host commands (`controller.ts`), pre-session bootstrap, the compatibility barrel (`index.ts`), and settings menus under `settings/ui/`.
- `src/syntax/` and `src/write/` are the other primary stateful features.
- `src/diff/`, `src/paths/`, `src/tools/` (including grep/path-list/shell helpers), and `src/warnings/` contain deterministic preview policy and transformation logic.
- `src/tools/` owns tool names/policy, cooperative shell API (`cooperative-tools.ts`), tool argument/result helpers (`data/`), and synchronous tool renderers (`renderers/`).
- `src/boundary/` wraps Pi/Node/Shiki/environment/JSON boundaries (`node-platform.ts` for Node file platform runs).
- `src/preview/` and feature render modules are synchronous UI (no top-level `ui/` folder).
- Package tests live under `tests/`, mirroring `src/` paths, with `*.test.ts` suffix.

## State and resources

Settings, syntax, and before-write correlation are Effect-owned and publish bounded synchronous projections. Shiki is the documented synchronous-capability exception. Pure diff and rendering calculations remain synchronous.

## Lifecycle

```text
session_start -> application lifecycle -> layer -> settings load -> renderer registration
                                           -> scoped syntax initialization
write/tool render -> frozen projections + pure rendering
session_shutdown/replacement -> capability cleared -> runtime resources disposed
```
