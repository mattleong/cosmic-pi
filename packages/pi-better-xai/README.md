# pi-better-xai

Shows your xAI / Grok subscription usage in Pi, with weekly and monthly meters in the footer.

## Features

- **Subscription usage** in the footer and on demand with `/xai usage`.
- **Weekly and monthly windows**, with optional reset countdowns.
- **Footer integration** with `pi-cosmic-ui`, matching Better OpenAI's progress bars, or Pi's status line without it.

```text
xAI     7d ████████░░ 82%  mo ████████░░ 83%
```

## Install

```bash
pi install npm:pi-better-xai
pi install npm:pi-cosmic-ui   # optional: shared footer
```

Requires a SuperGrok or eligible X Premium subscription. Sign in with `/login xai`, choose **Use a subscription**, then check it works with `/xai usage`. API-key logins don't have these meters.

## Usage

| Command               | Action                                       |
| --------------------- | -------------------------------------------- |
| `/xai usage`          | Show current subscription usage              |
| `/xai settings`       | Open settings; `help` and `status` also work |
| `/cosmic-ui settings` | Show or hide xAI usage in the footer         |

## Configuration

Settings live in `~/.pi/agent/extensions/pi-better-xai.json` or a project's `.pi/extensions/pi-better-xai.json`.

| Key                                  | Default | Description                  |
| ------------------------------------ | ------- | ---------------------------- |
| `usage.refreshIntervalMs`            | `60000` | Poll interval (minimum 5000) |
| `usage.showOnlyOnSubscriptionModels` | `true`  | Hide usage on API-key models |
| `usage.showResetTimes`               | `true`  | Include reset countdowns     |

## How it works

Usage comes from the billing endpoints of xAI's Grok CLI proxy (`cli-chat-proxy.grok.com/v1/billing`). These are first-party but undocumented, so they can change without notice. Each Pi session runs polling in a scoped Effect runtime and decodes responses with Effect Schema: a bad monthly response fails the refresh, while a missing weekly window falls back to monthly-only usage. Credentials are read through Pi's model registry and never written.

See [ARCHITECTURE.md](ARCHITECTURE.md) for ownership and lifecycle.
