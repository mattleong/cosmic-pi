# pi-better-openai

Improves Pi's OpenAI subscription workflow with fast mode, usage visibility, native context compaction, and image generation through your `openai-codex` login.

## Features

- **Fast mode** for every `openai` and `openai-codex` model, using OpenAI's `priority` service tier.
- **Subscription usage** in the footer and on demand with `/openai usage`.
- **Native compaction** (opt-in) for OpenAI Responses models through OpenAI's compact endpoint, falling back to Pi's compaction on failure.
- **Image generation and editing** with the `openai_image` tool and `/openai image`.
- **Footer integration** with `pi-cosmic-ui`, or Pi's status line without it.

## Install

Not published to npm; install from a [local clone](../../README.md#install). After `pnpm install`, run from the repository root:

```bash
pi install "$PWD/packages/pi-better-openai"
pi install "$PWD/packages/pi-cosmic-ui"   # optional: shared footer
```

Then sign in with `/login openai-codex` and check it works with `/openai usage`. Credentials stay in Pi's auth store (normally `~/.pi/agent/auth.json`); never copy or commit them.

## Usage

All commands live under `/openai`. Type `/openai ` to autocomplete them.

| Command                  | Action                                       |
| ------------------------ | -------------------------------------------- |
| `/openai usage`          | Show current subscription usage              |
| `/openai fast`           | Toggle fast mode                             |
| `/openai image <prompt>` | Generate an image                            |
| `/openai settings`       | Open settings; `help` and `status` also work |

Agents call `openai_image` with a `prompt` and optional parameters:

- `action`: `auto`, `generate`, or `edit`.
- `images`: up to five project-local PNG, JPEG, WebP, or GIF files to edit or reference.
- `imageModel`: `gpt-image-2.5-sunburst` (default) or the faster `gpt-image-2.5-flare`.
- `model`: the Codex model that drives the request, not the image model.
- `outputFormat`: `png`, `jpeg`, or `webp`.
- `save`: `project` (`.pi/generated-images/`), `global` (the agent directory), `custom` (with `saveDir` or `PI_IMAGE_SAVE_DIR`), or `none`.

## Configuration

Settings live in `~/.pi/agent/extensions/pi-better-openai.json`; a project's `.pi/extensions/pi-better-openai.json` overrides them field by field. `PI_CODING_AGENT_DIR` replaces `~/.pi/agent` for the auth store, global config, and global images.

```json
{
  "persistState": true,
  "desiredActive": false,
  "compaction": { "enabled": false },
  "usage": {
    "refreshIntervalMs": 60000,
    "showOnlyOnSubscriptionModels": true,
    "showResetTimes": true
  },
  "image": {
    "enabled": true,
    "defaultModel": "gpt-5.5",
    "defaultSave": "project",
    "outputFormat": "png",
    "timeoutMs": 180000
  }
}
```

Footer visibility is set in `/cosmic-ui settings`. Hiding usage stops automatic requests; `/openai usage` still works. Hiding the fast indicator doesn't turn off fast mode.

## How it works

Each Pi session owns one scoped Effect runtime that runs usage polling and image streams and stops them on replacement or shutdown. Credentials come from Pi's model registry, which refreshes them. Fast mode assumes every `openai` and `openai-codex` model supports the `priority` tier and, for Codex subscription requests, also sends Codex's priority routing hint. Pi still decides when to compact; this extension replaces only how compaction runs for eligible models. Usage and fast-mode state reach the footer as plain data over the Cosmic UI protocol, so the extension never replaces the footer itself.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
