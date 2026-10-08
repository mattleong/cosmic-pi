# Agent guidance for cosmic-pi

## Repository layout

This is a pnpm workspace. Shared configuration lives at the root; package source and tests live inside each package.

- `packages/pi-ask-user/`: structured user questionnaires.
- `packages/pi-background-task/`: session-scoped background tasks.
- `packages/pi-better-openai/`: Better OpenAI extension.
- `packages/pi-code-previews/`: builtin, native codemode, and native MCP presentation plus the cooperative tool-rendering shell.
- `packages/pi-cosmic-core/`: shared Effect runtime and platform code.
- `packages/pi-cosmic-ui/`: shared UI components and responsive footer.
- `packages/pi-directory-models/`: per-directory model and thinking-level preferences.
- `packages/pi-herdr-btw/`: reusable Herdr BTW side sessions.
- `packages/pi-subagents/`: session-scoped background subagents.

Pi/Jiti loads packages directly from TypeScript source. Do not add generated `dist/` runtime dependencies or package build prerequisites. Native `codemode` and MCP execution belong to Pi; the retired `pi-code-mode`, `pi-mcp`, and standalone `pi-mcp-previews` packages have no compatibility layer. Code Previews requires Pi 1.0.1 or later and is tested with 1.0.2. Previously installed standalone MCP Previews must be removed manually; never edit user configuration automatically.

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
- Shared Effect platform code belongs in `pi-cosmic-core`; do not invent parallel runtime helpers in feature packages. Group core modules by concern. Keep the public `index.ts` and `testing.ts` exports that workspace packages use stable, and remove exports that nothing in the workspace uses.

## Tool rendering

Workspace-owned visible tools use `withCodePreviewShell` and list `pi-code-previews` as a runtime dependency. Follow `docs/architecture/tool-presentation.md` for compact policy, the issue model, content-only expansion, and conservative fallback. Exercise actual registered definitions or renderer-only callbacks with `pi-code-previews/testing`; preserve input, output, recovery, and native images through expansion. Headless tools and non-tool command/settings interfaces do not need the shell.

When trusted project settings apply, call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())` before wrapping and registering tools inside `session_start`. The wrapper captures its shell mode at registration time. Register `registerCodePreviewReplay` at factory time for owned tools registered during `session_start`, using the extension's unique command as its ownership anchor. Wrap through its `shell` after trusted settings load, publish only after successful tool registration, finish pending startup on settlement, and retire on shutdown. Historical replay must never execute tools or borrow another session's settings/scheduler. Wrap only executable tool definitions owned by the extension, never another extension's definitions. Explicit third-party presentation adapters use public renderer-only callbacks after exact package/source admission; keep them siloed from builtin/native admission. Report every error and warning as a `CompactIssue`: a short human-facing `message`, shown collapsed and expanded, plus optional expanded-only `detail` for agent-directed recovery and diagnostics. Messages follow the style rules in the presentation standard and never contain agent procedures or internal IDs; an unclassified failure may use `failureMessage`, and other text `firstLineMessage`. Check producer messages with `issueMessageStyleProblems` from `pi-code-previews/testing`. Keep full agent-facing evidence and expanded details unchanged. To review wording and layout, run `pnpm presentation:gallery`, which renders each package's env-gated `tests/presentation-gallery.test.ts` scenarios into the gitignored `presentation-gallery.txt`; add a scenario there when you add a visible state.

Code Previews registers one stable `pi.registerToolRenderer` resolver during factory loading for builtin/native and explicitly supported third-party presentation. Read only public renderer fields from `next()`, never an execution definition. Exact public builtin source metadata controls admission; unknown historical MCP names require the independent native manager. Do not compose or intercept native codemode/MCP factories, replace `/mcp`, change tool selection/exposure, or register execution definitions just for presentation. The sole exception is write's actual before-write snapshot hook, which preserves Pi's mutation queue and activation. Extension-owned user/task/subagent/image tools keep their normal executable registrations and use `withCodePreviewShell`; renderer-only integrations use `withCodePreviewRenderers`.

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

Run both after architecture changes. TypeScript, Oxlint, the Effect language service, and tests enforce the architecture rules.

Do not commit `node_modules/`, generated `dist/` output, local `.pi/` state, credentials, or generated images.

## Release safety

All workspace packages use a single synchronized version. Run `pnpm version:check` after version changes. Do not publish packages, create tags, or push release commits unless the maintainer explicitly requests it.
