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

### Native codemode

`await tools.openai_image(...)` returns a structured version-1 result, not text to parse:

- Envelope: `contract: "pi-better-openai/image"`, `version: 1`, `tool: "openai_image"`.
- Metadata: `id`, `status`, verbatim `prompt`, `model`, `action`, `outputFormat`, and optional `revisedPrompt`, `savedPath`, `imageModel`.
- Required `image: { type: "image", data, mimeType }`, with the existing base64 bytes. There is no root-level `data`.

Show the image with `image(result.image)`; print only selected metadata. Never send the full result or base64 to `text()`, `console`, `return`, or `store()`. Keep the user's prompt verbatim.

```js
const result = await tools.openai_image({
  prompt: "A red comet over a blue ocean",
  save: "project",
});
image(result.image);
text({ id: result.id, status: result.status, savedPath: result.savedPath });

const edited = await tools.openai_image({
  prompt: "Make the comet green",
  action: "edit",
  images: [result.savedPath],
  save: "none",
});
image(edited.image);
```

Use `save: "project"` for chaining: edit inputs must be workspace-contained; global/custom outputs outside the workspace are not accepted directly. The image block is returned even when a file was saved. `save: "none"` creates no Better OpenAI image file, but still returns the image and does **not** disable Pi history. Direct calls keep their normal text, one image, and byte-free details. In the tested Pi 1.0.2 transcript, transient structured data is not persisted as a second image copy. Pi 1.1's `image()` additionally saves a temporary file; that host behavior is version-dependent and is not the `savedPath` contract. Use `save: "project"`, not an assumed temporary path, for edit chaining.

Native codemode has separate limits: 16,777,216 output characters including base64 image data, and a 256 MB VM. They do not change Better OpenAI's existing 60 MiB generated-image limit; a tool-valid image can exceed codemode's capacity. Saving a file does not remove the required image block or bypass VM limits. Generation can take minutes, so avoid short script deadlines.

Service failures and cancellation reject script calls. If structured encoding fails after generation or saving, the call reports an error without structured data while retaining its original text, image, and details. Generation/saving is not rolled back; inspect the retained receipt rather than blindly retrying.

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
