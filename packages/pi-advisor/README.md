# pi-advisor

A pi extension that sends each eligible candidate response to a dedicated advisor model, shows actionable review findings, and gives the main agent one opportunity to revise its answer.

## Install

Requires Node.js 22.19.0 or newer. pi-advisor is local-only and is not published to npm.

Clone the workspace, install its development dependencies, and register the package with pi using its local path:

```bash
git clone https://github.com/mattleong/cosmic-pi.git
cd cosmic-pi
pnpm install
pi install "$PWD/packages/pi-advisor"
```

The `pi install` command adds the extension persistently. To load the checkout for a single development session instead, run:

```bash
pi -e ./packages/pi-advisor
```

## How it works

After the main agent finishes a text-only response, pi-advisor automatically asks a separately configured model to check correctness, completeness, user intent, and actionable risks. The review includes the latest genuine user request and candidate response plus as much recent conversation and tool-result context as fits the configured limit. Recent messages are selected by recency and presented to the advisor in chronological order.

- A passing review leaves the candidate unchanged and shows a brief success notice.
- A review with up to five high- or medium-severity findings displays the full critique and steers the main agent to produce one revised response in the same run. Low-impact style preferences and optional polish do not trigger revision.
- The revised response is not reviewed again. A later genuine user message, including a queued follow-up, starts a new one-pass review cycle.
- Responses that contain tool calls, have no assistant text, or were aborted or errored are not reviewed.
- The original streamed candidate remains visible before any critique and revision.

Advisor calls never use tools and never fall back to the active main model. Model lookup, credentials, timeout, abort, provider, empty-output, and malformed-output failures all fail open: the original candidate remains available and pi shows a concise warning.

## Setup and commands

Open the settings picker and choose an authenticated advisor model:

```text
/advisor-settings
```

The picker also controls whether automatic review is enabled, the advisor reasoning level, the timeout, and the context limit. The model picker supports fuzzy search by provider, model ID, or display name and lists models currently available through pi's model registry, so authenticate the desired provider through pi first.

Inspect the effective setup without exposing credentials:

```text
/advisor-status
```

Status reports whether review is enabled and configured, the selected provider/model, credential availability, effective limits, session review counters, and the global configuration path. If review is enabled but no model is configured, the extension skips reviews and points to `/advisor-settings` once per session.

## Configuration

Configuration is global-only at:

```text
$PI_CODING_AGENT_DIR/extensions/pi-advisor.json
```

When `PI_CODING_AGENT_DIR` is unset, the path defaults to `~/.pi/agent/extensions/pi-advisor.json`. A leading `~/` in `PI_CODING_AGENT_DIR` is expanded relative to your home directory. Project-local config does not override advisor settings.

Example:

```json
{
  "enabled": true,
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "thinkingLevel": "high",
  "timeoutMs": 30000,
  "maxContextChars": 48000
}
```

Settings:

- `enabled`: automatic review toggle; defaults to `true`.
- `provider` and `model`: both must be non-empty for review to be configured. Use `/advisor-settings` to search for and select an authenticated model.
- `thinkingLevel`: advisor reasoning level; defaults to `medium`. The settings picker only offers levels supported by the selected model, from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `timeoutMs`: advisor request timeout in milliseconds; defaults to `30000` and is clamped to `10000`–`180000`.
- `maxContextChars`: serialized review-context limit; defaults to `48000` and is clamped to `16000`–`240000`.

Settings updates preserve unknown root JSON fields. When context must be shortened, the latest user request and candidate response are always retained, the newest context is selected first and then rendered chronologically, prior advisor-review messages are excluded, and omitted context is marked explicitly. Advisor output is capped at 2,048 tokens.

## Local development

From the workspace root:

```bash
pnpm install
pnpm --filter pi-advisor test
pnpm --filter pi-advisor validate
pi -e ./packages/pi-advisor
```

Run `pnpm validate` before committing to verify the full workspace.
