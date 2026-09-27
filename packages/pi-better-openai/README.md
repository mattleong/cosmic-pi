# pi-better-openai

A pi extension for OpenAI subscription workflows: fast mode, usage visibility, footer polish, and image generation through `openai-codex` auth.

## Install

Requires Node.js 22.22.2+, 24.15.0+, or 26+.

```bash
pi install npm:pi-better-openai
```

Install `pi-cosmic-ui` to compose OpenAI usage and the fast indicator into the shared footer. Configure footer visibility in `/cosmic-ui-settings`. Without an active Cosmic footer, Better OpenAI automatically uses Pi's status line.

```bash
pi install npm:pi-cosmic-ui
```

The source is maintained in the [cosmic-pi monorepo](https://github.com/mattleong/cosmic-pi/tree/main/packages/pi-better-openai).

## Authentication

Usage display and image generation require pi's `openai-codex` OAuth credentials.

1. In pi, run `/login openai-codex`.
2. Verify subscription usage with `/openai-usage`, or run `/openai-settings diagnostics`.
3. The extension reads credentials through pi's model registry, which refreshes and saves them in pi's agent auth store, normally `~/.pi/agent/auth.json`. Do not copy, paste, or commit values from this file.
4. If `PI_CODING_AGENT_DIR` is set, the auth store, global extension config, and global generated-image directory use that agent directory instead of `~/.pi/agent`. A leading `~/` is expanded to your home directory.

## Features

- Fast mode for all `openai` and `openai-codex` models, toggled with `/openai-fast` or in `/openai-settings`.
- Optional OpenAI-native context compaction for `openai-responses` models. Pi still decides when to compact; Better OpenAI replaces threshold and manual compaction with `POST /responses/compact`. Provider failures and overflow recovery fall back to Pi compaction.
- OpenAI subscription usage display via `/openai-usage` and the footer.
- Interactive TUI settings picker via `/openai-settings`, plus scriptable updates via `/openai-settings <id> <value>`; run `/openai-settings help` for available keys.
- Automatic contribution of fast-mode and usage footer primitives when `pi-cosmic-ui` is installed.
- OpenAI image generation/editing through the `openai_image` tool and `/openai-image` command.
- Commands:
  - `/openai-fast` toggles fast mode.
  - `/openai-image <prompt>` generates an image directly.
  - `/openai-usage` shows current OpenAI subscription usage.
  - `/openai-settings` opens the interactive picker, or shows help outside the TUI; `/openai-settings help` lists settings and `/openai-settings diagnostics` shows diagnostics.

## UI primitives

Better OpenAI publishes data-oriented fast-mode and usage primitives over the versioned Cosmic UI event protocol when a host is present. Better OpenAI depends on `pi-cosmic-ui` only for that narrow plain-data protocol client; provider behavior stays correct when no Cosmic UI host answers discovery.

`/cosmic-ui-settings` is the only footer settings panel. OpenAI usage has `automatic` and `hidden` choices; the fast indicator has its own visibility toggle. Hidden usage skips automatic requests, but `/openai-usage` still fetches once on an eligible model. Hiding the fast indicator does not change fast-mode requests.

Cosmic UI owns layout and rendering. Better OpenAI supplies data and never replaces the footer. When Cosmic UI's custom footer is disabled, its visibility preferences still apply to Pi's status-line fallback. Without Cosmic UI, usage is automatic on eligible models. Provider configuration has no footer mode or usage-display switch.

## Configuration

The extension reads JSON config from two locations:

- Project config: `.pi/extensions/pi-better-openai.json`
- Global config: `$PI_CODING_AGENT_DIR/extensions/pi-better-openai.json`, defaulting to `~/.pi/agent/extensions/pi-better-openai.json`

Project overrides global. Global values fill fields omitted by the project file. Known fields are decoded independently, invalid values fall back without discarding valid siblings, and numeric settings are clamped to safe ranges.

When `compaction.enabled` is true, Pi's normal compaction configuration still controls when compaction runs (`compaction.enabled`, `reserveTokens`, manual `/compact`, and overflow recovery in Pi settings). Better OpenAI only replaces the compaction operation for eligible OpenAI Responses models; OpenAI's canonical output determines the retained native window, so Pi's `keepRecentTokens` does not shape that output. Active fast mode also requests the `priority` service tier for native compaction.

For canonical `openai-codex` subscription requests, active fast mode adds `x-codex-routing-hint: model=<model>;tier=priority` alongside the request body's `service_tier`. Better OpenAI does not add that Codex routing header to direct OpenAI API requests or noncanonical proxy endpoints.

The extension owns one scoped Effect runtime per Pi session. Repeated `session_start` replaces and disposes the previous runtime; usage polling and image streams are interrupted during replacement or `session_shutdown`.

Fast mode assumes every model from the `openai` and `openai-codex` providers supports the `priority` service tier. There is no model allowlist.

Example config:

```json
{
  "persistState": true,
  "desiredActive": false,
  "compaction": {
    "enabled": false
  },
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

## Image generation

`openai_image` honors pi-code-previews' opt-in `toolCallCollapsedStyle: "compact"` setting after `/reload`. It shows the action, a short prompt or saved path, and the generation outcome. Saved paths and recovery text remain visible. Pi renders native images separately, outside the compact text-row budget. Expansion restores full result text; text-only errors retain their complete error details. The default `preview` presentation is unchanged.

Image requests explicitly select `gpt-image-2.5-sunburst` for the hosted `image_generation` tool. OpenAI describes Sunburst as its [most capable image generation and editing model](https://developers.openai.com/api/docs/models/gpt-image-2.5-sunburst). Sunburst is the default for every action, including `auto`. Set the tool's `imageModel` to `gpt-image-2.5-flare` for the faster 2.5 variant.

The tool's `model` parameter and `image.defaultModel` still select the mainline Codex model that invokes image generation, not the image model itself. This separation follows OpenAI's [Responses image generation guide](https://developers.openai.com/api/docs/guides/tools-image-generation). Codex subscription availability depends on OpenAI's rollout and your account. Requests do not silently fall back to an older image model if rejected.

Use the command for quick generation:

```text
/openai-image draw an otter reading a terminal
```

Agents can call the `openai_image` tool directly. Supported parameters:

- `prompt` (required): pass the user's image wording verbatim.
- `action`: `auto`, `generate`, or `edit`.
- `images`: up to five distinct project-local reference/edit image paths. Paths must stay inside the current workspace and point to readable PNG, JPEG, WebP, or GIF files; each file is limited to 20 MB and the combined input to 50 MB.
- `model`: mainline Codex model override, for example `openai-codex/gpt-5.5`. Defaults to the current `openai-codex` session model, otherwise `image.defaultModel`. This does not select the hosted image model.
- `imageModel`: `gpt-image-2.5-sunburst` by default, or `gpt-image-2.5-flare`. Applies only to this call; `/openai-image <prompt>` uses Sunburst.
- `outputFormat`: `png`, `jpeg`, or `webp`.
- `save`: `project`, `global`, `custom`, or `none`.
- `saveDir`: required for `save: "custom"` unless `PI_IMAGE_SAVE_DIR` is set.

For faster generation, call `openai_image` with:

```json
{
  "prompt": "draw an otter reading a terminal",
  "imageModel": "gpt-image-2.5-flare"
}
```

Save modes:

- `project` writes to `.pi/generated-images/` in the current project.
- `global` writes to the agent `generated-images` directory, normally `~/.pi/agent/generated-images/` or `$PI_CODING_AGENT_DIR/generated-images/`.
- `custom` writes to `saveDir` or `PI_IMAGE_SAVE_DIR`; relative paths are resolved from the current project.
- `none` returns the image without saving it.

The repository ignores `.pi/`, so generated images and local config should not be committed.
