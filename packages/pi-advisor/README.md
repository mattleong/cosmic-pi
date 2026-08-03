# pi-advisor

A private Pi extension that runs a dedicated read-only Advisor model, intervenes on material issues, and shows durable TUI-only review cards.

## Setup and configuration

Run `/advisor setup` and choose an authenticated model. Choosing a model atomically saves the provider/model, turns Advisor on, and dismisses onboarding. **Not now** saves only `setupDismissed: true`. Automatic onboarding opens only in an interactive TUI session when no model is configured and setup has not been dismissed; non-interactive sessions stay silent. `/advisor setup` always reopens it.

Global configuration lives at `$PI_CODING_AGENT_DIR/extensions/pi-advisor.json` (normally `~/.pi/agent/extensions/pi-advisor.json`):

```json
{
  "enabled": true,
  "provider": "openai-codex",
  "model": "gpt-5.6-sol",
  "setupDismissed": true
}
```

Only those four optional fields are decoded. Removed fields such as `mode`, `reviewPolicy`, `fastMode`, `thinkingLevel`, `timeoutMs`, and `maxContextChars` are ignored and scrubbed on the next settings write; unrelated unknown root fields remain preserved. Runtime choices are fixed: medium reasoning, no fast mode, a 90-second Advisor operation timeout, and 120,000 recent-context characters.

## Behavior

Advisor has one behavior: when enabled, it quietly observes and intervenes when evidence supports a material issue. A final review may wait for at most 10 seconds. Accepted findings produce a local review card plus compact hidden correction guidance to the main agent. A blocker must pass an independent verification checkpoint, and Advisor may interrupt only for a verified, safely recoverable stall with no active tool.

Every ordinary tool-calling/progress `turn_end` only ingests bounded observations and returns immediately; it performs no synchronous Advisor checkpoint and has no catch-up wait. Conservative trajectory timers may request an asynchronous progress review when loop or long-turn evidence warrants it. Useful progress perspectives may steer without waking an idle agent. Automatic final suggestions are suppressed; explicit `/advisor review` suggestions remain local cards.

Passes stay silent. Automatic output allows one ordinary visible intervention per genuine user request and one verified blocker escalation. Dedupe, stale-result checks, blocker verification, cancellation, read-only confinement, compact ledgers, bounded observations, fail-open behavior, and correction immunity remain internal.

## Local review cards

Visible Advisor output is never a custom message. It is a versioned `pi-advisor-review-card-v1` custom session entry written with `pi.appendEntry()` and rendered with `pi.registerEntryRenderer()`, so it is durable and excluded from LLM context.

Collapsed cards show only `Advisor · N issues` or `Advisor suggestion` plus the summary. Expanded cards show only issue, evidence, and suggested fix. Cards are schema-checked, sanitized, and bounded; provider/model, verdict, IDs, status, category, confidence, and evidence-basis metadata are hidden.

`Fix last` sends a separate compact `display:false` guidance message to the parent and writes a `pi-advisor-review-action-v1` fix tombstone. `Dismiss last` sends no parent message and writes a dismiss tombstone. The latest open card is reconstructed from the active branch whenever the dashboard, Fix, or Dismiss needs it. Cards and tombstones remain in the parent session file; they do not enter model context. The compact Advisor ledger remains metadata-only and contains no raw transcript, thinking, tool output, copied file content, or credentials.

## Commands

The extension registers exactly one top-level command:

```text
/advisor
/advisor on
/advisor off
/advisor review
/advisor fix
/advisor dismiss
/advisor cancel
/advisor setup
/advisor usage
```

The dashboard shows effective state, model, last result, token/cost totals, and only currently relevant actions. `review` runs a one-off local review of the last response, including while automatic operation is off; `fix` sends its guidance and `dismiss` closes it. `cancel` stops current Advisor work without turning Advisor off. `usage` reports responses/reviews/cards, corrections, tokens/cost, and timing. Redacted diagnostics remain in the failure log rather than the command UI. The spinner is simply `Advisor reviewing…`.

## Read-only and failure boundaries

Advisor can use only package-owned `read`, `grep`, `find`, and `ls` beneath the canonical project root. It cannot discover inherited extensions/tools, launch a process, or mutate files. Files it reads may be sent to the configured provider as review evidence.

Provider, authentication, timeout, parsing, host callback, cancellation, reset, and disposal failures fail open: the primary response is preserved. Redacted diagnostics are written to `$PI_CODING_AGENT_DIR/logs/pi-advisor.jsonl`.

## Development

```bash
pnpm install
pnpm --filter pi-advisor validate
pnpm validate
```
