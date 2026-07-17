# Agent guidance for cosmic-pi

## Repository layout

- `packages/pi-advisor/` contains the automatic advisor and revision extension.
- `packages/pi-better-openai/` contains the Better OpenAI pi extension.
- `packages/pi-code-previews/` contains the code-preview pi extension.
- `packages/pi-cosmic-ui/` contains composable shared UI elements, including the responsive footer.
- The repository is a pnpm workspace. Keep shared workspace configuration at the root and package-specific source, tests, and build configuration inside each package.

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
