# Agent guidance for cosmic-pi

## Repository layout

This is a pnpm workspace. Shared configuration lives at the root; package source and tests live inside each package.

- `packages/pi-advisor/`: automatic advisor and revision extension.
- `packages/pi-ask-user/`: structured user questionnaires.
- `packages/pi-background-task/`: session-scoped background tasks.
- `packages/pi-better-openai/`: Better OpenAI extension.
- `packages/pi-better-xai/`: Better xAI subscription usage.
- `packages/pi-code-mode/`: confined interpreted programs over Pi built-ins and explicit Background Tasks and MCP adapters.
- `packages/pi-code-previews/`: code previews and the cooperative tool-rendering shell.
- `packages/pi-cosmic-core/`: shared Effect runtime and platform code.
- `packages/pi-cosmic-ui/`: shared UI components and responsive footer.
- `packages/pi-directory-models/`: per-directory model and thinking-level preferences.
- `packages/pi-herdr-btw/`: reusable Herdr BTW side sessions.
- `packages/pi-mcp/`: one MCP gateway, trusted session connections, user-only OAuth, retained results, and a fixed Code Mode capability.
- `packages/pi-subagents/`: session-scoped background subagents.

Pi/Jiti loads packages directly from TypeScript source. Do not add generated `dist/` runtime dependencies or package build prerequisites. The private Code Mode runtime ships inside `packages/pi-code-mode/runtime/` and loads only through `src/boundary/codemode-runtime.ts`. Preserve its vendored-code rules in `runtime/PROVENANCE.md`.

## Package layout

Use this layout proportionally to the package's size. Read its `ARCHITECTURE.md` for current ownership and lifecycle details.

```text
src/
  extension.ts          # required Pi registration entrypoint
  layer.ts              # only when Effect composition is needed
  application.ts        # small-package orchestration
  application/          # replaces application.ts in larger packages
    register.ts         # non-trivial command/event registration
    lifecycle.ts        # start, replace, shutdown
    state.ts            # application state
  config/
    schema.ts           # shape, defaults, enums, codecs
    options.ts          # optional normalization and resolution
    store.ts            # single persistence entrypoint
  settings/
    controller.ts       # settings commands and pickers
    ui/                 # optional settings presentation
  boundary/             # I/O and third-party adapters
    host-*.ts           # dedicated Pi host adapters
  <feature>/            # feature services, policy, and helpers
  ui/                   # pure rendering and projection
  compat/               # temporary legacy call shapes, when needed
tests/**/*.test.ts
ARCHITECTURE.md
```

- Only `extension.ts`, `layer.ts`, `application.ts`, and an optional `protocol.ts` re-export belong at an extension's `src/` root. Nest other modules by feature.
- Use `controller.ts` for a real command or service API, not a re-export hub. Registration-only packages may omit application and Layer modules.
- Config has one public persistence entrypoint, `config/store.ts`, including any Promise compatibility helpers. Do not add a peer `persistence.ts` or a separate service API for the same job. Name persistence modules store/service, never repository. Existing `resolve.ts` names may remain until renamed.
- Keep Effect resources and authoritative state in feature services. Top-level `ui/` is pure. Feature-local rendering is allowed; document it in `ARCHITECTURE.md`.
- Boundaries contain I/O or third-party adapters, not pure helpers. Dedicated Pi adapters use the `host-*` prefix. Leave direct stateless host calls at their call site rather than wrapping them solely for placement.
- Prefer one public entrypoint per role and small implementation files. Split before roughly 400 to 500 lines of hard logic; do not merge files merely to reduce file count.
- Put tests under package-root `tests/`, never under `src/`, and use `*.test.ts`, never `*.spec.ts`. Large packages should mirror source structure; small packages may use flat test names.
- Keep each package's `ARCHITECTURE.md` concise and focused on ownership, boundaries, and lifecycle, not a full file tree. Update it when those change. Package-level `AGENTS.md` files must not conflict with this file.
- Shared Effect platform code belongs in `pi-cosmic-core`; do not invent parallel runtime helpers in feature packages. Group core modules by concern and keep its public `index.ts` and `testing.ts` exports stable.

## Tool rendering

Tools with previewable code, file, diff, or command output use `withCodePreviewShell` and list `pi-code-previews` as a runtime dependency. Other tools need neither.

When trusted project settings apply, call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())` before wrapping and registering tools inside `session_start`. The wrapper captures its shell mode at registration time. Wrap only tools owned by the extension, never another extension's tools.

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

- The workspace uses exact Effect v4 prerelease versions pinned in `pnpm-workspace.yaml`.
- Read `docs/architecture/` before changing application architecture.
- Treat pinned Effect declarations as authoritative over older docs. Reassess this policy when the pin changes or Effect v4 becomes stable.
- New or migrated packages must extend `tsconfig.effect.json`; all packages must inherit the Effect language-service plugin.
- Keep Effect runners at named Pi host boundaries, scope every resource and background fiber, use Effect Schema at unknown boundaries, and model expected failures with typed tagged errors.
- Do not import Zod, define schemas with it, or declare it as a direct workspace dependency. Third-party packages may use Zod internally through transitive dependencies. TypeBox or literal JSON Schema is allowed only where Pi requires tool parameter schemas.

## Verification

Install dependencies from the repository root with `pnpm install`. Run the narrowest relevant package checks first, then the full validation gate:

```bash
pnpm --filter <package-name> test
pnpm validate
```

Run both after architecture changes. TypeScript, Oxlint, the Effect language service, and tests enforce the architecture rules.

Do not commit `node_modules/`, generated `dist/` output, local `.pi/` state, credentials, or generated images.

## Release safety

All workspace packages use a single synchronized version. Run `pnpm version:check` after version changes. Do not publish packages, create tags, or push release commits unless the maintainer explicitly requests it.
