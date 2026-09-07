# cosmic-pi

A pnpm workspace for Pi extensions.

## Packages

- [`pi-advisor`](packages/pi-advisor) — active second-model advice with bounded interventions and local review cards.
- [`pi-ask-user`](packages/pi-ask-user) — structured, responsive questionnaires for decisions the agent should not guess.
- [`pi-better-openai`](packages/pi-better-openai) — fast mode, usage visibility, reusable OpenAI UI primitives, footer polish, and OpenAI image generation.
- [`pi-better-xai`](packages/pi-better-xai) — xAI/Grok subscription usage visibility and Cosmic UI footer polish.
- [`pi-background-task`](packages/pi-background-task) — session-scoped background tasks with an agent tool and full-screen `/tasks` manager.
- [`pi-code-mode`](packages/pi-code-mode) runs confined JavaScript over Pi built-ins and session background tasks.
- [`pi-code-previews`](packages/pi-code-previews) — syntax-highlighted previews for pi's built-in tool calls.
- [`pi-cosmic-core`](packages/pi-cosmic-core) — shared Effect-first runtime foundations for the extension packages.
- [`pi-directory-models`](packages/pi-directory-models) — per-directory model and thinking-level preferences for fresh Pi sessions.
- [`pi-herdr-btw`](packages/pi-herdr-btw) — deterministic reusable blank Pi side sessions in user-owned panes in the current Herdr tab.
- [`pi-cosmic-ui`](packages/pi-cosmic-ui) — composable, responsive shared UI elements, beginning with the footer and information area.
- [`pi-subagents`](packages/pi-subagents) — session-scoped background subagents with supervisor communication and a `/subagents` fleet UI.

## Requirements

- Node.js `^22.22.2 || ^24.15.0 || >=26.0.0`
- pnpm 10.33.0 (declared in `packageManager`)

## Install

Install the published extensions with pi:

```bash
pi install npm:pi-ask-user
pi install npm:pi-better-openai
pi install npm:pi-better-xai
pi install npm:pi-background-task
pi install npm:pi-code-mode
pi install npm:pi-code-previews
pi install npm:pi-cosmic-ui
pi install npm:pi-directory-models
pi install npm:pi-subagents
```

`pi-advisor` and `pi-herdr-btw` are local-only. Clone this repository, install the workspace dependencies, and register their local paths for persistent use:

```bash
git clone https://github.com/mattleong/cosmic-pi.git
cd cosmic-pi
pnpm install
pi install "$PWD/packages/pi-advisor"
pi install "$PWD/packages/pi-herdr-btw"
```

## Development

```bash
pnpm install
pnpm validate
```

The workspace uses TypeScript-Go for typechecking, Oxlint, and `@effect/tsgo` for dedicated Effect diagnostics. Regular `pnpm lint` runs the vendored [`anti-slop`](tools/oxlint/anti-slop/UPSTREAM.md) rules across the workspace. Pi's Jiti loader consumes every Cosmic Pi package directly from TypeScript source, so local development and published packages require no build step or generated `dist/`. The checked-in VS Code settings select the workspace TypeScript 7 native server; run `pnpm effect:diagnostics` for Effect diagnostics. See [`docs/architecture/effect-v4.md`](docs/architecture/effect-v4.md) for the Effect v4 conventions.

Run a command for one package with a filter:

```bash
pnpm --filter pi-advisor test
pnpm --filter pi-ask-user test
pnpm --filter pi-better-openai test
pnpm --filter pi-code-mode test
pnpm --filter pi-code-previews test
pnpm --filter pi-cosmic-ui test
pnpm --filter pi-directory-models test
pnpm --filter pi-herdr-btw test
pnpm --filter pi-subagents test
```

## Try the local packages with pi

```bash
pi -e ./packages/pi-advisor
pi -e ./packages/pi-ask-user
pi -e ./packages/pi-better-openai
pi -e ./packages/pi-code-mode
pi -e ./packages/pi-code-previews
pi -e ./packages/pi-cosmic-ui
pi -e ./packages/pi-directory-models
pi -e ./packages/pi-herdr-btw
pi -e ./packages/pi-subagents
```

To add a package to project-local Pi settings, use `pi install -l` with its local path instead.

## Releases

All workspace packages use the same version. The public packages are published together; private `pi-advisor` and `pi-herdr-btw` remain local-only. Set the next version from the repository root:

```bash
pnpm version:set 0.2.1
pnpm validate
```

Commit the synchronized version changes, create a matching tag such as `v0.2.1`, and publish a GitHub Release from that tag. [The release workflow](.github/workflows/release.yml) validates the repository, skips private packages, and publishes each public package that does not already have that version on npm.

Before the first release, configure npm trusted publishing for every public package with repository `mattleong/cosmic-pi` and workflow `release.yml`. See [releasing.md](releasing.md) for the complete release procedure, verification steps, and failure recovery.
