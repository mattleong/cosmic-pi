# cosmic-pi

A pnpm workspace for pi extensions.

## Packages

- [`pi-better-openai`](packages/pi-better-openai) — fast mode, usage visibility, footer polish, custom Codex pets, and OpenAI image generation.
- [`pi-code-previews`](packages/pi-code-previews) — syntax-highlighted previews for pi's built-in tool calls.

## Requirements

- Node.js 22.19.0 or newer
- pnpm 10.33.0 (declared in `packageManager`)

## Install

Install either published extension with pi:

```bash
pi install npm:pi-better-openai
pi install npm:pi-code-previews
```

## Development

```bash
pnpm install
pnpm validate
```

Run a command for one package with a filter:

```bash
pnpm --filter pi-better-openai test
pnpm --filter pi-code-previews build
```

## Try the local packages with pi

```bash
pi -e ./packages/pi-better-openai
pi -e ./packages/pi-code-previews
```

To add either package to project-local pi settings, use `pi install -l` with its local path instead.

## Releases

All packages use the same version and are published together. Set the next version from the repository root:

```bash
pnpm version:set 0.2.1
pnpm validate
```

Commit the synchronized version changes, create a matching tag such as `v0.2.1`, and publish a GitHub Release from that tag. [The release workflow](.github/workflows/release.yml) validates the repository and publishes every package that does not already have that version on npm.

Before the first release, configure npm trusted publishing for both packages with repository `mattleong/cosmic-pi` and workflow `release.yml`. See [releasing.md](releasing.md) for the complete release procedure, verification steps, and failure recovery.
