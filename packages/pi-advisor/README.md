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

After the main agent finishes a completed response, pi-advisor queues a background request to a separately configured model to check correctness, completeness, user intent, evidence, and actionable risks. The main turn settles immediately instead of waiting for the advisor. The review includes the latest genuine user request and candidate response plus as much recent conversation and tool-result context as fits the configured limit. Recent messages are selected by recency and presented to the advisor in chronological order.

- A passing review leaves the candidate unchanged without adding another transcript notification.
- The default **Guardrail** policy automatically revises high-severity findings and shows medium-only findings as non-triggering advice. **Strict** revises medium and high findings, **Advice only** never triggers another turn, and **Manual** reviews only on request.
- The default zero-request cooldown lets each new user request receive an independent correction. If a nonzero cooldown is configured, findings during that many subsequent finding-bearing reviews appear as advice instead of restarting work. Passing, failed, and discarded reviews do not consume the cooldown.
- Starting a newer user request cancels or discards the older review, preventing stale advice from interrupting current work. Background reviews are serialized rather than allowed to overlap.
- Repeated findings are normalized only within the current request/review scope. A recurring defect in a later user request remains visible.
- The advisor-triggered revision is not reviewed again. Revision suppression is bound to the reviewed request, so a queued follow-up cannot accidentally inherit it.
- Responses that contain tool calls, have no assistant text, or were aborted or errored are not reviewed. A completed final response remains eligible even when its turn reports tool results.
- The original streamed candidate remains visible before any later critique or revision. Advisor messages are compact by default and show complete evidence and recommendations when expanded.

Advisor calls never use tools and never fall back to the active main model. Model lookup, credentials, timeout, abort, provider, empty-output, and malformed-output failures all fail open: the original candidate remains available and a current background review failure produces only a concise warning. Failure diagnostics are appended to `$PI_CODING_AGENT_DIR/logs/pi-advisor.jsonl` without prompts, transcripts, or credentials; the log rotates at 1 MB.

## Setup and commands

Open the unified advisor dashboard:

```text
/advisor
```

The dashboard provides review-next, review-last, evidence-focused verify-last, pause/resume, enable/disable, settings, and status actions. Direct forms are also available:

```text
/advisor once
/advisor review-last
/advisor verify-last
/advisor pause
/advisor resume
/advisor cancel
/advisor on
/advisor off
/advisor settings
/advisor status --verbose
```

`verify-last` is an evidence-focused review of the supplied transcript; the advisor remains tool-free and does not claim external verification.

`/advisor-settings` remains as a compatibility shortcut. Its main screen focuses on the model, behavior policy, and Fast/Balanced/Thorough speed presets. Reasoning, OpenAI fast mode, cooldown, timeout, and context limits are under Advanced settings. Changes are staged until **Apply changes**; Cancel leaves the active configuration untouched. The model picker supports fuzzy search by provider, model ID, or display name and lists models currently available through pi's model registry.

`/advisor-status` shows a concise health summary. Use `/advisor-status --verbose` or `/advisor status --verbose` for model capabilities, limits, background state, cooldown, guidance paths, duration, tokens, cost, failure class, duplicate suppression, skip reasons, session counters, logs, and the global configuration path. If review is enabled but no model is configured, the extension skips reviews and points to `/advisor-settings` once per session.

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
  "fastMode": true,
  "thinkingLevel": "high",
  "reviewPolicy": "guardrail",
  "revisionCooldownTurns": 0,
  "timeoutMs": 30000,
  "maxContextChars": 48000
}
```

Settings:

- `enabled`: automatic review toggle; defaults to `true`.
- `provider` and `model`: both must be non-empty for review to be configured. Use `/advisor-settings` to search for and select an authenticated model.
- `fastMode`: sends `service_tier: "priority"` for advisor models in pi-better-openai's shared supported-model list; defaults to `false`. The settings picker only shows this toggle for supported models.
- `thinkingLevel`: advisor reasoning level; defaults to `medium`. The settings picker only offers levels supported by the selected model, from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `reviewPolicy`: intervention behavior; one of `guardrail`, `strict`, `advice`, or `manual`. Defaults to `guardrail`.
- `revisionCooldownTurns`: number of subsequent finding-bearing reviews during which findings become non-triggering advice after an automatic revision; defaults to `0` and is clamped to `0`–`5`. The legacy field name is retained for configuration compatibility even though the UI describes requests rather than turns.
- `timeoutMs`: advisor request timeout in milliseconds; defaults to `30000` and is clamped to `10000`–`180000`.
- `maxContextChars`: serialized review-context limit; defaults to `48000` and is clamped to `16000`–`240000`.

Settings updates preserve unknown root JSON fields. When context must be shortened, the latest user request and candidate response are always retained, the newest context is selected first and then rendered chronologically, prior advisor-review messages are excluded, and omitted context is marked explicitly. Advisor output is capped at 2,048 tokens.

## Advisor guidance

Advisor-only review priorities can be placed in:

```text
$PI_CODING_AGENT_DIR/ADVISOR.md
<project>/.pi/ADVISOR.md
```

The global file loads first. The project file loads afterward only when the project is trusted, so narrower project guidance can refine global priorities. Guidance may focus the review on project risks and architectural constraints, but cannot replace the advisor security boundary, rubric, or JSON output schema. Each file is capped at 32,000 characters. Guidance is loaded at session start; use `/reload` or start a new session after editing it.

## Local development

From the workspace root:

```bash
pnpm install
pnpm --filter pi-advisor test
pnpm --filter pi-advisor validate
pi -e ./packages/pi-advisor
```

Run `pnpm validate` before committing to verify the full workspace.
