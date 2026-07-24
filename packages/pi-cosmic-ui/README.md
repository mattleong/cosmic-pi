# pi-cosmic-ui

Composable, responsive UI elements for pi. Cosmic UI provides a custom footer that combines pi's location, session, token, context, model, thinking, and extension-status information with contributions from other extensions. While an agent is running, Pi's working row also shows elapsed time and estimated output speed (for example, `Working · 2m 14s · ~18.4 tok/s`). The estimate uses Pi's four-characters-per-token heuristic across streamed text, thinking, and tool-call arguments. Its generation clock pauses during tool execution, while the working elapsed time continues to show total agent wall time.

## Install

```bash
pi install npm:pi-cosmic-ui
```

For local development, load Cosmic UI by itself or together with Better OpenAI:

```bash
pi -e ./packages/pi-cosmic-ui
pi -e ./packages/pi-cosmic-ui -e ./packages/pi-better-openai
```

## Configure

Run `/cosmic-ui` to configure footer visibility, density, and media placement. Configuration is read from `~/.pi/agent/extensions/pi-cosmic-ui.json` and may be overridden per project in `.pi/extensions/pi-cosmic-ui.json`.

```json
{
  "footer": {
    "enabled": true,
    "density": "auto",
    "order": [
      "model",
      "effort",
      "location",
      "openai.fast",
      "branch",
      "pullRequest",
      "git",
      "context",
      "session",
      "metrics",
      "openai.usage",
      "xai.usage",
      "extensions"
    ],
    "hidden": [],
    "mediaPlacement": "inline-right"
  }
}
```

Unknown configuration fields are preserved by the settings UI. Known fields are decoded independently, so an invalid value does not discard valid siblings.

Each active Pi session owns one scoped Effect runtime. Git and pull-request polling is single-flight, uses the current callback context, and is interrupted on session replacement, abort, or shutdown.

## Extension contributions

The public `pi-cosmic-ui/protocol` subpath exports the versioned `pi.events` channel names and contribution types. A producer first queries for a host and then upserts keyed text or media contributions. Text contributions provide plain text plus a semantic tone so Cosmic UI can apply the active theme. Media contributions may attach to the footer's render request, detach when the footer is hidden or replaced, and dispose when removed. Producers must remove their contributions during `session_shutdown`.

Cosmic UI is the sole custom-footer owner when installed. It does not depend on provider-specific extensions; `pi-better-openai` detects the host and contributes fast-mode and subscription-usage primitives when both packages are loaded.
