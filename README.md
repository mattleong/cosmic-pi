# cosmic-pi

A pnpm workspace for Pi extensions.

## Packages

- [`pi-ask-user`](packages/pi-ask-user) — structured, responsive questionnaires for decisions the agent should not guess.
- [`pi-better-openai`](packages/pi-better-openai) — fast mode, usage visibility, reusable OpenAI UI primitives, footer polish, and OpenAI image generation.
- [`pi-better-xai`](packages/pi-better-xai) — xAI/Grok subscription usage visibility and Cosmic UI footer polish.
- [`pi-background-task`](packages/pi-background-task) — session-scoped background tasks with an agent tool and full-screen `/tasks` manager.
- [`pi-code-previews`](packages/pi-code-previews) — syntax-highlighted builtin previews, native codemode/MCP presentation, and a reusable tool shell.
- [`pi-cosmic-core`](packages/pi-cosmic-core) — shared Effect-first runtime foundations for the extension packages.
- [`pi-directory-models`](packages/pi-directory-models) — per-directory model and thinking-level preferences for fresh Pi sessions.
- [`pi-herdr-btw`](packages/pi-herdr-btw) — deterministic reusable blank Pi side sessions in user-owned panes in the current Herdr tab.
- [`pi-cosmic-ui`](packages/pi-cosmic-ui) — composable, responsive shared UI elements: the footer and information area, and the Activity view for workflows, subagents, and tasks.
- [`pi-subagents`](packages/pi-subagents) — session-scoped background subagents with supervisor communication, dynamic JavaScript workflows, and a `/subagents` fleet UI.

## Requirements

- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`
- pnpm 10.33.0 (declared in `packageManager`)
- Pi 1.0.1 or later for Code Previews; tested with Pi 1.0.2

## Install

These extensions aren't published to npm, so install them from a local clone. Clone the repository, install its dependencies, and register each extension you want by its local path:

```bash
git clone https://github.com/mattleong/cosmic-pi.git
cd cosmic-pi
pnpm install
pi install "$PWD/packages/pi-ask-user"
pi install "$PWD/packages/pi-background-task"
pi install "$PWD/packages/pi-better-openai"
pi install "$PWD/packages/pi-better-xai"
pi install "$PWD/packages/pi-code-previews"
pi install "$PWD/packages/pi-cosmic-ui"
pi install "$PWD/packages/pi-directory-models"
pi install "$PWD/packages/pi-herdr-btw"
pi install "$PWD/packages/pi-subagents"
```

Or run `scripts/install-all.sh` to install dependencies and register every extension at once. Add `-l` to `pi install` to register an extension for the current project only.

Pi loads local packages in place, so updating is `git pull`, then `pnpm install` if dependencies changed, then `/reload`. Pi's `git:` sources don't work for this repository: each extension is a workspace package that depends on its siblings through pnpm workspace links.

Packages with the same names on npm, such as `pi-ask-user`, `pi-subagents`, and `pi-background-task`, are unrelated projects.

Upgrading from the retired `pi-mcp`, `pi-code-mode`, or standalone `pi-mcp-previews` extensions? Follow the [manual migration guide](docs/migrations/native-mcp-codemode.md). There is intentionally no compatibility layer or automatic credential migration.

## Development

```bash
pnpm install
pnpm validate
```

The workspace uses TypeScript-Go for typechecking, Oxlint, and `@effect/tsgo` for dedicated Effect diagnostics. Regular `pnpm lint` runs the vendored [`anti-slop`](tools/oxlint/anti-slop/UPSTREAM.md) rules across the workspace. Pi's Jiti loader consumes every Cosmic Pi package directly from TypeScript source, so local development and published packages require no build step or generated `dist/`. The checked-in VS Code settings select the workspace TypeScript 7 native server; run `pnpm effect:diagnostics` for Effect diagnostics. See [`docs/architecture/effect-v4.md`](docs/architecture/effect-v4.md) for the Effect v4 conventions.

Run a command for one package with a filter:

```bash
pnpm --filter pi-ask-user test
pnpm --filter pi-better-openai test
pnpm --filter pi-code-previews test
pnpm --filter pi-cosmic-ui test
pnpm --filter pi-directory-models test
pnpm --filter pi-herdr-btw test
pnpm --filter pi-subagents test
```

`pnpm pack:smoke` checks packed TypeScript source and dependency resolution in a clean consumer, including Code Previews beside independently builtin-owned native MCP/codemode, real local MCP tool/resource execution, unchanged images, and confirmed fixture cleanup with isolated agent state and no provider authentication.

## Try the local packages with pi

```bash
pi -e ./packages/pi-ask-user
pi -e ./packages/pi-background-task
pi -e ./packages/pi-better-openai
pi -e ./packages/pi-better-xai
pi -e ./packages/pi-code-previews
pi -e ./packages/pi-cosmic-ui
pi -e ./packages/pi-directory-models
pi -e ./packages/pi-herdr-btw
pi -e ./packages/pi-subagents
```

To add a package to project-local Pi settings, use `pi install -l` with its local path instead.

## Releases

All workspace packages use the synchronized version `0.2.0`. Nothing is published yet; once releases start, the public packages publish together and private `pi-herdr-btw` stays local-only. Set the next version from the repository root:

```bash
pnpm version:set 0.2.1
pnpm validate
```

Commit the synchronized version changes, create a matching tag such as `v0.2.1`, and publish a GitHub Release from that tag. [The release workflow](.github/workflows/release.yml) validates the repository, skips private packages, and publishes each public package that does not already have that version on npm.

Before the first release, configure npm trusted publishing for every public package with repository `mattleong/cosmic-pi` and workflow `release.yml`. See [releasing.md](releasing.md) for the complete release procedure, verification steps, and failure recovery.
