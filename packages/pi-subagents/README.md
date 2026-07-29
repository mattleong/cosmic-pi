# pi-subagents

Session-scoped foreground and background subagents for pi.

## Features

- Seven deterministic task profiles: `scout`, `researcher`, `planner`, `worker`, `reviewer`, `oracle`, and `delegate`. Profiles inject concise role guidance and route an ordered model policy without heuristic scoring.
- Short-form automatic launch with only `task` and optional `profile`: `subagent_start` has no model field, so the configured profile route (or `defaultProfile`) is host-enforced.
- Fresh or forked child contexts resolved per route candidate. Only `oracle` prefers forked context; every other profile prefers fresh. Pi supports both modes, while Claude currently supports fresh only. An omitted context adapts an unsupported profile preference to fresh; an explicit context remains a hard requirement.
- Parent-model inheritance with role-specific profile effort defaults. Every launch resolves the selected profile's configured route; no agent-facing per-launch model override exists.
- One static, preflight-only discovery surface: `subagent_models` shows the configured default profile, profile descriptions, context/write-intent/effort defaults, and each ordered candidate's eligibility and effective context. Runtime authentication and readiness are checked only at launch.
- Deterministic configured-route resolution. Profile candidates use `parent`, `pi/<provider>/<model-id>`, or `claude-cli/<alias-or-full-id>`; unknown or unauthenticated candidates are skipped in declared order before any process spawn.
- A process-cached, concurrent-call-deduplicated Claude CLI preflight (`claude auth status --json`) verifies executable presence and authentication before the first `claude-cli` launch, while distinguishing explicit logout from incompatible or failed probes.
- Pi writers inherit parent tools except recursive orchestration tools; Pi read-only children receive a conservative inspection-only allowlist. Claude children use explicit native read-only or writer tool policies.
- Optional human-readable names and immutable run IDs allocated from an opaque per-runtime namespace, so replacing a session runtime never reuses an ID from the abandoned fleet.
- Canonical `subagent_start` launches one to twelve profile-routed agents from one required `agents` array and structurally rejects `model`. Successful launches remain active when a peer item fails, and at most one foreground item is allowed per call.
- Fleet-level `await` collection with live, state-color-coded per-agent progress and semantic `all_finished` or `any_finished` completion conditions. Await returns early with an exact `subagent_reply` call when a Pi child needs parent input; after replying, the parent awaits again. A finished run is completed, failed, or stopped.
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

Built-in profiles are deliberately model-neutral. With no configuration, each profile explicitly falls back to the active parent Pi model; no profile guesses a provider or model alias. Profiles set role-specific write-intent and reasoning defaults. `worker` defaults to `writer`; every other built-in defaults to `read-only`. `delegate` remains closest to the parent and inherits its effort. `subagent_start` always uses profile routing, and an omitted `profile` uses `defaultProfile`, which defaults to `delegate`.

| Profile      | Intended work                                   | Default context | Default intent | Default effort |
| ------------ | ----------------------------------------------- | --------------- | -------------- | -------------- |
| `scout`      | Fast local codebase reconnaissance              | fresh           | read-only      | low            |
| `researcher` | Focused external research with sources          | fresh           | read-only      | medium         |
| `planner`    | Concrete implementation planning                | fresh           | read-only      | medium         |
| `worker`     | Focused implementation and validation           | fresh           | writer         | high           |
| `reviewer`   | Independent evidence-based review               | fresh           | read-only      | high           |
| `oracle`     | Inherited-decision analysis and drift detection | fork            | read-only      | high           |
| `delegate`   | General delegated work                          | fresh           | read-only      | inherit        |

A default context is a profile preference when a launch omits `context`, not a promise that every backend implements that mode. Each route candidate resolves its own effective context: Pi candidates retain the profile preference, while a Claude candidate adapts an omitted `fork` preference to `fresh`. An explicitly supplied context is hard, so explicit `fork` skips Claude candidates and requires a persisted Pi parent leaf. Fork-capable Pi candidates never degrade to fresh merely because the parent leaf is unavailable. Mixed routes may therefore contain candidates with different effective contexts, and the selected attempt's context is preserved in run metadata.

Global configuration is read from `<agent-dir>/pi-subagents.json`. A trusted project may override it at `<cwd>/<CONFIG_DIR_NAME>/pi-subagents.json` (`CONFIG_DIR_NAME` is normally `.pi`). Untrusted project configuration is never read. Use `/subagents profiles` in TUI mode to edit normal single-candidate routes; ordered routes remain JSON-managed in the scope that declares them, while project scope can still override an inherited global ordered route with a local single-candidate route, `disabled`, or inherit.

```json
{
  "version": 2,
  "defaultProfile": "delegate",
  "denied": [{ "backend": "claude-cli", "model": "haiku" }],
  "discouraged": [{ "backend": "pi", "model": "provider/legacy-model" }],
  "profiles": {
    "reviewer": [
      { "model": "claude-cli/fable", "effort": "high" },
      { "model": "pi/provider/review-model", "effort": "xhigh" }
    ],
    "worker": { "model": "parent", "effort": "default" },
    "scout": "disabled"
  }
}
```

A profile value is exactly one candidate object, an ordered non-empty array of candidate objects, or `"disabled"`. Every candidate requires `model` and `effort`. Model selectors are exactly `parent`, canonical `pi/<provider>/<model-id>`, or `claude-cli/<alias-or-full-id>`. Effort is one of `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`. `default` uses the profile's built-in effort, then the parent effort when that profile has no built-in default; it is soft. Every concrete configured effort and every per-launch effort override is hard.

Missing global routes use `{ "model": "parent", "effort": "default" }`. Missing project routes inherit the complete global route. Any present-invalid route fails closed as disabled for that scope and profile. Candidate order is authoritative and candidates are tried only during pre-start checks; routing never falls through after service start. `"disabled"` has no candidates and deterministically returns `profile_no_eligible_model`. Project `denied` and `discouraged` entries remain additive. Denied candidates are skipped; a discouraged candidate deliberately saved in a profile route remains launchable with a visible warning.

Configuration accepts at most 256 policy selectors, 32 candidates per route, and 256 characters per model selector. Every existing document must declare numeric `version: 2`; v1 and versionless documents are intentionally unsupported and are not migrated. Invalid JSON or an unsupported version fails activation closed with a path-safe error. Project configuration is read and written only when the host trust callback returns literal `true`. Fix the document and run `/reload`.

Examples:

```json
{
  "agents": [
    {
      "task": "Review the authentication changes",
      "profile": "reviewer"
    }
  ]
}
```

This form is accepted by `subagent_start` and always uses the reviewer profile's project/global route. To change its model, edit the reviewer route through `/subagents profiles` or configuration and reload; the launch tool itself never accepts `model`.

## Commands

- `/subagents` opens the responsive fleet inspector in interactive TUI mode.
- `/subagents profiles` opens TUI-only Global/trusted-Project profile settings, shows both scope paths, and saves one staged single-candidate edit atomically before offering reload. Escape moves back one step (effort → model → profile → scope) instead of abandoning the whole flow; the model picker keeps the active profile, scope, and settings path visible.

Fleet controls:

- `j` / `k` or arrow keys select a run.
- `Ctrl-U` / `Ctrl-D` (`C-u` / `C-d` in the footer) scroll up and down through the selected run's session output while preserving live tail-follow at the bottom.
- `Enter` toggles details in narrow layouts.
- `t` toggles technical details such as run ID, PID, cwd, and session file.
- `?` switches between navigation keys and contextual actions when the terminal cannot fit both.
- The responsive footer groups navigation, selected-agent actions, and global controls with `│`; capability-aware hints hide unsupported `m`, `i`, `r`, `n`, and `x` actions.
- Stopping requires two `x` presses on the same selected run. Changing selection or pressing `Esc` cancels the pending confirmation.
- `Esc` closes the inspector when no stop confirmation is pending.

Structured session output groups adjacent repeated tools while retaining compact target summaries, wraps long targets and paths, shows state-specific idle messages and completion age, and labels child output neutrally as **Final report** without claiming parent delivery. `subagent_list` returns a compact fleet listing, while `subagent_status` returns labeled metadata without activity history for selected runs and reports stale IDs without discarding valid peers; full activity remains in `/subagents`. The main agent should use `subagent_await`, rather than polling status, after its independent work is finished; when await returns for a parent question, it should reply and await again. Completed start and await cards collapse to name, profile/model, reasoning effort, and a humanized status; expanded cards and model-facing results show selection source, candidate index, reason, skipped candidates, and policy warning. Selection provenance records the selected profile candidate, its configured index, prior skipped candidates, and any policy warning. Partial launch failures remain compact. Await headers say “Waiting for all agents” or “Waiting for first agent,” summarize finished and active states without exposing API tokens, and shift from warning to success or error as the fleet settles. Each await row shows the same agent name, model, reasoning effort, and status fields as the start result, with the colored effort value directly beside the model. Running agents use the same fixed-width Braille spinner in await cards and the fleet UI without moving rows; cancellation and first-finished returns clearly state which agents continue running. Responsive summary rows align name, model, effort, and status on wide terminals, color effort with Pi’s thinking palette, truncate model IDs first on narrow terminals, and hide fleet run IDs unless technical mode is enabled. A `▸ final reports` affordance marks expandable output; expanding it renders bounded final reports as Markdown without exposing run IDs or the broader metadata block. The await call updates one live tool card and returns selected final reports together; Escape cancels only the wait and leaves children running while preserving exact pending questions and reply recovery instructions. Reports returned in full by `subagent_await` or `subagent_status` are acknowledged and are not injected again. Reports clipped by the aggregate tool-output budget remain eligible for automatic delivery and can also be fetched individually. Unclaimed completions are batched briefly, split into bounded messages when necessary, and steered into an active orchestration run instead of accumulating as post-run follow-ups. Only successfully delivered generations are acknowledged; failed completion, question, and warning delivery retries use exponential backoff capped at 30 seconds while the generation remains relevant, and notifier deduplication resets with the parent session. Routine progress remains in the footer and `/subagents`; only questions and warnings enter model context.

The main agent operates the fleet through nine focused tools: `subagent_models`, `subagent_start`, `subagent_list`, `subagent_status`, `subagent_await`, `subagent_send`, `subagent_reply`, `subagent_lifecycle`, and `subagent_rename`. `subagent_models` accepts only an optional `profile` filter and reports profile-route defaults, candidate eligibility, and effective candidate context; it is not a free-model catalog. `subagent_start` accepts one required `agents` array containing up to twelve independent profile-routed specifications. Every item requires only `task`; `profile` defaults to configured `defaultProfile`, write intent and effort use profile/candidate defaults unless deliberately overridden, and omitted context is resolved from the profile preference plus backend capability. An explicit context is a hard requirement. The item schema, execution validation, and host resolution each reject `model` and `backend` for stale or internal call shapes; host resolution then selects `profile ?? defaultProfile` before evaluating that profile's ordered route. A user request naming a model therefore cannot change one launch; the route must be changed in profile configuration.

Profile candidate selectors include both backend and provider where applicable, so duplicate Pi model IDs are never guessed across providers. Claude candidates may use `claude-cli/fable`, `sonnet`, `opus`, `haiku`, or a full Claude model ID beginning with `claude`; aliases track the installed CLI's current mapping, so exact-version routing requires a full ID. Omitted context is resolved per candidate, while an explicit per-launch context or effort can make a configured candidate ineligible; neither can introduce a model outside the selected profile route. Denied, unavailable, unauthenticated, context-incompatible, effort-incompatible, and preflight-failing candidates are skipped before service start; deliberately configured discouraged candidates remain eligible and carry a visible warning. Once a candidate reaches `SubagentService.start`, routing never falls through to another candidate. Every launch failure includes a machine-actionable code alongside its message, and all model-visible tool results are bounded to 48,000 characters.

Phase 1 Claude runs intentionally do not expose `contact_parent`, mid-turn steering, interruption, or Pi-session forks. Those operations return typed unsupported-capability failures with applicable `subagent_status`, `subagent_await`, or `subagent_lifecycle` recovery guidance. Multi-target guidance and lifecycle calls return successes and failures per run rather than hiding partial application. Failure codes are included in model-visible text, and ambiguous send, reply, interrupt, resume, or writer-start outcomes use operation-specific `*_outcome_uncertain` codes. The service does not retry or roll back an operation that may already have applied; the parent checks status before deciding whether another action is safe. The optional `subagent_lifecycle.message` field is accepted only for `action: "resume"`. Parent contact is reserved for a later authenticated MCP bridge. Claude subscription limit events are decoded separately from result errors and correlated by limit key and turn: utilization updates remain visible in fleet status, while the parent transcript is notified only when a limit window first crosses 80%, 90%, or 95%, when paid-overage continuation begins, and on actual rejection. `overageStatus: "rejected"` does not fail an otherwise allowed request. A limit-hit event remains non-terminal when paid overage is active or available; only `status: "rejected"` combined with unavailable overage starts the rejection grace period. Ambiguous events defer to the CLI's authoritative result rather than terminating usable Claude sessions. An actual no-overage rejection waits briefly for that result before failing and terminating an otherwise-hung turn with its limit type and reset details. Terminal result decoding keeps the `result` discriminant strict while tolerating optional-field drift and clipping oversized final text to the bounded report limit. Pi RPC and Claude NDJSON share a UTF-8-safe line room that bounds individual frames and aggregate queued bytes, then flushes decoder tails and final unterminated frames at EOF.
