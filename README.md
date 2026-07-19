# cosmic-pi

A pnpm workspace for pi extensions.

## Packages

- [`pi-advisor`](packages/pi-advisor) — automatic review by a dedicated model with one fail-open revision pass.
- [`pi-better-openai`](packages/pi-better-openai) — fast mode, usage visibility, reusable OpenAI UI primitives, footer polish, and OpenAI image generation.
- [`pi-better-xai`](packages/pi-better-xai) — xAI/Grok subscription usage visibility and Cosmic UI footer polish.
- [`pi-code-previews`](packages/pi-code-previews) — syntax-highlighted previews for pi's built-in tool calls.
- [`pi-cosmic-core`](packages/pi-cosmic-core) — shared Effect-first runtime foundations for the extension packages.
- [`pi-cosmic-ui`](packages/pi-cosmic-ui) — composable, responsive shared UI elements, beginning with the footer and information area.

## Requirements

- Node.js 22.22.2+, 24.15.0+, or 26+
- pnpm 10.33.0 (declared in `packageManager`)

## Install

Install the published extensions with pi:

```bash
pi install npm:pi-better-openai
pi install npm:pi-better-xai
pi install npm:pi-code-previews
pi install npm:pi-cosmic-ui
```

pi-advisor is local-only. Clone this repository, install the workspace dependencies, and register its local path for persistent use:

```bash
git clone https://github.com/mattleong/cosmic-pi.git
cd cosmic-pi
pnpm install
pi install "$PWD/packages/pi-advisor"
```

## Development

```bash
pnpm install
pnpm effect:lsp:verify
pnpm validate
```

The workspace uses the Effect language service and an architecture migration ratchet. Editors must use the workspace TypeScript installation. See [`docs/architecture/effect-v4.md`](docs/architecture/effect-v4.md) for the Effect v4 conventions.

Run a command for one package with a filter:

```bash
pnpm --filter pi-advisor test
pnpm --filter pi-better-openai test
pnpm --filter pi-code-previews build
pnpm --filter pi-cosmic-ui test
```

## Try the local packages with pi

```bash
pi -e ./packages/pi-advisor
pi -e ./packages/pi-better-openai
pi -e ./packages/pi-code-previews
pi -e ./packages/pi-cosmic-ui
```

To add a package to project-local pi settings, use `pi install -l` with its local path instead.

## Releases

All workspace packages use the same version. The public packages are published together; private pi-advisor remains local-only. Set the next version from the repository root:

```bash
pnpm version:set 0.2.1
pnpm validate
```

Commit the synchronized version changes, create a matching tag such as `v0.2.1`, and publish a GitHub Release from that tag. [The release workflow](.github/workflows/release.yml) validates the repository, skips private packages, and publishes each public package that does not already have that version on npm.

Before the first release, configure npm trusted publishing for every public package with repository `mattleong/cosmic-pi` and workflow `release.yml`. See [releasing.md](releasing.md) for the complete release procedure, verification steps, and failure recovery.
