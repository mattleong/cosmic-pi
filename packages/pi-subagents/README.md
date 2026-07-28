# pi-subagents

Session-scoped foreground and background subagents for pi.

## Features

- Seven deterministic task profiles: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, and `delegate`. Profiles inject concise role guidance and route an ordered model policy without heuristic scoring.
- Required backend selection with `auto`, `pi`, and `claude-cli`: `auto` resolves the selected profile (or `defaultProfile`), while concrete backends preserve explicit model overrides and retain any selected profile guidance.
- Fresh or forked Pi child sessions. Only `oracle` defaults to forked context; every other profile defaults to fresh. Claude currently supports fresh context only, and oracle never silently degrades when its parent branch cannot be forked.
- Parent-model inheritance with role-specific profile effort defaults, plus per-run model and thinking-effort overrides for Pi and Claude aliases/full model IDs for `claude-cli`.
- One static, preflight-only discovery surface: `subagent_models` shows the configured default profile, profile descriptions, context and effort defaults, candidate ordering/skips/fallback, Pi effort capabilities, plus exact explicit `backend` and `model` selectors. Candidate eligibility is evaluated with each profile's default context, and the output says so: an explicit `context` override at launch (for example `oracle` with `context: "fresh"`) can change which candidates are eligible. Runtime authentication and readiness are checked at launch; denied selector lines are hidden and discouraged lines are marked explicit-only.
- Deterministic Pi model resolution (exact canonical match, then unique bare-ID match) with structured ambiguity and near-match errors; Pi selectors sent to `claude-cli` fail fast with a `backend_model_mismatch` code before any process spawn.
- A process-cached, concurrent-call-deduplicated Claude CLI preflight (`claude auth status --json`) verifies executable presence and authentication before the first `claude-cli` launch, while distinguishing explicit logout from incompatible or failed probes.
- Pi writers inherit parent tools except recursive orchestration tools; Pi read-only children receive a conservative inspection-only allowlist. Claude children use explicit native read-only or writer tool policies.
- Optional human-readable names and immutable run IDs allocated from an opaque per-runtime namespace, so replacing a session runtime never reuses an ID from the abandoned fleet.
- Canonical `subagent_start` launches of one to twelve agents from one required `agents` array; each fresh task must be self-contained with relevant paths, constraints, evidence, and a concrete deliverable. Every item selects its own backend, model, execution mode, context, and write intent, successful launches remain active when a peer item fails, and at most one foreground item is allowed per call so parent questions cannot be hidden behind another foreground waiter.
- Fleet-level `await` collection with live, state-color-coded per-agent progress, optional timeout, and semantic `all_finished` or `any_finished` completion conditions. Await returns early with an exact `subagent_reply` call when a Pi child needs parent input; after replying, the parent awaits again. A finished run is completed, failed, or stopped.
- Generation-based completion claims and short-window batching prevent fully rendered reports collected by foreground start, `await`, or `status` from being delivered again. Truncated or cancelled render claims are released, and actionable questions and warnings retry with bounded exponential backoff until delivered or superseded.
- Capability-aware management: Pi supports steering, replies, interruption, resumption, renaming, and stopping; unsupported Claude controls fail with exact-tool recovery guidance, and detailed status lists each run's capabilities.
- A full-screen `/subagents` fleet inspector.
- Tool calls rendered through the configurable `pi-code-previews` shell, with expanded structured child-session output and Markdown reports.
- One declared writer per shared working directory, retained until failed-process cleanup completes.
- Completed child processes terminate immediately while preserving their Pi session file or Claude session ID for later respawn.
- Batch status, guidance, and lifecycle operations for up to twelve run IDs, with bounded aggregate results, model-visible failure codes, stale-ID reporting, duplicate-ID normalization, and per-target success/failure reporting so partial side effects are never hidden.
- Bounded management messages and compact persisted list/status details.
- Runtime-only parent API-key forwarding through an ephemeral Pi-child environment bootstrap; Claude uses the installed CLI's own authentication.
- Explicit backend capabilities: unsupported controls fail clearly instead of silently changing semantics.
- Exact session ownership: session activation captures cwd, trust, context, and agent directory once; generation-based latest-wins preparation invalidates the older runtime before asynchronous settings load. Every child process stops when the parent session ends, POSIX process-group cleanup still runs after a child leader exits, and successful `/tree` navigation resets the fleet before work continues from the selected branch.

## Profiles and policy configuration

Built-in profiles are deliberately model-neutral. With no configuration, each profile explicitly falls back to the active parent Pi model; no profile guesses a provider or model alias. Profiles do set role-specific reasoning defaults. `delegate` remains closest to the parent and inherits its effort. `backend: "auto"` with no `profile` uses `defaultProfile`, which defaults to `delegate`.

| Profile      | Intended work                                   | Default context | Default effort |
| ------------ | ----------------------------------------------- | --------------- | -------------- |
| `scout`      | Fast local codebase reconnaissance              | fresh           | low            |
| `researcher` | Focused external research with sources          | fresh           | medium         |
| `planner`    | Concrete implementation planning                | fresh           | medium         |
| `worker`     | Focused implementation and validation           | fresh           | high           |
| `reviewer`   | Independent evidence-based review               | fresh           | high           |
| `oracle`     | Inherited-decision analysis and drift detection | fork            | high           |
| `delegate`   | General delegated work                          | fresh           | inherit        |

Global configuration is read from `<agent-dir>/pi-subagents.json`. A trusted project may override it at `<cwd>/<CONFIG_DIR_NAME>/pi-subagents.json` (`CONFIG_DIR_NAME` is normally `.pi`). Untrusted project configuration is never read.

```json
{
  "version": 1,
  "defaultProfile": "delegate",
  "denied": [{ "backend": "claude-cli", "model": "haiku" }],
  "discouraged": [{ "backend": "pi", "model": "provider/legacy-model" }],
  "profiles": {
    "reviewer": {
      "candidates": [
        {
          "source": "model",
          "backend": "claude-cli",
          "model": "fable",
          "effort": "high"
        },
        {
          "source": "model",
          "backend": "pi",
          "model": "provider/review-model",
          "effort": "xhigh"
        }
      ],
      "fallback": "parent"
    },
    "worker": {
      "candidates": [{ "source": "parent" }],
      "fallback": "fail"
    }
  }
}
```

Candidate order is authoritative. A configured route whose `fallback` is omitted or invalid defaults to `"fail"`; it never gains an implicit parent fallback. Configuration accepts at most 256 policy selectors, 32 candidates per route, and 256 characters per model selector. A `claude-cli` candidate configured with effort `off` or `minimal` can never launch, so it is rejected while the document is decoded (with a structural diagnostic) instead of being accepted as a permanently skipped route entry. Effort precedence is per-call override, configured candidate effort, built-in profile default, then parent effort. A host-reported parent thinking level this build does not recognize is clamped to `high` — the same default used when no parent effort is known — rather than forwarded to a child. Only the per-call override and a configured candidate effort are hard requirements; built-in profile defaults and inherited parent effort are soft preferences, so a Pi model that cannot honor them (for example a non-reasoning model) starts anyway and reports its effective level instead of failing. The effective effort is validated before backend readiness checks. Unknown or unauthenticated Pi candidates, invalid backend/context combinations, denied candidates, discouraged automatic candidates, and failed automatic Claude preflights are skipped before a run is reserved. Claude readiness is probed at most once per agent resolution even when several ordered Claude candidates are present. Fallback is only `"fail"` or `"parent"`; there is no arbitrary-model fallback, and an explicit parent candidate is not retried as an identical parent fallback. A project profile replaces the matching global route as one unit; a trusted-project route that is declared but not decodable as a route object fails closed for that profile (no candidates, `fail` fallback) instead of silently reopening the global or built-in route it was meant to replace, while an absent project route keeps the global route and valid sibling routes are unaffected. A malformed global route without a project override behaves like an absent route and falls back to the neutral built-in. Project `denied` and `discouraged` entries are additive, so project configuration cannot weaken a global denial. Denials apply to automatic and explicit launches: an explicit launch enforces hard denies on the deterministic raw selector (or the deterministic inherited/default model) before any registry authentication lookup, runtime API-key resolution, or Claude preflight, rechecks the resolved canonical model, and `SubagentService.start` reauthorizes the deny once more before reservation. Claude aliases and full IDs apply to the corresponding versioned model family, so a deny for `claude-opus-5` also denies dated variants. An explicitly selected discouraged model is allowed but carries a visible policy warning.

Malformed fields, excess object keys, and array entries are ignored independently with redacted structural diagnostics after raw arrays are bounded; parent candidates cannot declare an effort. An unreadable or syntactically invalid JSON policy document — or any document with a present `version` other than numeric `1` — fails extension activation closed rather than silently dropping hard denies or applying a partially understood document; the failure names only the offending file path. Project policy is read only when the host trust callback exists and returns literal `true`. Fix the document and run `/reload`.

Examples:

```json
{
  "agents": [
    {
      "task": "Review the authentication changes",
      "profile": "reviewer",
      "backend": "auto",
      "writeIntent": "read-only"
    }
  ]
}
```

```json
{
  "agents": [
    {
      "task": "Review the authentication changes",
      "profile": "reviewer",
      "backend": "claude-cli",
      "model": "fable",
      "effort": "medium",
      "writeIntent": "read-only"
    }
  ]
}
```

The second form keeps reviewer guidance but explicitly overrides profile routing. Because it also sets `effort`, that value overrides reviewer’s built-in `high` default. `backend: "auto"` cannot combine with `model`. `writeIntent` remains required for every launch.

## Commands

- `/subagents` opens the responsive fleet inspector in interactive TUI mode.

Fleet controls:

- `j` / `k` or arrow keys select a run.
- `Ctrl-U` / `Ctrl-D` (`C-u` / `C-d` in the footer) scroll up and down through the selected run's session output while preserving live tail-follow at the bottom.
- `Enter` toggles details in narrow layouts.
- `t` toggles technical details such as run ID, PID, cwd, and session file.
- `?` switches between navigation keys and contextual actions when the terminal cannot fit both.
- The responsive footer groups navigation, selected-agent actions, and global controls with `│`; capability-aware hints hide unsupported `m`, `i`, `r`, `n`, and `x` actions.
- Stopping requires two `x` presses on the same selected run. Changing selection or pressing `Esc` cancels the pending confirmation.
- `Esc` closes the inspector when no stop confirmation is pending.

Structured session output groups adjacent repeated tools while retaining compact target summaries, wraps long targets and paths, shows state-specific idle messages and completion age, and labels child output neutrally as **Final report** without claiming parent delivery. `subagent_list` returns a compact fleet listing, while `subagent_status` returns labeled metadata without activity history for selected runs and reports stale IDs without discarding valid peers; full activity remains in `/subagents`. The main agent should use `subagent_await`, rather than polling status, after its independent work is finished; when await returns for a parent question, it should reply and await again. Completed start and await cards collapse to name, profile/model, reasoning effort, and a humanized status; expanded cards and model-facing results show selection source, candidate index, reason, skipped candidates, and policy warning. Selection provenance distinguishes an explicit backend+model override from a backend-only launch, which states that the parent session model was inherited (`pi`) or that Claude CLI defaulted to the `sonnet` alias (`claude-cli`). Partial launch failures remain compact. Await headers say “Waiting for all agents” or “Waiting for first agent,” summarize finished and active states without exposing API tokens, and shift from warning to success or error as the fleet settles. Each await row shows the same agent name, model, reasoning effort, and status fields as the start result, with the colored effort value directly beside the model. Running agents use the same fixed-width Braille spinner in await cards and the fleet UI without moving rows; timeout, cancellation, and first-finished returns clearly state which agents continue running. Responsive summary rows align name, model, effort, and status on wide terminals, color effort with Pi’s thinking palette, truncate model IDs first on narrow terminals, and hide fleet run IDs unless technical mode is enabled. A `▸ final reports` affordance marks expandable output; expanding it renders bounded final reports as Markdown without exposing run IDs or the broader metadata block. The await call updates one live tool card and returns selected final reports together; Escape cancels only the wait, and an optional timeout leaves children running while preserving exact pending questions and reply recovery instructions. Reports returned in full by `subagent_await` or `subagent_status` are acknowledged and are not injected again. Reports clipped by the aggregate tool-output budget remain eligible for automatic delivery and can also be fetched individually. Unclaimed completions are batched briefly, split into bounded messages when necessary, and steered into an active orchestration run instead of accumulating as post-run follow-ups. Only successfully delivered generations are acknowledged; failed completion, question, and warning delivery retries use exponential backoff capped at 30 seconds while the generation remains relevant, and notifier deduplication resets with the parent session. Routine progress remains in the footer and `/subagents`; only questions and warnings enter model context.

The main agent operates the fleet through focused tools with non-overlapping parameter contracts: `subagent_models`, `subagent_start`, `subagent_list`, `subagent_status`, `subagent_await`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, and `subagent_rename`. `subagent_start` always accepts one required `agents` array containing up to twelve independent launch specifications; there is no singular or action-discriminated launch form. Background is the default; one foreground item per call may keep the start call open until the run finishes, pauses, or asks a parent question, and start emits progress after launch while it waits. `subagent_list` has no parameters, while `subagent_status` always requires one or more run IDs. `subagent_await` requires an explicit completion condition and timeout; set `timeoutSeconds: 0` to wait without a timeout. `subagent_lifecycle` groups only the structurally identical interrupt, resume, and stop operations. Every launch specification must set `backend` explicitly: use `backend: "auto"` for deterministic profile routing, `backend: "pi"` for Pi RPC, or `backend: "claude-cli"` to launch the installed `claude -p`. `subagent_models` accepts an optional `profile` filter and prints profile routing followed by accepted explicit selector lines (`backend=… model=…`) whose values `subagent_start` accepts verbatim; profile candidate eligibility is evaluated with each profile's default context and the output states that an explicit launch-time `context` override (for example `oracle` with `context: "fresh"`) can change which candidates are eligible. Every whitespace-separated model search term must match, so extra terms narrow results, and an optional `backend` parameter filters one concrete backend. Output marks when matches were actually truncated at the 100-result cap so the caller can narrow its search, preserves the requested selector and profile routing before verbose sections, always states each profile fallback, and bounds every model-visible tool result to 48,000 characters with an explicit narrowing marker. Claude selector lines are omitted for untrusted projects; when present, they remain accepted static selectors rather than an executable/authentication/model-availability guarantee. Pi model values are canonical `provider/model`; a bare model ID launches only when it identifies exactly one authenticated provider, an ambiguous bare ID fails listing every canonical candidate, and unknown selectors fail with near matches. Claude model values may use a Claude CLI alias such as `fable`, `sonnet`, `opus`, or `haiku`, or a full Claude model ID beginning with `claude`; aliases track the installed CLI's current mapping, so requesting an exact Claude version requires its full model ID — it is never silently mapped to an alias. Supplying a Pi selector to `claude-cli` (or a forked context or `off`/`minimal` effort) fails before any spawn, and per-agent launch failures carry machine-actionable `code` values alongside their messages. Claude runs require a trusted project because print mode skips Claude's workspace trust dialog, and the first `claude-cli` launch in the extension process runs a cached, single-flight `claude auth status --json` preflight that checks only executable presence and CLI authentication. Only an explicit, unambiguous positive auth result succeeds and is cached; empty, malformed, or ambiguous exit-zero output fails closed with `claude_cli_preflight_failed`, explicit negative auth produces `claude_cli_unauthenticated`, and other non-zero exits include CLI compatibility guidance. Pi read-only runs allow `read`, `grep`, `find`, `ls`, `web_search`, `fetch_content`, and `get_search_content`; they do not receive shell or extension tools whose mutation behavior cannot be proven. Claude read-only intent likewise prevents local mutation and shell access, but its allowlist still permits `WebFetch` and `WebSearch`, so neither backend's read-only mode prohibits outbound network access. Claude stream-json startup writes the initial task frame before awaiting `system/init`, because the CLI does not emit initialization until it receives input. Startup then verifies the CLI's complete role-specific resolved tool set for both read-only and writer runs before it is accepted and fails closed on missing or unexpected capabilities. One fresh-process retry is reserved for transient spawn, stream-initialization, or readiness failures before task-submission outcome becomes uncertain; policy, authentication, model, permission, and rate-limit failures are not retried. Automatic routing also stops falling through once the selected candidate reaches service start. Resume cleanup waits are bounded to ten seconds, capacity errors distinguish active saturation from slots that are temporarily finishing cleanup, and each launch updates its stored metadata after a later rename so respawn keeps the current name.

Phase 1 Claude runs intentionally do not expose `contact_parent`, mid-turn steering, interruption, or Pi-session forks. Those operations return typed unsupported-capability failures with applicable `subagent_status`, `subagent_await`, or `subagent_lifecycle` recovery guidance. Multi-target guidance and lifecycle calls return successes and failures per run rather than hiding partial application. Failure codes are included in model-visible text, and ambiguous send, reply, interrupt, resume, or writer-start outcomes use operation-specific `*_outcome_uncertain` codes. The service does not retry or roll back an operation that may already have applied; the parent checks status before deciding whether another action is safe. The optional `subagent_lifecycle.message` field is accepted only for `action: "resume"`. Parent contact is reserved for a later authenticated MCP bridge. Claude subscription limit events are decoded separately from result errors and correlated by limit key and turn: utilization updates remain visible in fleet status, while the parent transcript is notified only when a limit window first crosses 80%, 90%, or 95%, when paid-overage continuation begins, and on actual rejection. `overageStatus: "rejected"` does not fail an otherwise allowed request. A limit-hit event remains non-terminal when paid overage is active or available; only `status: "rejected"` combined with unavailable overage starts the rejection grace period. Ambiguous events defer to the CLI's authoritative result rather than terminating usable Claude sessions. An actual no-overage rejection waits briefly for that result before failing and terminating an otherwise-hung turn with its limit type and reset details. Terminal result decoding keeps the `result` discriminant strict while tolerating optional-field drift and clipping oversized final text to the bounded report limit. Pi RPC and Claude NDJSON share a UTF-8-safe line room that bounds individual frames and aggregate queued bytes, then flushes decoder tails and final unterminated frames at EOF.
