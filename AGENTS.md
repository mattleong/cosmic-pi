# Agent guidance for cosmic-pi

## Repository layout

- `packages/pi-advisor/` contains the automatic advisor and revision extension.
- `packages/pi-better-openai/` contains the Better OpenAI pi extension.
- `packages/pi-better-xai/` contains the Better xAI subscription usage extension.
- `packages/pi-background-terminals/` contains the session-scoped background process extension.
- `packages/pi-code-previews/` contains the code-preview pi extension.
- `packages/pi-cosmic-core/` contains shared Effect-first runtime foundations for the extension packages.
- `packages/pi-cosmic-ui/` contains composable shared UI elements, including the responsive footer.
- `packages/pi-subagents/` contains the session-scoped foreground/background subagent extension.
- The repository is a pnpm workspace. Keep shared workspace configuration at the root and package-specific source, tests, and build configuration inside each package.

## Package layout conventions

Keep these names aligned across extension packages so the same role is discoverable everywhere.

### Canonical small extension

```text
src/
  extension.ts          # Pi registration only
  layer.ts              # Effect composition root
  application.ts        # session coord + command/event wiring
  config/
    schema.ts           # shape + defaults
    options.ts          # optional resolve/normalize
    store.ts            # persistence service
    index.ts            # optional barrel
  settings/
    controller.ts       # commands / pickers only
  boundary/             # foreign APIs only (Pi, Node, Sharp, …)
    host-*.ts
  <feature>/            # usage | footer | image | auth | …
    controller.ts       # optional host-facing commands
    service.ts          # Effect resource
    format.ts           # pure helpers
  ui/                   # pure presentation / primitives only
tests/**/*.test.ts
ARCHITECTURE.md
```

### Canonical large extension

```text
src/
  extension.ts
  layer.ts
  application/
    register.ts         # Pi commands/events (when registration is non-trivial)
    lifecycle.ts        # start/replace/shutdown
    state.ts            # app/domain state
    # controller.ts only if there is a real controller surface
  config/               # same roles as small packages
  settings/
    controller.ts
  boundary/
  <feature>/…
  ui/                   # or feature-local presentation; document which in ARCHITECTURE.md
tests/                  # flat or mirrored src/; suffix always .test.ts
ARCHITECTURE.md
```

### Hard rules

1. **Entry / composition:** `extension.ts` (Pi registration) and `layer.ts` (Effect composition root).
2. **Application orchestration:**
   - Small packages: a single `application.ts` (split early if it gets heavy).
   - Larger packages: an `application/` folder with explicit roles (`register.ts`, `lifecycle.ts`, `state.ts`).
   - `controller.ts` only when there is a real Context/service API — not a re-export hub.
3. **Config doors:** one public persistence entry — prefer `config/store.ts`.
   - `schema.ts` = shape + defaults (+ enums/codecs).
   - `options.ts` = normalize/resolve/descriptors (legacy name `resolve.ts` is allowed until renamed).
   - `store.ts` = the persistence **door** (Effect service and any promise/compat helpers).
   - Extra config files are internal **rooms** (document IO, env, state). Do not add a second peer API (`persistence.ts`, façade `store` + separate `service`) for the same job.
   - Use **store/service** naming only — never `repository` for config persistence.
4. **Settings UI/commands:** live under `settings/` with `controller.ts` for command registration (not under `ui/`).
5. **UI policy:**
   - Top-level `ui/` = pure projection/render/primitives only (no Effect resources/services).
   - Settings chrome under `settings/ui/` when needed.
   - Feature-local presentation (`preview/`, `tools/renderers/`, footer components) is fine; document it in `ARCHITECTURE.md`.
   - Effect status/resources stay in feature modules, not under `ui/`.
6. **Boundaries:** package-local `boundary/` adapters for I/O and third-party APIs only. No pure classifiers or helpers.
   - **All** Pi host adapters live under `boundary/` with the `host-*` prefix (`host-context`, `host-ui`, `host-callback`, `host-bindings`, `host-notifier`, `host-commands`). Never under `application/`.
7. **Doors vs rooms:** prefer one public entrypoint per role; keep implementation in small files. Collapse duplicate APIs, not file count. Nest peer-soup directories instead of merging into giant files. Soft guide: split before ~400–500 LOC of hard logic accumulates in one file.
8. **Extension `src/` root allowlist:** `extension.ts`, `layer.ts`, `application.ts`, and an optional package `protocol.ts` re-export. Nest everything else (`auth/`, features, etc.).
9. **Provider feature modules:** nest multi-file features (`usage/`, `footer/`, `image/`, `auth/`) rather than scattering `*-controller.ts` at `src/` root.
10. **Tests:** package-root `tests/` (not colocated under `src/`). File suffix is always `*.test.ts` (never `*.spec.ts`). Large packages should mirror `src/`; smaller packages may use flat names without package-name prefixes.
11. **Docs:** every package keeps `ARCHITECTURE.md` with a source map. Package-level `AGENTS.md` is optional and must not contradict this file.
12. **Compat:** temporary legacy call shapes go under an explicit `compat/` file or folder, not a second architectural door.
13. **Tool rendering:** every new extension-owned agent tool must render through `pi-code-previews` using `withCodePreviewShell`.

- List `pi-code-previews` as a runtime dependency.
- When trusted project settings apply, call `loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted())` before wrapping and registering tools inside `session_start`; the wrapper captures its shell mode at registration time.
- Wrap only tools owned by the extension, never tools registered by another extension.

Shared Effect platform code belongs in `pi-cosmic-core`; do not invent parallel runtime helpers in feature packages.

### Library package (`pi-cosmic-core`)

Group by concern; keep the public barrel (`index.ts` / `testing.ts`) stable:

```text
src/
  runtime/              # managed runtime, session slot, Pi API service
  coordination/         # refresh, subscription refresh, synchronous ingress
  platform/             # Node, HTTP, documents, files, process coordination
  config/               # scoped store, tolerant fields
  testing/              # shared test layers/probes
  host-session.ts        # pure Pi host session capture helpers
  projection.ts
  security.ts
  subscription-format.ts
  usage-projection.ts    # shared usage eligibility transitions
```

### PR layout checklist

- [ ] New files match the canonical tree for the package size
- [ ] No new extension `src/*.ts` outside the root allowlist
- [ ] Config has one persistence door (`store`); no peer `persistence`/façade APIs
- [ ] Config persistence named store/service (not repository)
- [ ] New `boundary/` files are real I/O or third-party adapters
- [ ] All `host-*` adapters live under `boundary/`
- [ ] `ui/` stays pure; Effect services stay in features
- [ ] No new re-export hub files; no giant-file merges to “simplify”
- [ ] Tests are `tests/**/*.test.ts`
- [ ] `ARCHITECTURE.md` source map updated when layout changed
- [ ] Every new extension-owned agent tool uses the `pi-code-previews` cooperative shell

## Effect architecture

- The workspace is being rearchitected around the exact Effect v4 beta versions in `pnpm-workspace.yaml`.
- Read `docs/adr/0001-effect-v4-beta.md` and `docs/architecture/` before changing application architecture.
- Treat the pinned Effect declarations as authoritative when older documentation differs.
- New or migrated packages must extend `tsconfig.effect.json`; all packages must inherit the Effect language-service plugin.
- Keep Effect runners at named Pi host boundaries, scope every resource and background fiber, use Effect Schema at unknown boundaries, and model expected failures with typed tagged errors.
- Do not add Zod. TypeBox or literal JSON Schema is allowed only where Pi requires tool parameter schemas.
- Run the relevant package checks and `pnpm validate` after architecture changes; rely on TypeScript, Oxlint, the Effect language service, and tests for enforcement.

## Verification

Install dependencies from the repository root:

```bash
pnpm install
```

Run the narrowest relevant package command first, then the full validation gate:

```bash
pnpm --filter <package-name> test
pnpm validate
```

Do not commit `node_modules/`, generated `dist/` output, local `.pi/` state, credentials, or generated images.

## Release safety

All workspace packages use a single synchronized version. Run `pnpm version:check` after version changes. Do not publish packages, create tags, or push release commits unless the maintainer explicitly requests it.
