# ADR 0001: Effect v4 prerelease-first architecture

- Status: Accepted
- Date: 2026-07-19

## Context

The extensions in this workspace independently manage asynchronous work, mutable lifecycle state, polling, cancellation, persistence, HTTP, decoding, caches, and resource cleanup. The OpenAI and xAI usage controllers duplicate the same lifecycle pattern, while pi-advisor and pi-code-previews contain larger manually coordinated resource graphs.

## Decision

Cosmic-pi will be rearchitected around Effect v4 prereleases through the release-candidate phase.

1. All fallible, asynchronous, stateful, concurrent, resource-owning, time-dependent, or dependency-driven application behavior is expressed with Effect.
2. Pure deterministic code may remain pure. Effect is permitted everywhere, but fake effects are not required around arithmetic, formatting, or other total calculations.
3. Effect Schema is the data boundary for configuration, persistence, protocol payloads, auth data, and HTTP responses.
4. Services use `Context.Service`; implementations use explicit Layers; resources are scoped.
5. A Pi-hosted `ManagedRuntime` is created once per started session and disposed by the Pi lifecycle boundary. Pi-hosted extensions do not use `NodeRuntime.runMain` because Pi owns the process. Standalone package executables that own their Node process may use one scoped `NodeRuntime.runMain` entrypoint.
6. TypeBox or literal JSON Schema remains only where a Pi tool API requires `TSchema`-compatible parameters.
7. A publishable `pi-cosmic-core` package owns shared services, schemas, runtime boundaries, and test layers.
8. Breaking changes are allowed when they produce a better Effect-native design. They must be intentional, tested, versioned where relevant, and documented.
9. Migration is delivered as atomic, green package cutovers. No legacy implementation remains after a package is cut over.

## Version policy

The implementation kickoff pinned Effect v4 beta.99. On 2026-08-13, the workspace advanced to the release-candidate line; on 2026-08-20 it advanced to:

- `effect@4.0.0-rc.111`
- `@effect/platform-node@4.0.0-rc.111`
- `@effect/vitest@4.0.0-rc.111`
- `@effect/tsgo@0.39.1`
- `typescript@7.0.2`

Jointly released Effect ecosystem packages are synchronized in the pnpm catalog. The independently versioned TypeScript-Go integration is pinned separately. No caret, tilde, or moving dist-tag is permitted. Every prerelease upgrade is isolated, reviewed as potentially breaking, and followed by the complete validation gate.

## Consequences

- Existing public APIs and persisted formats may change.
- Pi callbacks, synchronous TUI rendering, tool parameter schemas, and third-party Promise APIs remain explicit integration boundaries.
- Unstable Effect modules are allowed but localized behind workspace-owned adapters.
- TypeScript, Oxlint, the Effect language service, tests, and code review support the architecture without a repository-specific static-analysis layer.
- Separately loaded extensions never exchange Effect services, fibers, scopes, or runtime values; cross-extension protocols remain plain runtime values.

## Primary references

- [Effect v4 RC announcement](https://www.effect.website/blog/releases/effect/40-rc)
- [Effect v4 migration instructions](https://github.com/Effect-TS/effect/blob/main/MIGRATION.md)
- [Effect language-service setup](https://effect.website/docs/getting-started/devtools/#effect-lsp)
- [Effect v4 rc.111 Context source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.111/packages/effect/src/Context.ts)
- [Effect v4 rc.111 Layer source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.111/packages/effect/src/Layer.ts)
- [Effect v4 rc.111 ManagedRuntime source](https://github.com/Effect-TS/effect/blob/effect%404.0.0-rc.111/packages/effect/src/ManagedRuntime.ts)
