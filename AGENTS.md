# Agent guidance for cosmic-pi

## Repository layout

- `packages/pi-advisor/` contains the automatic advisor and revision extension.
- `packages/pi-better-openai/` contains the Better OpenAI pi extension.
- `packages/pi-better-xai/` contains the Better xAI subscription usage extension.
- `packages/pi-code-previews/` contains the code-preview pi extension.
- `packages/pi-cosmic-ui/` contains composable shared UI elements, including the responsive footer.
- The repository is a pnpm workspace. Keep shared workspace configuration at the root and package-specific source, tests, and build configuration inside each package.

## Effect architecture

- The workspace is being rearchitected around the exact Effect v4 beta versions in `pnpm-workspace.yaml`.
- Read `docs/adr/0001-effect-v4-beta.md` and `docs/architecture/` before changing application architecture.
- Treat the pinned Effect declarations as authoritative when older documentation differs.
- New or migrated packages must extend `tsconfig.effect.json`; all packages must inherit the Effect language-service plugin.
- Keep Effect runners at named Pi host boundaries, scope every resource and background fiber, use Effect Schema at unknown boundaries, and model expected failures with typed tagged errors.
- Do not add Zod. TypeBox or literal JSON Schema is allowed only where Pi requires tool parameter schemas.
- Run `pnpm effect:lsp:verify` and `pnpm architecture:check` as part of architecture changes.

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
