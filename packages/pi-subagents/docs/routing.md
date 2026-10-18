# Routing, candidate planning, and the public launch contract

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and invariants.

## Version-6 routing and nesting domain

Only configuration version 6 is accepted. Any other version fails activation and store writes, and documents are never rewritten automatically. Unknown root keys fail activation, and diagnostics redact profile-set names.

### Profile sets

- Global and trusted-project documents each own up to 32 scope-local named `profileSets`, and an optional `defaultProfileSet` selects the document's active set. Global and project set names never share identity.
- Set names are 1–64 characters, start and end with a letter or number, and may otherwise contain letters, numbers, spaces, `.`, `_`, or `-`. Each set has a required `profiles` object, which may be empty.
- Resolution starts from built-ins, overlays the selected global set route by route, then the selected trusted-project set. Omitting a global default selects built-ins; omitting a project default selects the global layer.
- A malformed or missing declared default fails that scope's routes closed while leaving configuration inspection available for repair. A present-invalid route fails closed.
- A complete in-memory session route overlays the persistent result with source `session`; removing it reveals the activation-time base again ([Current Session](settings-workspace.md#current-session)).
- Every built-in is a local Pi `parent` candidate using the profile's context, write-intent, and effort defaults.

### Routes and candidates

A route is exactly `"disabled"`, one candidate, or an ordered array of 1–32 candidates. Candidate fields:

- `host`: required, `local` only.
- `runtime`: `pi`, `claude`, or `codex`.
- `model`: a native selector. Pi uses `parent` or canonical `provider/model`, including registry `@` context variants such as `cursor/gpt-5.5@1m`.
- `effort`: `default`, `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.
- `context`: `fresh` or `fork`.
- `writeIntent`: `read-only` or `writer`.
- `openaiFastMode`: optional, default false. When true, eligible Pi or Codex candidates request OpenAI's `priority` service tier.
- `closeOnReport`: optional, omitted or `true` only.

Decoding validates `host` and `closeOnReport` and drops them from the routing model; settings writes still spell both out. Native selectors share one fail-closed 256-character grammar across configuration, settings, and all adapter preflights: a leading alphanumeric followed by alphanumerics or `._:/@-`, plus Claude's exact long-context suffix such as `[1m]`.

Cross-field decoding rejects:

- fork or `parent` model selection outside local Pi;
- `host: "herdr"` anywhere in a route, and `closeOnReport: false`;
- fast mode for Claude, for an explicit Pi selector outside the `openai` and `openai-codex` providers, or for malformed Codex syntax. Pi `parent` is checked against the active model, and Codex `priority` support against the authenticated catalog, at launch;
- unknown candidate keys, runtime-incompatible effort, and malformed selectors.

Repair of retired remote or stay-open routes is described in [Explicit configuration repair](settings-workspace.md#explicit-configuration-repair).

### Profiles

Only the seven declared profile IDs are accepted. An explicit launch profile always wins, and an omitted profile resolves to `generalist`. The main agent chooses the profile by deliverable; the profile determines the route.

### Nesting, capacity, and spend

- An omitted `nesting` is `{ maxDirectChildren: 12, maxDepth: 3, maxActiveRuns: 16 }`. Direct children must be an integer from 1 to 32, depth from 0 to 8, and `maxActiveRuns` from 1 to 64. Invalid values fail activation without clamping.
- Policy precedence is Session, trusted Project, Global, then built-in. A start batch captures one route and policy revision.
- Admission counts active direct children and reservations for one parent, then active processes across the tree against `maxActiveRuns` (`tree_capacity`).
- Optional root `sessionSpendLimit` (US dollars, Project over Global) stops new starts with `session_spend_limit` once the session's known subagent cost reaches it.
- That cost includes evicted runs and earlier runtimes: each run's usage is appended as a `pi-subagents-usage` custom session entry (never sent to the model) when its assignment settles and when the runtime ends. `/reload`, `/tree`, and resume restore the sum across every branch, because navigating back refunds nothing. A fork keeps the entries on its path.
- Usage since a run last settled is lost if Pi crashes, and Codex reports no cost, so the total is a lower bound.

Optional root `delegation` follows the same precedence ([Delegation settings](settings-workspace.md#delegation-settings)). Root `workspaceSetup` and `workspaceVerify` are allowed only in a trusted project document ([Setup and verification commands](local-backends.md#setup-and-verification-commands)).

## Candidate planning and host resolution

- Pure planning preserves declared order and resolves Pi model catalog and auth compatibility. The host boundary records typed skips in launch provenance and continues to the next candidate only before service ownership begins.
- The registry performs bounded executable, auth, model-effort, write-policy, and private-harness readiness before owning a run scope, lease, supervisor channel, or process. Once `SubagentService.start` begins, lease, spawn, transport, or control errors never fall through. There is no derived local fallback.
- Parent-model selection, inherited `generalist` effort, fork headroom, and fork session identity come from the immediate parent, not the root. The Pi child bridge captures live native facts at each proxy call outside the public arguments; the coordinator binds them to the authenticated run record and checks the registered session before planning.
- A parent without a stable native Pi branch cannot fork; it never borrows the root transcript. Registry, authentication, project trust, and the active-tool allowlist stay root-owned.
- Claude Code's zero-inference initialize response resolves aliases at selected startup, but entitlement can still fail after selection; that failure doesn't fall through.

### Effort

- An explicit `effort` is strict: an unsupported level skips the candidate or fails its launch.
- `default` takes the profile's default, else the parent's thinking level (`generalist` inherits the parent's and falls back to `high`). Profile defaults win: oracle stays `high`.
- Planning moves a default to the nearest supported level, the way Pi clamps thinking: the next higher, else the next lower. An inherited `off` becomes `low` for Claude and `minimal` for Codex; a planner's `xhigh` becomes `high` on a Pi model without `xhigh` or `max`.
- Claude and Codex catalogs aren't consulted at launch. Codex excludes delegation-enabling and unknown effort values.

### Provenance and start details

- Selection provenance records the route source; the actual runtime and `openaiFastMode` stay in the request and run view.
- Run cards keep the direct runtime, model, and effort, and record each skipped candidate's runtime, model, and effort as structured fields. Older cards with `host`, `closeOnReport`, or label strings still decode; retired fields are ignored and labels display verbatim.
- Start details contain one request-ordered entry per input: the requested profile with the actual route for success, the attempted route after post-selection failure, or an explicit resolving or no-eligible-route state. They contain no cards.
- When a start admitted a run and then failed, compensation crosses the full process, backend, harness, supervisor, and writer cleanup barrier before returning. Its `admittedRun` projection reports the run ID, cleanup disposition, retry disposition, and remaining candidate count, taken from settled facts rather than error text.
- Each start batch captures one immutable profile snapshot, so concurrent edits can't split a batch across revisions.

## Explicit route continuation

`subagent_lifecycle({ action: "retry", runIds })` continues a failed run on its next configured candidate. It is a new launch and run ID, never implicit fallthrough or resurrection.

- It keeps the original task, profile guidance, route source, and a deeply frozen copy of the launch-time route; later edits don't alter it. Planning starts strictly after the predecessor's selected candidate, keeps the original candidate indexes, and repeats the full preflight.
- Retry claims the predecessor exclusively. Exact claims travel with the frozen continuation and are rechecked against current pools. After cleanup is confirmed, admission atomically revalidates, marks the predecessor with its successor ID, and admits the linked run. Concurrent retries have one winner, and retry-claimed records can't be evicted.
- A plan with no remaining candidate records every skip and marks the route exhausted (`retry_route_exhausted`); only then should the parent choose a `generalist` replacement.
- Retry refuses non-failed, later-assignment, already-superseded, exhausted, outcome-uncertain, cleanup-quarantined, eviction-claimed, and concurrently claimed records, so no uncertainty launches duplicate work automatically.
- Writers start a fresh execution and may repeat partial side effects. A worktree writer's successor gets a fresh workspace from its parent's current tree, and the failed writer's workspace stays a proposal. Parent guidance permits writer continuation only when the original handoff and current user intent allow it.
- Claim transfer is acknowledged only after the session-owned commit is forked. Cancellation before transfer releases the claim; afterward it stops only the waiter.
- Successors keep their predecessor's parent, while existing descendants stay attached to the predecessor. Resolution uses that parent's cwd and latest native-fact snapshot, even when the root requests the retry. A changed native session invalidates the captured branch rather than falling back to root context.

## Resume admission

- Completed respawn checks direct-child policy, including held worktree launch slots, under the admission lock. In-place paused resume keeps its slot and is allowed at capacity.
- Writer respawn recanonicalizes the cwd before taking the lock. One locked claim then validates the run, assignment, process, cwd identity, stop state, report backlog, writer conflict, capacity, and workspace binding before rollover. Refusal leaves the workspace unchanged ([binding rules](local-backends.md#binding-states-and-resume)).

## Public launch contract

`subagent_start` takes one array of 1–32 agents, subject to the caller's direct-child capacity. Root calls create children of the virtual depth-0 root; authenticated nested calls create children of the caller's run. Neither schema accepts an ancestry override. Each item has:

- `task`, required;
- `profile`, optional, defaulting to `generalist`;
- `name`, optional;
- `writes`, optional: 1–64 exact, normalized, workspace-relative POSIX file paths. It requires writer intent; read-only candidates are skipped, and the launch fails before ownership when no writer candidate remains. Omission gives a shared-checkout writer exclusive ownership of the cwd. Claims are fixed for the run ([Writer pools](local-backends.md#writer-pools-cooperative-claims-and-cross-process-safety));
- `isolation`, optional: `shared-checkout` or `worktree`. Read-only candidates ignore it.

The schema is strict, and the service independently rejects unknown launch overrides with `launch_override_not_allowed`. Model-facing schemas declare no `pattern` keyword, which some providers reject. Task-tool-shaped top-level fields fail with `[invalid_start_shape]` instead of being renamed.

A writer's workspace mode is, in order: a retry predecessor's recorded mode, the item's `isolation`, `worktree` when the caller is an active Pi worktree writer, then the session's `writerWorkspaceMode` (default `shared-checkout`). Admission records the mode. The root and active Pi worktree writers may start worktree writers; other nested callers fail with `workspace_nested_writer_unsupported` ([Nested worktree writers](local-backends.md#nested-worktree-writers)). Launch and status projections include the mode, workspace identity, actual cwd, and source cwd.

Start is always background and nonblocking. `subagent_await` supports `all_finished` and `any_finished`. Lifecycle `retry` accepts only failed run IDs, never task, model, candidate, or route overrides.

### Model-facing guidance

- Tool descriptions state what a tool does and its rules; parameter descriptions state formats and choices, with `profile` choices generated from the definitions; guideline bullets state when to act; tool results carry recovery steps with exact run IDs.
- A start with no runnable candidate (`profile_no_eligible_model` or `backend_not_implemented`) points the user to `/subagents doctor` and `/subagents profiles`. The start guideline forbids running `claude`, `codex`, or `pi` from the shell instead, which would bypass sandbox policy, claims, and supervision.
- The root's delegation rule comes from its [delegation mode](settings-workspace.md#delegation-settings). Nested Pi children get a restrained rule. Only nested worktree writers get `subagent_workspace`.
- In every audience the parent keeps working after launch, awaits only at a dependency or synthesis barrier, coordinates rather than edits while shared-checkout writers run, and treats worktree reports as proposals.

### Model discovery

`subagent_models` projects every resolved candidate as a structured card with `runtime`, `model`, `effort`, `context`, `writeIntent`, `openaiFastMode`, `status`, and `reason`. Its version-2 orchestration contract also reports `host: "local"` and `closeOnReport: true`. Discovery is static: executable, auth, catalog, service-tier, and harness readiness are checked at launch.
