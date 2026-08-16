# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, and image generation through `openai-codex` auth.

## Install

Requires Node.js 22.22.2+, 24.15.0+, or 26+.

```bash
pi install npm:pi-better-openai
```

Install `pi-cosmic-ui` as well to compose Better OpenAI's fast-mode and usage primitives into the shared responsive footer. Without Cosmic UI, Better OpenAI retains its standalone footer behavior.

```bash
pi install npm:pi-cosmic-ui
```

The source is maintained in the [cosmic-pi monorepo](https://github.com/mattleong/cosmic-pi/tree/main/packages/pi-better-openai).

## Authentication

Usage display and image generation require pi's `openai-codex` OAuth credentials.

1. In pi, run `/login openai-codex`.
2. Verify subscription usage with `/openai-usage`, or run `/openai-settings diagnostics`.
3. The extension reads auth from pi's agent auth store, normally `~/.pi/agent/auth.json`. Do not copy, paste, or commit values from this file.
4. If `PI_CODING_AGENT_DIR` is set, the auth store, global extension config, and global generated-image directory use that agent directory instead of `~/.pi/agent`. A leading `~/` is expanded to your home directory.

## Features

- Fast mode for supported OpenAI models, toggled with `/fast` or in `/openai-settings`.
- Optional OpenAI-native context compaction for `openai-responses` models. Pi still decides when to compact; Better OpenAI replaces threshold and manual compaction with `POST /responses/compact`. Provider failures and overflow recovery fall back to Pi compaction.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive TUI settings picker via `/openai-settings`, plus scriptable updates via `/openai-settings <id> <value>`; run `/openai-settings help` for available keys.
- Standalone footer customization for model, thinking, fast mode, usage, and token/cost context.
- Automatic contribution of fast-mode and usage footer primitives when `pi-cosmic-ui` is installed.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Commands:
  - `/fast` toggles fast mode.
  - `/openai-image <prompt>` generates an image directly.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-settings` opens the interactive picker; `/openai-settings help` lists settings and `/openai-settings diagnostics` shows diagnostics.

## UI primitives

Better OpenAI publishes data-oriented fast-mode and usage primitives over the versioned Cosmic UI event protocol when a host is present. Better OpenAI depends on `pi-cosmic-ui` only for that narrow plain-data protocol client; provider behavior stays correct when no Cosmic UI host answers discovery.

When Cosmic UI is active, it owns footer layout, visibility, and density. Better OpenAI's `footer.mode` continues to control only the standalone fallback. The `usage.enabled` setting remains effective in both modes.

## Configuration

The extension reads JSON config from two locations:

- Project config: `.pi/extensions/pi-better-openai.json`
- Global config: `$PI_CODING_AGENT_DIR/extensions/pi-better-openai.json`, defaulting to `~/.pi/agent/extensions/pi-better-openai.json`

Project overrides global. Global values fill fields omitted by the project file. Known fields are decoded independently, invalid values fall back without discarding valid siblings, and numeric settings are clamped to safe ranges.

When `compaction.enabled` is true, Pi's normal compaction configuration still controls when compaction runs (`compaction.enabled`, `reserveTokens`, manual `/compact`, and overflow recovery in Pi settings). Better OpenAI only replaces the compaction operation for eligible OpenAI Responses models; OpenAI's canonical output determines the retained native window, so Pi's `keepRecentTokens` does not shape that output. Active fast mode also requests the `priority` service tier for native compaction.

For canonical `openai-codex` subscription requests, active fast mode adds `x-codex-routing-hint: model=<model>;tier=priority` alongside the request body's `service_tier`. Better OpenAI does not add that Codex routing header to direct OpenAI API requests or noncanonical proxy endpoints.

The extension owns one scoped Effect runtime per Pi session. Repeated `session_start` replaces and disposes the previous runtime; usage polling and image streams are interrupted during replacement or `session_shutdown`.

Fast-mode model support is controlled by the package and cannot be overridden in user configuration. The current allow-list is:

```json
[
  "openai/gpt-5.4",
  "openai/gpt-5.5",
  "openai-codex/gpt-5.6-sol",
  "openai-codex/gpt-5.6-terra",
  "openai-codex/gpt-5.6-luna",
  "openai-codex/gpt-5.4",
  "openai-codex/gpt-5.5"
]
```

Example config:

```json
{
  "persistState": true,
  "desiredActive": false,
  "compaction": {
    "enabled": false
  },
  "usage": {
    "enabled": true,
    "refreshIntervalMs": 60000,
    "showOnlyOnSubscriptionModels": true,
    "showResetTimes": true
  },
  "footer": {
    "mode": "status"
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

## Image generation

Use the command for quick generation:

```text
/openai-image draw an otter reading a terminal
```

Agents can call the `openai_image` tool directly. Supported parameters:

- `prompt` (required): pass the user's image wording verbatim.
- `action`: `auto`, `generate`, or `edit`.
- `images`: up to five distinct project-local reference/edit image paths. Paths must stay inside the current workspace and point to readable PNG, JPEG, WebP, or GIF files; each file is limited to 20 MB and the combined input to 50 MB.
- `model`: Codex image model override, for example `openai-codex/gpt-5.5`.
- `outputFormat`: `png`, `jpeg`, or `webp`.
- `save`: `project`, `global`, `custom`, or `none`.
- `saveDir`: required for `save: "custom"` unless `PI_IMAGE_SAVE_DIR` is set.

Save modes:

- `project` writes to `.pi/generated-images/` in the current project.
- `global` writes to the agent `generated-images` directory, normally `~/.pi/agent/generated-images/` or `$PI_CODING_AGENT_DIR/generated-images/`.
- `custom` writes to `saveDir` or `PI_IMAGE_SAVE_DIR`; relative paths are resolved from the current project.
- `none` returns the image without saving it.

The repository ignores `.pi/`, so generated images and local config should not be committed.
