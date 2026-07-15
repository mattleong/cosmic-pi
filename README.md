# cosmic-pi

A pnpm workspace for pi extensions.

## Packages

- [`pi-better-openai`](packages/pi-better-openai) — fast mode, usage visibility, footer polish, custom Codex pets, and OpenAI image generation.
- [`pi-code-previews`](packages/pi-code-previews) — syntax-highlighted previews for pi's built-in tool calls.

## Requirements

- Node.js 22.19.0 or newer
- pnpm 10.33.0 (declared in `packageManager`)

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
