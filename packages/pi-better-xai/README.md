# pi-better-xai

A pi extension for xAI / Grok subscription workflows: usage visibility and Cosmic UI footer polish.

## Install

```bash
pi install npm:pi-better-xai
```

Install `pi-cosmic-ui` as well to render Better xAI's usage primitive with the same progress-bar footer treatment as Better OpenAI. Without Cosmic UI, Better xAI falls back to a plain usage footer/status line.

## Requirements

- pi with xAI OAuth login (`/login xai` → **Use a subscription**)
- SuperGrok or eligible X Premium entitlement on the authenticated account

Usage display requires pi's `xai` OAuth credentials.

1. Run `/login xai` and complete subscription OAuth.
2. Verify with `/xai-usage`, or open `/xai-settings` and check **Diagnostics**.

## Features

- xAI subscription usage display via `/xai-usage` and the footer.
- Weekly + monthly windows from xAI's CLI billing endpoints.
- Cosmic UI integration when a host is present.

### Commands

- `/xai-usage` shows current xAI subscription usage.
- `/xai-settings` configures usage display and footer fallback mode.

## Footer

The extension publishes a data-oriented usage primitive over the versioned Cosmic UI event protocol when a host is present.

When Cosmic UI is active, it owns footer layout and renders `xai.usage` with progress bars matching `openai.usage`:

```text
xAI     7d ████████░░ 82%  mo ████████░░ 83%
```

Source endpoints (unofficial first-party xAI / grok.com CLI proxy):

- `GET https://cli-chat-proxy.grok.com/v1/billing`
- `GET https://cli-chat-proxy.grok.com/v1/billing?format=credits`

## Settings

Stored at `~/.pi/agent/extensions/pi-better-xai.json` (or project `.pi/extensions/`).

| Key                                  | Default   | Description                                            |
| ------------------------------------ | --------- | ------------------------------------------------------ |
| `usage.enabled`                      | `true`    | Fetch and show usage                                   |
| `usage.refreshIntervalMs`            | `60000`   | Poll interval                                          |
| `usage.showOnlyOnSubscriptionModels` | `true`    | Hide on API-key xAI models                             |
| `usage.showResetTimes`               | `true`    | Include reset countdowns                               |
| `footer.mode`                        | `replace` | Standalone fallback only: `replace` / `status` / `off` |

## Effect runtime

Better xAI now runs each started Pi session through an Effect v4 managed runtime. Configuration, credential refresh, HTTP decoding, polling, cancellation, and shutdown are typed and scoped. Billing and OAuth payloads are decoded with Effect Schema; malformed monthly responses fail the refresh, while unavailable or malformed weekly responses degrade to monthly-only usage.

Configuration updates preserve unknown fields. Malformed known fields fall back to documented defaults. The minimum refresh interval remains 5 seconds.

The package has runtime dependencies on the exact workspace Effect v4 beta and `pi-cosmic-core`. These versions are intentionally synchronized by the cosmic-pi release process.

## Caveats

- Billing endpoints are first-party xAI infrastructure (`*.grok.com`) but are **not** a documented public API. They can change without notice.
- Same class of integration as OpenAI ChatGPT subscription usage in Better OpenAI.
- Do not use API-key auth expecting these meters; they are subscription OAuth meters.
