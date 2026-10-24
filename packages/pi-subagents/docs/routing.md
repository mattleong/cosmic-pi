# Routing, candidate planning, and the public launch contract

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and invariants.

## Version-6 routing and nesting domain

Only configuration version 6 is accepted. Any other version fails activation and store writes, and documents are never rewritten automatically. Every other invalid field degrades instead of failing activation, and each leaves a path-only diagnostic in the activation log and `/subagents doctor` (diagnostics redact profile-set and agent names). Ordinary fields are ignored: an unknown root key, and an invalid `delegation`, which inherits from the next scope or the default. Safety controls fail closed, to their most restrictive setting rather than a looser inherited one:

- a `nesting` limit takes its minimum ([Nesting](#nesting-and-capacity));
- an invalid `writerWorkspaceMode` becomes `worktree`;
- an invalid `WorktreeCreate` declaration fails every tree's setup ([Worktree hooks](local-backends.md#worktree-hooks)).

### Profile sets

- Global and trusted-project documents each own up to 32 scope-local named `profileSets`, and an optional `defaultProfileSet` selects the document's active set. Global and project set names never share identity.
- Set names are 1–64 characters, start and end with a letter or number, and may otherwise contain letters, numbers, spaces, `.`, `_`, or `-`. Each set has a required `profiles` object, which may be empty.
- Resolution starts from built-ins, overlays the selected global set route by route, then the selected trusted-project set. Omitting a global default selects built-ins; omitting a project default selects the global layer.
- A malformed or missing declared default fails that scope's routes closed while leaving configuration inspection available for repair. A present-invalid route fails closed.
- A complete in-memory session route overlays the persistent result with source `session`; removing it reveals the activation-time base again ([Current Session](settings-workspace.md#current-session)).
- Every built-in is a local Pi `parent` candidate using the profile's context, write-intent, and effort defaults.

### Routes and candidates

A route is exactly `"disabled"`, one candidate, or an ordered array of 1–32 candidates. Candidate fields:

- `runtime`: `pi`, `claude`, or `codex`.
- `model`: a native selector. Pi uses `parent` or canonical `provider/model`, including registry `@` context variants such as `cursor/gpt-5.5@1m`.
- `effort`: `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `context`: `fresh` or `fork`.
- `writeIntent`: `read-only` or `writer`.
- `openaiFastMode`: optional, default false. When true, eligible Pi or Codex candidates request OpenAI's `priority` service tier.

Native selectors share one fail-closed 256-character grammar across configuration, settings, and all adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, plus Claude's exact long-context suffix such as `[1m]`.

Cross-field decoding rejects:

- fork or `parent` model selection outside local Pi;
- fast mode for Claude, for an explicit Pi selector outside the `openai` and `openai-codex` providers, or for malformed Codex syntax. Pi `parent` is checked against the active model, and Codex `priority` support against the authenticated catalog, at launch;
- unknown candidate keys, runtime-incompatible effort, and malformed selectors.

### Profiles

Only the seven declared profile IDs are accepted. An explicit launch profile always wins, and an omitted profile resolves to `generalist`. The main agent chooses the profile by deliverable; the profile determines the route.

### Nesting and capacity

- The built-in `nesting` is `{ maxDirectChildren: 12, maxDepth: 3, maxActiveRuns: 16 }`. Each field is optional and merges over the scope below it. Direct children are an integer from 1 to 32, depth from 0 to 8, and `maxActiveRuns` from 1 to 64. A configured fraction is floored and a number outside the bounds clamped; a value that isn't a number takes the field's minimum, and a `nesting` value that isn't an object takes every minimum. Unknown keys are ignored.
- Policy precedence is Session, trusted Project, Global, then built-in. A start batch captures one route and policy revision.
- Admission counts active direct children and reservations for one parent, then active processes across the tree against `maxActiveRuns` (`tree_capacity`).

Optional root `agents` declares [custom agents](#custom-agents) in global and trusted-project documents.

Optional root `delegation` follows the same precedence ([Delegation settings](settings-workspace.md#delegation-settings)). Optional root `hooks` declares `WorktreeCreate` and `WorktreeRemove` commands in global and trusted-project documents; both scopes run, global first ([Worktree hooks](local-backends.md#worktree-hooks)).

### Session usage

- The footer shows the session's known subagent cost, which includes evicted runs and earlier runtimes: each run's usage is appended as a `pi-subagents-usage` custom session entry (never sent to the model) when its assignment settles and when the runtime ends. `/reload`, `/tree`, and resume restore the sum across every branch, because navigating back refunds nothing. A fork keeps the entries on its path.
- Usage since a run last settled is lost if Pi crashes, and Codex reports no cost, so the total is a lower bound.

## Custom agents

A custom agent is a named role the user declares in a configuration document's root `agents` object. It routes through one profile's configured route but replaces that profile's guidance with its own instructions. Agents live only in `pi-subagents.json`; there are no agent files, no session scope, and no settings editor.

```json
"agents": {
  "auth-reviewer": {
    "description": "Reviews authentication changes against the threat model.",
    "instructions": "Review only authentication code. Cite file and line for every finding.",
    "profile": "reviewer",
    "effort": "xhigh",
    "tools": { "deny": ["bash"] }
  }
}
```

### Declaration

- Names match `^[a-z][a-z0-9-]{0,47}$` and can't be a profile ID. A document holds at most 32 agents. A name is the agent's identity across the Global and Project documents and in launches, so a name such as `code_reviewer` fails closed instead of being rewritten to one that could match, or be shadowed by, another entry.
- `description` and `instructions` are required and nonblank. A description longer than 200 characters is cut to 200, with diagnostic `agents[i].description`, and the agent still applies. Instructions hold up to 128 KiB of UTF-8, like a task; longer ones fail the entry closed, since cutting them would change what the agent does.
- `profile` selects the route and defaults to `generalist`. Optional `effort` (a concrete level, not `default`), `context`, and `writeIntent` override every candidate of that route; `isolation` is the agent's writer workspace mode, so an agent with `writeIntent: "read-only"` can't set it (the entry fails closed with diagnostic `agents[i].isolation`).
- `tools: { allow?, deny? }` lists root tool names. `allow` keeps only those tools and `deny` removes tools, applied to the Pi child's inherited active-tool snapshot. The child's own `agent_*` tools, `agent_contact_parent` included, are always kept. Read-only intent wins over `allow`: a read-only run never gets `edit` or `write`, and its start entry warns when `allow` names them.
- Unknown keys are rejected. Diagnostics identify entries by position, like profile sets.

### Layering and failure

- A trusted-project entry replaces the same-named global entry wholesale; fields never merge. An untrusted project's agents are ignored.
- An entry with a valid name that fails to decode fails that name closed (`agent_invalid`) instead of revealing a lower entry. A malformed name is ignored with a diagnostic.
- An `agents` value that is not an object of at most 32 entries fails its document's agents closed. A malformed project `agents` object also hides every global agent, since it could have replaced any of them.

### Launch planning

- `agent_start` items take `agent` instead of `profile`; setting both fails with `agent_profile_conflict`. Unknown names fail with `agent_unknown`.
- The start item's `agent` choices and their descriptions are generated when the root registers its tools, and the field is absent when no agents are configured. Nested Pi children accept any agent name and the root resolves it.
- Planning applies the agent's overrides to each candidate before the usual checks. A candidate the overrides don't fit, such as fork context or an unsupported explicit effort on Claude or Codex, is skipped with `agent_candidate_incompatible`.
- Tool lists can only be enforced on a Pi child, so Claude and Codex candidates are skipped with `agent_tools_unsupported` whenever an agent sets `allow` or `deny`. There is no unfiltered fallback.
- An item's `isolation` wins over the agent's; the agent's wins over the session default. When the selected candidate is read-only, a requested `worktree` from either one fails with `isolation_requires_writer` before admission: a read-only run keeps write-capable tools, so dropping the worktree would silently remove its protection. A requested `shared-checkout` asks for nothing stronger, so the launch ignores it and starts read-only, with a launch warning in its start entry and card.
- A [model override](#per-launch-model-override) launched with an agent takes the agent's effort, context, and write intent defaults, and fails with `model_override_invalid` when the agent's tool lists need Pi.
- The child's system prompt names the agent and carries its instructions in place of the profile guidance. Run cards, start entries, status, and the orchestration contract report `agent` alongside the routed `profile`.

## Candidate planning and host resolution

- Pure planning preserves declared order and resolves Pi model catalog and auth compatibility. The host boundary records typed skips in launch provenance and continues to the next candidate.
- The registry performs bounded executable, auth, model-effort, write-policy, and private-harness readiness before owning a run scope, lease, supervisor channel, or process. Once `SubagentService.start` begins, only a [startup fallback](#startup-fallback) moves on; lease, spawn, transport, control, and admission errors never fall through. There is no derived local fallback.
- Parent-model selection, inherited `generalist` effort, fork headroom, and fork session identity come from the immediate parent, not the root. The Pi child bridge captures live native facts at each proxy call outside the public arguments; the coordinator binds them to the authenticated run record and checks the registered session before planning.
- A parent without a stable native Pi branch cannot fork; it never borrows the root transcript. Registry, authentication, project trust, and the active-tool allowlist stay root-owned.
- Claude Code's zero-inference initialize response resolves aliases at selected startup, but entitlement can still fail after selection. Such a failure falls through only as a [startup fallback](#startup-fallback), before the task is issued.

### Startup fallback

A profile-routed launch whose startup fails before its task is issued, on a listed startup failure, continues on the frozen plan's next candidate in the same run. `run/candidate-fallback.ts` owns the rules.

- **Issued.** The task is issued when the run's assignment leaves `preparing` for `issuing`, just before the backend's start control: Pi's `prompt` RPC, Claude's stream-input user message, or Codex's `turn/start`. Until then a backend has only its launch configuration and zero-inference initialization (Pi `get_state`, Claude `initialize` and its non-querying probe, Codex `initialize` and `thread/start`), so no task side effect can exist. Any failure after it, and a stop, never falls back.
- **Candidate failures** move to the next candidate: the runtime can't run the candidate's model, effort, or service tier, or refused to initialize with them (`pi_model_not_found`, `pi_model_mismatch`, `pi_effort_unsupported`, `claude_model_mismatch`, `initialize_rejected`, `codex_model_mismatch`, `codex_service_tier_mismatch`).
- **Runtime failures** move past every remaining candidate on that runtime, each skipped with `runtime_startup_failed` and no probe, since they would fail the same way: the process exited during startup, or its handshake or private supervisor server failed (`local_claude_exited`, `claude_initialize_invalid`, `claude_native_init_missing`, `claude_native_init_invalid`, `mcp_status_rejected`, `claude_mcp_status_invalid`, `claude_supervisor_mcp_unavailable`, `claude_supervisor_tools_missing`, `local_codex_exited`, `codex_request_rejected`). Two are bounded waits that expired, for Claude's native init event and its supervisor server's connection, so a route waits each out at most once per runtime.
- **Never eligible.** A correlated request that timed out or whose send was uncertain (`*_outcome_uncertain`), unconfirmed cleanup, and request, admission, capacity, cancellation, transport, and uncoded failures end the start. The backend's own recorded failure classifies an attempt before the start error it caused.
- **Between attempts.** The failed candidate's scope closes and its processes must be confirmed gone; its private run state, such as a forked transcript copy, is reclaimed before another backend can take the run. A stop, runtime shutdown, or closed session ends the chain, checked before the route lookup, before the service's preflight, and at install. The host continues the same plan with the same model resolution and readiness probes, skipping candidates that fail them and a failed runtime's candidates as above. The service then repeats its own preflight, and a candidate failing it is skipped the same way. Admission is rechecked under the run lock.
- **Stops.** A probe whose cleanup or outcome couldn't be confirmed (`*_cleanup_unconfirmed`, `*_outcome_uncertain`), at the host or the service, ends the chain without probing further: the run fails with that probe's error, lists its candidate as skipped, and names no next candidate. A candidate with another write intent ends the chain, since admission and workspace ownership were decided for the first; the run names it as its next candidate. A failed route lookup or run-state reclaim also ends it. Each stop records its reason in a system warning and in the final failure.
- **One run.** The run keeps its ID, assignment, workspace, writer-pool membership, usage, and history; its scope, backend, capabilities, launch, route fields, and next candidate follow the new candidate. A writer's pool membership, and with it the cross-process lease, passes to the next candidate without being released; its cleanup stays pending meanwhile, and a stop, shutdown, or the start's failure releases it. Each failed candidate joins `selection.skippedCandidates` with its code and reason, and a system warning naming every one appears in the start result, run card, notices, and `agent_read`.
- **Final failure.** The run settles once, so the start-failure hold reports it once, on the route candidate the run last tried. After a fallback or stop its error leads with the last failure, or an unconfirmed probe's, names each candidate tried, and says why fallback stopped. When no later candidate passes planning and preflight, the run lists them as skipped and names no next candidate.

### Effort

- An explicit `effort` is strict: an unsupported level skips the candidate or fails its launch.
- `default` takes the profile's default, else the parent's thinking level (`generalist` inherits the parent's and falls back to `high`). Profile defaults win: oracle stays `high`.
- Planning moves a default to the nearest supported level, the way Pi clamps thinking: the next higher, else the next lower. An inherited `off` becomes `low` for Claude and `minimal` for Codex; a planner's `xhigh` becomes `high` on a Pi model without `xhigh` or `max`.
- Claude and Codex catalogs aren't consulted at launch. Codex excludes delegation-enabling and unknown effort values.

### Provenance and start details

- Selection provenance records the route source (`override` for a [model override](#per-launch-model-override)); the actual runtime and `openaiFastMode` stay in the request and run view.
- Run cards keep the direct runtime, model, and effort, and record each skipped candidate's runtime, model, and effort as structured fields.
- Start details contain one request-ordered entry per input: the requested profile with the actual route for success, the attempted route after post-selection failure, or an explicit resolving or no-eligible-route state. They contain no cards.
- When a start admitted a run and then failed, compensation crosses the full process, backend, harness, supervisor, and writer cleanup barrier before returning. Its `admittedRun` projection reports the run ID, cleanup disposition, and the frozen route's [next candidate](#explicit-route-continuation), taken from settled facts rather than error text.
- Each start batch captures one immutable profile snapshot, so concurrent edits can't split a batch across revisions.

## Per-launch model override

A root start item's optional `model: { runtime, model, effort? }` replaces the profile's route for that launch with one candidate. It is always available to the root; there is no configuration switch. Nested children's start schema omits it.

- The profile still supplies the role guidance, context, and write intent, or a [custom agent](#custom-agents) its instructions and overrides. Fast mode is off. An omitted `effort` is `default`, resolved like a route candidate's ([Effort](#effort)).
- Before any readiness check or service ownership, the override is checked with the shared selector grammar and candidate cross-field policy. A malformed selector, `parent` outside Pi, a runtime-incompatible explicit effort, or a forking profile such as `oracle` on Claude or Codex fails with `model_override_invalid`.
- Planning and the full host preflight then run as for any candidate. Any skip fails the launch with `model_override_unavailable`; the profile's route is never tried.
- Selection provenance records route source `override`. An override that names one of the profile's route candidates, by runtime, selector, and effort (or selector alone when it omits effort), freezes that route at the candidate, so a failed run still names the [next candidate](#explicit-route-continuation) after it. Any other override freezes a route of itself alone and names no further candidate.
- Start entries, run cards, and status show the requested override as `modelOverride` alongside the actual route.

## Explicit route continuation

A launch freezes its route, the declared candidates and the one it selected, so later edits never change what a failed run reports. Only a [startup fallback](#startup-fallback) moves a run to another candidate, and only before its task is issued; resume continues the failed run's own session on the same candidate ([resume admission](#resume-admission)).

- A failed root child's run block, completion notice, and `agent_read` card name the frozen route's next candidate, `Next candidate: runtime/model:effort; start a new run with that model`, or say the route has no further candidates. A start that admitted a run and then failed names it in its recovery line.
- The parent decides. A new run on that candidate is an ordinary launch with a [model override](#per-launch-model-override), its own task, and a new run ID; its planning and preflight check the candidate, which the hint doesn't. That override never falls back, but if it fails it names the route's next candidate in turn.
- Only root children get the hint, because nested start items take no model. Unresolved guidance delivery suppresses it, since the run may have acted on that guidance.
- Writers may have left partial side effects, and a worktree writer's workspace stays a proposal its parent applies or discards.

## Resume admission

`agent_send({ to, message })` from one of a paused, completed, failed, or stopped run's ancestors, including `main`, continues the run's own session with the message as its next assignment; the Activity manager's resume action does the same for the user. Only local Pi advertises resume.

- Paused runs resume in place. Completed, failed, and stopped runs respawn from their session file once cleanup is confirmed (`resume_cleanup_unsettled` otherwise). A run without continuation state fails with `backend_resume_unavailable`, and the recovery points to a new run.
- An explicit resume overrides an earlier stop; descendants a stop closed stay stopped. An agent message can't resume a run while a stop of that run or one of its ancestors is still in progress (`agent_unavailable`); once that stop finishes, a message resumes it like any other stopped run. Resume refuses a run whose private state was reclaimed or is being evicted, and a run with a full report-delivery backlog.
- Resuming a deterministic failure repeats it; a new run on the [next candidate](#explicit-route-continuation) is the alternative.
- A worktree writer resumes in its own worktree and reopens its review; a worktree that was integrated, discarded (including automatically), or left mid-integration refuses with `workspace_finished`.
- Respawn checks direct-child policy, including held worktree launch slots, under the admission lock. In-place paused resume keeps its slot and is allowed at capacity.
- Writer respawn recanonicalizes the cwd before taking the lock. One locked claim then validates the run, assignment, process, cwd identity, report backlog, writer conflict, capacity, and workspace binding before rollover. Refusal leaves the workspace unchanged ([binding rules](local-backends.md#binding-states-and-resume)).

## Public launch contract

`agent_start` takes one array of agents, up to the caller's direct-child limit. Root calls create children of the virtual depth-0 root; authenticated nested calls create children of the caller's run. Neither schema accepts an ancestry override. Each item has:

- `task`, required;
- `profile`, optional, defaulting to `generalist`;
- `agent`, optional: a [custom agent](#custom-agents), never combined with `profile`;
- `name`, optional display text; launch cuts one longer than 80 characters, and every copy, including a worktree's recorded launch, keeps the cut name;
- `isolation`, optional and root only: `shared-checkout` or `worktree`, for writers only (profile `worker`, or an agent or route with writer intent). When the selected candidate is read-only, `worktree` fails closed with `isolation_requires_writer` and `shared-checkout` is ignored with a start-entry warning, for the item's value and a [custom agent](#launch-planning)'s alike;
- `model`, optional and root only: a [per-launch model override](#per-launch-model-override). Nested children launch on profile routes, because only the root talks to the user who asks for a model.

The schema is strict, and the service independently rejects other launch overrides, such as a top-level `effort`, `context`, or `writeIntent`, with `launch_override_not_allowed`. Model-facing schemas declare no `pattern` keyword, which some providers reject. Task-tool-shaped top-level fields fail with `[invalid_start_shape]` instead of being renamed.

A root writer's workspace mode is, in order: the item's `isolation`, a custom agent's `isolation`, then the session's `writerWorkspaceMode` (default `shared-checkout`). Admission records the mode. Only the root starts worktree writers: nested start items take no `isolation`, a nested writer shares its caller's checkout or worker tree, and one whose custom agent sets `isolation: "worktree"` fails with `workspace_nested_writer_unsupported` ([Mode and admission](local-backends.md#mode-and-admission)). Launch and status projections include the mode, workspace identity, actual cwd, and source cwd.

Start is always background and nonblocking. `agent_await` supports `all_finished`, the default, and `any_finished`, for up to 12 runs. `agent_lifecycle` takes `interrupt` or `stop` and up to 32 run IDs, as many as one start launches, never task or route overrides.

### Model-facing guidance

- Tool descriptions state what a tool does and its rules; parameter descriptions state formats and choices, with `profile` choices generated from the definitions; guideline bullets state when to act; tool results carry recovery steps with exact run IDs.
- A start with no runnable candidate (`profile_no_eligible_model` or `backend_not_implemented`) points the user to `/subagents doctor` and `/subagents profiles`. The start guideline forbids running `claude`, `codex`, or `pi` from the shell instead, which would bypass sandbox policy and supervision.
- The root's delegation rule comes from its [delegation mode](settings-workspace.md#delegation-settings). Nested Pi children get a restrained rule and never get `agent_worktree`.
- In every audience the parent keeps working after launch, awaits only at a dependency or synthesis barrier, coordinates rather than edits while shared-checkout writers run, and treats worktree reports as proposals.

### Model discovery

`agent_profiles` projects every resolved candidate as a structured card with `runtime`, `model`, `effort`, `context`, `writeIntent`, `openaiFastMode`, `status`, and `reason`. It also lists each custom agent with its routed profile, overrides, tool lists, and that profile's candidates after the agent's overrides, plus the agents that fail closed. A `profile` filter keeps only agents routed to that profile. Discovery is static: executable, auth, catalog, service-tier, and harness readiness are checked at launch.
