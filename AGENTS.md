# Agent guidance for cosmic-pi

## Repository layout

This is a pnpm workspace. Shared configuration lives at the root; package source and tests live inside each package.

The workspace supports macOS and Linux. Use POSIX paths and process-group lifecycle behavior.

- `packages/pi-ask-user/`: structured user questionnaires.
- `packages/pi-background-task/`: session-scoped background tasks.
- `packages/pi-better-openai/`: Better OpenAI extension.
- `packages/pi-code-previews/`: builtin, native codemode, and native MCP presentation plus the cooperative tool-rendering shell.
- `packages/pi-cosmic-core/`: shared Effect runtime and platform code.
- `packages/pi-cosmic-ui/`: shared UI components and responsive footer.
- `packages/pi-directory-models/`: per-directory model and thinking-level preferences.
- `packages/pi-herdr-btw/`: reusable Herdr BTW side sessions.
- `packages/pi-subagents/`: session-scoped background subagents.

Pi/Jiti loads packages directly from TypeScript source. Do not add generated `dist/` runtime dependencies or package build prerequisites. Native `codemode` and MCP execution belong to Pi; the retired `pi-code-mode`, `pi-mcp`, and standalone `pi-mcp-previews` packages have no compatibility layer. Code Previews requires Pi 1.0.1 or later and is tested with 1.2.0. Subagents requires Pi 1.2.0 or later. Previously installed standalone MCP Previews must be removed manually; never edit user configuration automatically.

## Architecture and organization

Read the package's `ARCHITECTURE.md` and the relevant [shared contracts](docs/architecture/effect-v4.md) before changing ownership or lifecycle. Architecture files describe the current design; they are not a mandate to preserve existing package boundaries or file trees.

- Organize code around cohesive behavior and explicit state/resource owners. A module, service, or package boundary should isolate a responsibility, lifetime, external dependency, or reusable contract. Do not add layers or wrappers solely to match a template.
- Keep Pi registration and Effect execution at identifiable host boundaries. `extension.ts`, `application.ts` or `application/`, and `layer.ts` are useful conventions where those roles exist; small extensions may combine them. Pure functions need no service or Layer.
- Common locations include `config/` for schemas and persistence, `settings/` for commands and pickers, `boundary/` for I/O adapters, and feature directories for behavior. Names and placement may change when that improves cohesion. Prefer a discoverable public entrypoint for each role and one owner for each persisted document.
- Services own application state, resources, and concurrency. Renderers consume synchronous projections without running services or acquiring application resources. Widgets may own local input, selection, focus, and layout state.
- File size and function complexity are review signals. Split when responsibilities diverge or a unit becomes hard to understand; keep cohesive logic together. Do not split or merge solely to meet a count.
- Use names and types to explain what code does. Add concise comments for nonobvious reasons, ownership handoffs, or external constraints; avoid narrating the implementation.
- Keep strict TypeScript: no explicit `any` or type assertions other than `as const`. Decode unknown external input with Effect Schema.
- Replace internal paths directly when refactoring. Preserve supported public contracts and saved data. Compatibility or migration code needs a concrete supported consumer, a documented lifetime, and behavioral coverage; do not retain speculative shims.
- Package tests live under `tests/` and use `*.test.ts`, as required by the test runners. Organize them around behavior; mirroring source folders is optional.
- Keep package `ARCHITECTURE.md` files focused on purpose, ownership, boundaries, lifecycle, and critical invariants. Link to focused integration notes and tests for detailed rationale. Avoid duplicating shared rules, source inventories, rendering constants, or change history.
- Share platform/runtime capabilities through `pi-cosmic-core` when consumers need the same contract. Keep feature policy with its owner. Change package boundaries when that reduces coupling; preserve public exports consumed by the workspace or update their consumers together.

## Tool rendering

Follow [tool presentation](docs/architecture/tool-presentation.md) for registration, replay, compact issues, full expansion, and fallback. Workspace-owned visible tools use `withCodePreviewShell` and declare `pi-code-previews` as a runtime dependency. Renderer-only integrations use `withCodePreviewRenderers`; headless tools and non-tool commands/settings do not need the shell.

Pi owns native codemode/MCP execution, activation, permissions, connections, and stored results. Presentation must not acquire execution authority. Code Previews uses a stable public renderer resolver with exact source admission; write's real before-write snapshot hook is the sole execution-hook exception. Owned tools retain their normal executable registrations.

Load trusted project preview settings before session tool registration. Factory-time replay bridges capture their originating owner, publish only after successful registration, settle startup, and retire on shutdown. Historical rendering must never execute tools or borrow another session's settings or scheduler.

Every error or warning has a short human-facing `CompactIssue.message` visible collapsed and expanded; recovery procedures and diagnostics belong in expanded `detail`. Preserve complete input, output, recovery evidence, and native images through expansion. Exercise actual registrations or public renderer callbacks with `pi-code-previews/testing`, including `issueMessageStyleProblems` for issue producers. Use `pnpm presentation:gallery` for visual review and add a scenario when introducing a visible state.

## Testing policy

Tests protect durable behavior, not implementation details or third-party assumptions. Keep coverage for domain logic, persistence, security, lifecycle, concurrency, cancellation, cleanup, and failure recovery.

Do not test:

- Bare symbol existence. Test registration only when discovery or conditional wiring can fail outside TypeScript.
- Contracts already enforced by TypeScript or schemas.
- Exact provider payloads, endpoints, headers, events, or model catalogs.
- Exact UI copy, layout, colors, icons, ANSI output, or key hints.
- Internal call order or counts without an observable behavioral consequence.

Mock owned domain boundaries, not external provider protocols. Test command handlers and UI state transitions rather than wiring or presentation. A behavior-preserving refactor should not break a test.

## Effect architecture

- The workspace uses exact Effect v4 stable versions pinned in `pnpm-workspace.yaml`.
- Read `docs/architecture/` before changing application architecture.
- Use Effect v4 documentation and treat pinned declarations as authoritative when they differ. Review release notes and run the full validation gate on every Effect upgrade.
- New or migrated packages must extend `tsconfig.effect.json`; all packages must inherit the Effect language-service plugin.
- Keep Effect runners at named Pi host boundaries, scope every resource and background fiber, use Effect Schema at unknown boundaries, and model expected failures with typed tagged errors.
- Do not import Zod, define schemas with it, or declare it as a direct workspace dependency. Third-party packages may use Zod internally through transitive dependencies. TypeBox or literal JSON Schema is allowed only where Pi requires tool parameter schemas.

## Verification

Install dependencies from the repository root with `pnpm install`. Run the narrowest relevant package checks first, then the full validation gate:

```bash
pnpm --filter <package-name> test
pnpm validate
```

Run both after architecture changes. TypeScript, type-aware Oxlint (`oxlint --type-aware` through `oxlint-tsgolint`), the Effect language service, and tests check safety and behavior; review checks ownership and cohesion.

Do not commit `node_modules/`, generated `dist/` output, local `.pi/` state, credentials, or generated images.

## Release safety

All workspace packages use a single synchronized version. Run `pnpm version:check` after version changes. Do not publish packages, create tags, or push release commits unless the maintainer explicitly requests it.
