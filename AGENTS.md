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
- `packages/pi-intercom/`: cross-session registry and messaging between live Pi sessions.
- `packages/pi-subagents/`: session-scoped background subagents.

Pi/Jiti loads packages directly from TypeScript source. Do not add generated `dist/` runtime dependencies or package build prerequisites. Native `codemode` and MCP execution belong to Pi; the retired `pi-code-mode`, `pi-mcp`, and standalone `pi-mcp-previews` packages have no compatibility layer. All packages require Pi 1.4.0 or later and are tested with 1.4.0. Previously installed standalone MCP Previews must be removed manually; never edit user configuration automatically.

## Architecture and organization

Read the package's `ARCHITECTURE.md` and the relevant [shared contracts](docs/architecture/effect-v4.md) before changing ownership or lifecycle. Architecture files describe the current design; they are not a mandate to preserve existing package boundaries or file trees.

- Organize code around cohesive behavior and explicit state/resource owners. A module, service, or package boundary should isolate a responsibility, lifetime, external dependency, or reusable contract. Do not add layers or wrappers solely to match a template.
- Keep Pi registration and Effect execution at identifiable host boundaries. `extension.ts`, `application.ts` or `application/`, and `layer.ts` are useful conventions where those roles exist; small extensions may combine them. Pure functions need no service or Layer.
- Common locations include `config/` for schemas and persistence, `settings/` for commands and pickers, `boundary/` for I/O adapters, and feature directories for behavior. Names and placement may change when that improves cohesion. Prefer a discoverable public entrypoint for each role and one owner for each persisted document.
- Services own application state, resources, and concurrency. Renderers consume synchronous projections without running services or acquiring application resources. Widgets may own local input, selection, focus, and layout state.
- File size and function complexity are review signals. Split when responsibilities diverge or a unit becomes hard to understand; keep cohesive logic together. Do not split or merge solely to meet a count.
- Use names and types to explain what code does. Add concise comments for nonobvious reasons, ownership handoffs, or external constraints; avoid narrating the implementation.
- Keep strict TypeScript: no explicit `any` or type assertions other than `as const` in package source. Tests and `src/testing` entrypoints may use `as` for intentionally malformed fixtures and SDK doubles, never on object literals; valid fixtures use `satisfies`. Decode unknown external input with Effect Schema. A type predicate must check everything it claims; the only sanctioned way to admit a callback received from another package is `ForeignCallable` from `pi-cosmic-core`, with the call wrapped in `Effect.try` and its result decoded.
- Accept input generously; reject only what would change the outcome or break a safety, security, or integrity guarantee.
  - Tool arguments: treat null or blank optional values as absent. Ignore empty, `false`, or zero values in fields the chosen action doesn't use, but reject meaningful ones. Clamp out-of-range numbers in the service and state the cap in the description rather than as a schema maximum, since Pi rejects arguments before `execute`. Truncate display-only text such as names and titles instead of rejecting it.
  - Configuration and producer protocols: decode per field. An invalid field falls back to its inherited value or default with a diagnostic, and the rest of the document still applies.
  - Invalid safety controls, such as spend limits, isolation modes, setup hooks, and nesting limits, fail closed to their most restrictive setting.
  - Keep bounds that protect memory, persistence, or security, and keep rejecting input that is ambiguous or would be silently misapplied.
- Change tool contracts, saved tool results, configuration documents, and other persisted formats in place. Do not bump their versions, keep decode-only fields, add migrations, or handle legacy data; saved data that no longer decodes fails with a clear message or falls back to generic rendering. Existing `version` fields stay at their current values.
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
- Effect diagnostics fail validation only at `error` severity, so enforced guards are errors in `tsconfig.effect.json`. Effect diagnostics require namespace imports from Effect subpaths (`Arr`, `Fn`, `Num`, `Rec`, and `Str` for `effect/Array`, `effect/Function`, `effect/Number`, `effect/Record`, and `effect/String`) and `Class.make(...)` over `new` for Schema classes. Lint enforces subpath Effect imports, the runner-boundary allowlist, `Effect.fn` for named `Effect.gen` wrappers, and `Match`/`Predicate.isTagged` over `_tag` comparisons. Grant exceptions only at genuine boundaries, and prefer exact-file overrides to inline directives.
- The `preferEffectArray`, `preferEffectString`, and `preferEffectRecord` diagnostics require `Arr`/`Str`/`Rec` over native methods; follow the call style, filtering idiom, and `pi-cosmic-core` text-scan helpers (`indexOfFrom`, `lastIndexOfFrom`, `codeUnitAt`) described in [Effect v4 architecture](docs/architecture/effect-v4.md#services-and-boundaries).
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
