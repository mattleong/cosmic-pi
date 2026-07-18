# pi-advisor

A pi extension that uses a dedicated advisor model to supervise active work and completed responses, surface actionable findings, and give the main agent one bounded opportunity to correct course.

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

During an agent run, pi-advisor queues background checks of meaningful work checkpoints: tool-calling turns, unusually long or strongly repetitive streamed reasoning, and the completed final response. Progress checks use a trajectory-specific rubric that does not penalize ordinary unfinished work; they flag only evidenced wrong directions, repeated non-progress, unsafe actions, ignored constraints, or contradictions. Final checks continue to cover correctness, completeness, user intent, evidence, and actionable risks.

The main agent never waits synchronously for an Advisor model call. Reviews are serialized with one latest pending checkpoint, so a newer turn supersedes stale work instead of creating overlapping requests. A long active turn is checked after 90 seconds, or earlier when the visible thinking/text stream exhibits strong repetition. Provider streams that do not expose reasoning can only be assessed from elapsed time and visible activity.

- A passing review stays silent and the agent continues normally.
- The default **Guardrail** policy corrects high-severity findings and presents medium-only findings as non-triggering advice. **Strict** corrects medium and high findings, **Advice only** never triggers another turn, and **Manual** reviews only on request.
- A progress correction is queued through Pi's steering channel and reaches the next safe model boundary. Steering cannot undo tool side effects that already completed. When a high-severity review confirms that the same streamed turn is still repetitively stalled, Advisor aborts that turn, waits for Pi to settle, then injects recovery guidance and starts the corrective continuation.
- Advisor may inspect later checkpoints, including a correction turn, but it can trigger at most one automatic corrective intervention for each genuine user request. Later findings in that request are advice-only or suppressed when duplicated.
- The default zero-request cooldown lets each new user request receive an independent correction. If a nonzero cooldown is configured, every finding-bearing checkpoint in that many subsequent requests remains advice-only. Passing, failed, and discarded reviews do not consume the cooldown.
- Starting newer user work, pausing/cancelling Advisor, changing its configuration, or replacing the session cancels timers and invalidates queued or active checks. Stale results cannot send guidance or abort work.
- Repeated findings are normalized only within the current user-request scope. A recurring defect in a later request remains visible.
- Empty, aborted, errored, and length-truncated turns are not reviewed. Tool-calling turns are reviewed as progress; completed final responses remain eligible even when their turn reports tool results.
- The original streamed output remains visible before any later critique or correction. Advisor messages are compact by default and show complete evidence and recommendations when expanded.

Advisor calls never use tools and never fall back to the active main model. The separately configured Advisor model receives the latest user request, the candidate or visible work checkpoint, and bounded recent conversation evidence such as assistant text, tool calls/results, extension context, and included shell output. Raw streamed reasoning, system prompts, image bytes, credentials, and prior Advisor messages are excluded.

Model lookup, credentials, timeout, abort, provider, empty-output, and malformed-output failures all fail open: the original candidate remains available and a current background review failure produces only a concise warning. Failure diagnostics are appended to `$PI_CODING_AGENT_DIR/logs/pi-advisor.jsonl` without prompts, transcripts, or credentials; the log rotates at 1 MB.

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

- `enabled`: automatic Advisor supervision toggle; defaults to `true`.
- `provider` and `model`: both must be non-empty for review to be configured. Use `/advisor-settings` to search for and select an authenticated model.
- `fastMode`: sends `service_tier: "priority"` for advisor models in pi-better-openai's shared supported-model list; defaults to `false`. The settings picker only shows this toggle for supported models.
- `thinkingLevel`: advisor reasoning level; defaults to `medium`. The settings picker only offers levels supported by the selected model, from `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`.
- `reviewPolicy`: intervention behavior; one of `guardrail`, `strict`, `advice`, or `manual`. Defaults to `guardrail`.
- `revisionCooldownTurns`: number of subsequent user requests during which findings become non-triggering advice after an automatic correction; defaults to `0` and is clamped to `0`–`5`. The legacy field name is retained for configuration compatibility even though the UI describes requests rather than turns.
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
