# Agent guidance for cosmic-pi

## Repository layout

- `packages/pi-advisor/` contains the automatic advisor and revision extension.
- `packages/pi-better-openai/` contains the Better OpenAI pi extension.
- `packages/pi-better-xai/` contains the Better xAI subscription usage extension.
- `packages/pi-code-previews/` contains the code-preview pi extension.
- `packages/pi-cosmic-core/` contains shared Effect-first runtime foundations for the extension packages.
- `packages/pi-cosmic-ui/` contains composable shared UI elements, including the responsive footer.
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
   - Small packages: a single `application.ts`.
   - Larger packages: an `application/` folder with explicit roles (`register.ts`, `lifecycle.ts`, `state.ts`).
3. **Config:** `config/schema.ts` (shape/defaults), optional `config/resolve.ts` or `config/options.ts`, and `config/store.ts` or `config/service.ts` for persistence. Use **store/service** only — never `repository` for config persistence. Public barrel: `config/index.ts` when needed.
4. **Settings UI/commands:** live under `settings/` with `controller.ts` for command registration (not under `ui/`). Pure presentation stays in `ui/` (projection, renderer, layout) or a documented feature-local presentation folder.
5. **Boundaries:** package-local `boundary/` adapters for I/O and third-party APIs only. No pure classifiers or helpers. Pi host adapters use the `host-*` prefix (`host-context`, `host-ui`, `host-callback`).
6. **Extension `src/` root allowlist:** `extension.ts`, `layer.ts`, `application.ts`, and an optional package `protocol.ts` re-export. Nest everything else (`auth/`, features, etc.).
7. **Provider feature modules:** nest multi-file features (`usage/`, `footer/`, `image/`, `auth/`) rather than scattering `*-controller.ts` at `src/` root.
8. **Tests:** package-root `tests/` (not colocated under `src/`). File suffix is always `*.test.ts` (never `*.spec.ts`). Flat or mirrored layout is fine.
9. **Docs:** every package keeps `ARCHITECTURE.md` with a source map. Package-level `AGENTS.md` is optional and must not contradict this file.

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
  projection.ts
  security.ts
  subscription-format.ts
```

### PR layout checklist

- [ ] New files match the canonical tree for the package size
- [ ] No new extension `src/*.ts` outside the root allowlist
- [ ] Config persistence named store/service (not repository)
- [ ] New `boundary/` files are real I/O or third-party adapters
- [ ] Tests are `tests/**/*.test.ts`
- [ ] `ARCHITECTURE.md` source map updated when layout changed

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
