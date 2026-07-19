# pi-advisor

A private pi extension that keeps a dedicated Advisor model alongside the main agent. The Advisor reviews ordered work observations, investigates the current project through a fixed read-only capability set, and routes bounded findings without replacing or hiding the primary output.

## Install

Requires Node.js 22.19.0 or newer and Pi 0.80.8. pi-advisor is local-only and is not published to npm.

```bash
git clone https://github.com/mattleong/cosmic-pi.git
cd cosmic-pi
pnpm install
pi install "$PWD/packages/pi-advisor"
```

For one development session:

```bash
pi -e ./packages/pi-advisor
```

## Runtime model

pi-advisor creates one persistent Advisor conversation for the active parent session. It uses only public Pi APIs, an in-memory child `SessionManager`, and an in-memory child transcript. Complete Advisor messages, including Advisor thinking, remain available to later checkpoints in memory but are never written as a second raw transcript or child session file.

A compact `pi-advisor-checkpoint` ledger is appended to the parent session after coherent checkpoints. It contains only a protocol/fingerprint, active parent anchor, bounded state summary, routing/cancellation state, bounded intervention budget, bounded lifecycle metadata, and bounded emission hashes. It contains no raw parent deltas, main or Advisor thinking, tool output, credentials, or copied files. On session resume the extension validates the latest active-branch ledger and re-primes a fresh in-memory Advisor from Pi's compacted active context plus compact state. Branch changes, compaction, configuration identity changes, context pressure, malformed protocol, and child failures reset or re-prime the child; old epochs cannot deliver.

Pi-exposed main-agent text and thinking deltas are forwarded as bounded ordered observations. Missing, opaque, or redacted thinking remains missing/opaque; pi-advisor does not invent it. Tool starts, bounded updates, results, errors, and completed-turn facts are also forwarded. Repository content and tool output are untrusted evidence, never Advisor instructions.

## Completed-turn catch-up

Every eligible completed primary `turn_end`—both a tool-calling progress turn and a terminal completed assistant turn—enqueues a correlated checkpoint and waits for only pi-advisor's own catch-up barrier. This prevents the next primary model step from starting before that checkpoint settles or fails open. Ordinary tool-boundary checkpoints are observation-only: they update the persistent Advisor context but cannot emit premature “unfinished work” notes. Independently triggered trajectory reviews remain routable, as do terminal response reviews.

The catch-up wait has a hard **30,000 ms per-turn cap**. Provider failure, Advisor reset/disposal, or the parent abort signal releases it earlier. Timeout or failure never discards or aborts the primary output. A timed-out or cancelled checkpoint is permanently stale for delivery: a late result cannot steer, abort, trigger correction, or surprise-resume the parent. pi-advisor never calls parent `waitForIdle()` from an event. `message_update`, tool streaming updates, and other token-level handlers only perform bounded synchronous ingestion and never await Advisor work.

`timeoutMs` configures individual Advisor runtime operations, but cannot raise the completed-turn catch-up cap above 30 seconds.

## Findings and routing

Advisor findings use three severities:

- **nit**: recorded only; never triggers a primary turn.
- **concern**: pushed directly under Guardrail and Advisory; Corrective may interrupt when immunity permits.
- **blocker**: pushed directly under Advisory; Guardrail and Corrective may interrupt and may bypass immunity.

Automatic findings are immediate-or-drop and never wait for a later user prompt. Direct advice is injected immediately with steering but never wakes an idle parent. Live corrections use steering, and an eligible idle terminal correction may trigger a turn immediately. Turning supervision off disables automatic review while keeping explicit review commands available.

After an interrupting correction is actually delivered, concerns have fixed immunity for the next **three subsequently completed primary turns**. Reviews, passes, failures, user-request boundaries, and suppressed findings do not consume the window. A blocker may bypass and re-arm it. Findings suppressed by immunity are dropped rather than deferred. This fixed policy is not configurable.

External/user-aborted turns, `/advisor cancel`, pause, and off latch conservative cancellation. Late findings are dropped and cannot resume the parent or appear after a future user prompt. Only a genuine user prompt clears the latch. Repeated findings are normalized and bounded by session/branch; equal or lower repeats are suppressed while a real severity escalation remains eligible.

Progress routing also uses bounded stream and tool-trajectory evidence. Repeated calls/results/errors or oscillation can request a checkpoint, but elapsed time alone is not proof of a loop. Ordinary tool-boundary checkpoints are observation-only. Parent abort/recovery requires both strong local trajectory evidence and a correlated second Advisor pass that reconfirms a high-confidence, direct-evidence blocker; active tools make abort unsafe.

Findings receive runtime-generated stable IDs and move through bounded in-memory lifecycle states: open, acknowledged after delivery, resolved after a complete later checkpoint omits them, or superseded for reserved future protocols. The Advisor reports closed confidence and evidence-basis fields. Deterministic gates require high confidence plus direct evidence for blocker routing; weaker blockers are downgraded to concerns, while low-confidence or evidence-free findings remain internal.

Automatic interventions have a fixed per-request budget: at most two strictly escalating deliveries (concern then blocker) and at most one correction-class intervention. A blocker-first delivery exhausts the request. Genuine user input resets the budget; tool turns and Advisor-triggered corrections do not. Pi exposes causal delivery receipts, not semantic agreement, so acknowledgement metrics mean the main agent continued processing after injection rather than proving the critique was accepted.

## Read-only investigation and exact safety boundary

The Advisor can use exactly four package-owned tools:

- `read`
- `grep`
- `find`
- `ls`

All paths are resolved and realpathed beneath the canonical parent project root. Absolute escape, `..` traversal, and symlink traversal are rejected. Reads, lines, matches, entries, recursion, scanned files, total bytes, and child tool rounds are bounded and abort-aware. `grep` is literal text search and `find` uses a package-owned filesystem glob matcher. Neither implementation invokes `rg`, `fd`, a shell, a package manager, or any process.

The child uses a no-discovery resource loader, an explicit safe tool-name list, and package-identity assertions before work. It does not discover or inherit project/global extensions, prompts, skills, themes, agents files, provider tools, custom tools, or main-session tool registries.

**Exact guarantee:** the Advisor capability path has no process-launch capability and no filesystem-mutation capability. It cannot run commands or activate bash, write, edit, patch, exec, process, provider, custom, `all`, or future inherited tools. Prompt text, repository text, provider metadata, extension registries, and unknown configuration cannot widen this set. There is no tool allowlist/grant configuration.

Read-only does not mean data-free: files under the project root that the Advisor chooses to inspect are sent to the configured Advisor provider as bounded evidence. Credentials are not deliberately included, but users should select a project root and provider appropriate for their data policy.

## Commands and status

```text
/advisor
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
/advisor-usage
```

`verify-last` requests an evidence-focused review and may use the same project-confined read-only tools. `/advisor-settings` is a compatibility shortcut for the settings dashboard. The dashboard shows every setting in one flat list and persists each change immediately; there is no Apply step or nested Advanced section.

`/advisor-usage` reports provider-recorded model responses, tokens, cache usage, cost, review timing, per-model attribution, blocker-verification results, finding lifecycle counts, intervention receipts/budget, and operational calibration outcomes for the current session. Calibration separates passes, finding-bearing reviews, delivered advice/guidance/revisions/recoveries, suppression, discard, and failure. These counters measure Advisor/routing behavior, not objective correctness or user acceptance. They reset on session start but not on compaction or branch changes, exclude parent-agent usage, and never estimate unreported costs.

Verbose status reports persistent/in-memory behavior, fixed immunity, active safe tool names, observation backlog, processed/ingested sequence, pending checkpoints, catch-up waits/timeouts/failures/cancellations, child resets/re-primes, guidance, usage totals, and bounded failure classes. Injected parent notes use a compact Issue/Action form; full sanitized evidence and recommendations remain available only in the expanded local renderer. Status and usage never display transcript text, thinking, tool evidence, auth values, or credentials.

## Configuration

Configuration is global-only:

```text
$PI_CODING_AGENT_DIR/extensions/pi-advisor.json
```

When `PI_CODING_AGENT_DIR` is unset, the path defaults to `~/.pi/agent/extensions/pi-advisor.json`. Project-local config does not override Advisor settings.

```json
{
  "enabled": true,
  "provider": "openai-codex",
  "model": "gpt-5.5",
  "fastMode": true,
  "thinkingLevel": "high",
  "reviewPolicy": "corrective",
  "timeoutMs": 90000,
  "maxContextChars": 240000
}
```

- `enabled`: automatic supervision toggle; defaults to `true`.
- `provider` and `model`: dedicated Advisor model identity; both must be non-empty.
- `fastMode`: requests the shared supported OpenAI priority tier; defaults to `true`. It is active only for supported models.
- `thinkingLevel`: Advisor reasoning level; defaults to `high` and is clamped to model support.
- `reviewPolicy`: `corrective`, `guardrail`, or `advisory`; defaults to `corrective`. Corrective can act on concerns and blockers, Guardrail directly advises on concerns and acts on blockers, and Advisory pushes all actionable findings directly without aborting or waking an idle parent. Three-turn concern immunity limits repeated interruptions.
- `timeoutMs`: Advisor operation timeout, clamped to 10,000–180,000 ms and defaulting to 90,000 ms. It does not alter the hard 30,000 ms completed-turn barrier; work finishing later can still improve the persistent Advisor context but cannot deliver a stale intervention for that turn.
- `maxContextChars`: bounded serialized seed limit, clamped to 16,000–240,000 characters and defaulting to 240,000. Users can lower it directly when lower latency or cost is preferred.

### Migration and unknown fields

Legacy behavior values migrate automatically: `strict` becomes `corrective`, `advice` becomes `advisory`, and `manual` becomes disabled supervision plus `advisory`. `revisionCooldownTurns` is retired. If an existing file contains it, pi-advisor preserves the raw root field during settings round-trips but ignores it completely. Fixed three-completed-turn concern immunity with blocker bypass replaces it.

Unknown root JSON is preserved for forward-compatible round-trips. This includes legacy or adversarial `tools`, mutating-tool options, `all`, provider/custom tool definitions, and command settings. Preserved does not mean active: unknown fields are excluded from resolved runtime config, runtime fingerprints, resource loading, and child tool construction. No configuration can grant Advisor tools.

## Advisor guidance

Trusted Advisor-only priorities may be placed in:

```text
$PI_CODING_AGENT_DIR/ADVISOR.md
<project>/.pi/ADVISOR.md
```

The project file loads only for a trusted project. Guidance may refine review priorities but cannot replace the security boundary, fixed routing policy, or checkpoint schema. Each file is capped at 32,000 characters. Use `/reload` after editing.

## Failure handling

Model lookup, public-auth transfer, timeout, parent abort, provider errors, malformed checkpoints/ledgers, unsafe tool identity, child loop/context pressure, reset, and disposal all fail open. The primary output remains intact. Diagnostics are appended to `$PI_CODING_AGENT_DIR/logs/pi-advisor.jsonl` without prompts, transcripts, thinking, tool output, or credentials; the log rotates at 1 MB.

## Local development

```bash
pnpm install
pnpm --filter pi-advisor test
pnpm --filter pi-advisor validate
pnpm validate
```
