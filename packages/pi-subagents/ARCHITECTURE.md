# Architecture

`pi-subagents` is an Effect-managed extension for session-scoped, profile-routed background subagents on local Pi, Claude, and Codex, and for dynamic workflows that script them.
This file covers ownership, boundaries, and lifecycle; topic documents hold detailed policy and bounds.

## Topic documentation

- [Routing, candidate planning, and launch](docs/routing.md)
- [Local backends, worktree workspaces, writer pools, and supervisor transport](docs/local-backends.md)
- [Completion, delivery, tool presentation, and Activity](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Dynamic workflows and codemode scripting](docs/workflows.md) and their [internals](docs/workflow-internals.md)

## Lifecycle

- The root Pi session (depth 0) owns one managed runtime for every descendant; nested Pi processes are authenticated proxy clients that construct no application services.
- `src/application/` and `src/layer.ts` compose that runtime in the shared session-runtime slot; only the current slot token may register tools or publish activation state, and `/tree` and `/reload` carry the Current Session profiles across replacement.
- Replacement and shutdown close the run tree leaf-first.
  `WorkflowService` depends on `SubagentService`, so its finalizers run first: Activity publishes stop, deliveries end, and run fibers stop their agents last.

## Ownership

- `src/config/` is the strict version-6 data boundary with one persistence door, `config/store.ts`; `src/profiles/` owns built-ins, named sets, and the revisioned Current Session.
- `src/domain/` holds dependency-free leaf policy: routing vocabulary, write claims, the JSON Schema subset scripts write, and result contracts.
- `src/run/` is `SubagentService`: the run registry and lock, admission, writer pools, process control, completion delivery, owned runs, workspace bindings, and the frozen `{ revision, runs }` projection that tools, UI, and Activity read.
- `src/workspace/` and `boundary/git-worktree*.ts` own isolated-writer artifacts and Git I/O; root workspace operations queue on one lock.
- `src/backend/` holds the local Pi, Claude, and Codex drivers; `src/boundary/` and `src/supervisor/` hold host, process, filesystem, lease, and supervisor adapters.
- `src/tools/` owns schemas, execution, persisted details, and compact renderers for the 11 coordinator tools, `subagent_workflow`, and child-only tools; `src/ui/` holds pure projections.
- `boundary/host-activity.ts` registers the root's Cosmic UI Activity provider for runs and workflows, whose items and details pure `ui/run-activity.ts` projects; actions recheck session, revision, and capabilities before reaching `SubagentService` or `WorkflowService`.
- `src/settings/` owns `/subagents`, its settings, and the profile dashboard; `application/commands.ts` registers it and `/ultracode` over the current activation.
- Workflows are opt-in: `subagent_workflow` always registers inactive, and `application/ultracode.ts` alone adds it to or removes it from Pi's active tools, touching no other tool.
  It is active while the `ultracode` switch (Session, Global, or trusted Project, default off) is on or the one-off `/ultracode` window is open; it also owns the footer marker and the `before_agent_start` guidance, a system-prompt section of its own.
  The window is pure state in `application/ultracode-window.ts`, moved by `/ultracode` requests, Pi's `before_agent_start`, `agent_start` and `agent_settled`, and `WorkflowService`'s run observer (`workflow/run-observer.ts`), which opens a run at start or when its interrupted notice is posted and closes it once Pi accepts its notification, saying whether the current or the next agent run handles it; session boundaries reset it.
  Between an activation and the next agent run the controller only adds the tool, so Pi's pending restore list survives.
  Native codemode can always call the four root tools; ultracode gates only `subagent_workflow`.
- `skills/workflow-authoring/SKILL.md` is the main agent's workflow authoring guide. It isn't a declared Pi skill (`pi.skills` is empty), so it stays out of the skill list while workflows are off; the tool description and the ultracode guidance name its path, which `boundary/workflow-authoring-guide.ts` resolves.
- `src/workflow/` owns dynamic workflow runs: `service.ts` starts and stops them and forks one fiber per run, `skip.ts` skips their planned, queued, and running agents, and `runs.ts` holds their views and coalesces Activity publishes.

## Workflow runs

- Scripts run in a fresh in-process `CodemodeSandbox` with only `agent`, `event`, and `load` host members, whose calls are fibers of the run's scope.
- Each `agent()` call is an owned run admitted through its run's own FIFO slots, `min(16, CPUs - 2)` of them, as in Claude Code.
  Only the launch is interruptible, so a settled call always records its view, usage, and journal lines.
- Owned-run rule (`run/owned-runs.ts`): the workflow claims its agent's first report before the record is registered, and root await, retry, and resume of a completed member fail with `workflow_owned_run` while it is live.
  Closing the owner stops its live runs, hands any it couldn't stop and unread completed writer reports back to root delivery, and consumes the rest.
- Admission: workflow starts are exempt from the root's direct-child limit, and runs a workflow still owns, or its writers' worktree launches, hold none of its slots, so that limit governs only the main agent's own subagents.
  A queued writer waits behind a conflicting writer on `run/admission-signal.ts`, which advances a revision only when a holding that can end a writer conflict is released.
- What persists where: the resume journal lives in process memory per Pi session and survives `/reload` and `/tree`; run files (script copy, results journal, full results) live under `<agent-dir>/subagents/workflow-runs`; `run.json` lets a later Pi process of the same session resume, announce, or describe a run.
- Structured results: `domain/result-contract.ts` compiles the schema on `domain/json-schema.ts`, which workflow `meta.args` schemas share, local Pi children submit through `subagent_result`, Claude and Codex through the supervisor report, and `run/settlement.ts` decides precedence.
- A worktree writer that made no changes is discarded through `workspaceDiscardUnchanged`, which holds its binding like any root workspace operation.

## Invariants

- `writerWorkspaceMode` is one persisted session setting, default `shared-checkout`, with no candidate/start-item override; the only override is a workflow agent's internal `writerWorkspaceModeOverride`, which `isolation: "worktree"` sets to select a worktree.
  `worktree` is opt-in; shared checkout retains cooperative pools.
  Isolated writers allow concurrent parent editing; shared-checkout writers do not.
  Worktree writers currently require a root caller; nested writer launches are rejected rather than borrowing a parent lease.
  Read-only and shared-checkout nesting remain supported.
  Nested read-only runs inherit the authenticated parent's effective cwd, not the root checkout.
  Mode switches cannot bypass active/reserved/quarantined writer ownership or unresolved artifacts.
- Reports never approve integration.
  Only the authenticated direct parent may review, revise, prepare, integrate, or discard a workspace.
  The parent inspects every immutable diff page, runs relevant tests in the prepared combined cwd, then integrates the exact revision/preparation pair as uncommitted edits preserving the parent index.
  Parent drift, changed preparation, conflicts, and uncertain cleanup fail closed.
  Snapshot heuristics and cooperative claims are not filesystem or confidentiality sandboxes.
- A public or proxied start batch captures one profile and nesting-policy revision.
  Default policy is 12 direct children and depth 3, with strict bounds of 1 through 32 and 0 through 8.
  Admission counts active direct children, race reservations, and slots held by worktree launches still acquiring workspaces, for one parent only; runs a workflow owns and their launches count for none.
  There is no tree-wide active-run budget.
  A node at max depth cannot spawn.
- Completed respawn checks the current direct-child policy, including held worktree launch slots, under the admission lock before reserving its process slot.
  In-place paused resume keeps its existing slot and remains allowed at capacity.
  Writer respawn recanonicalizes the launch cwd interruptibly outside the service lock and ownership mask.
  One locked claim then checks run, assignment, process, cwd, state, stop, owned-run guard, report backlog, writer conflict, capacity, and a worktree writer's binding, and rejects changed filesystem identity before assignment rollover.
  The binding refuses a busy root operation (`workspace_operation_in_progress`), a launching revision successor, and a workspace this session integrated, discarded, or left mid-integration (`workspace_finished`).
  A writer with a live process resumes in place; otherwise the claim's commit marks the reviewed revision stale, and the next review reopens the engine record.
  A refused resume never changes the workspace.
- A revise holds its binding from its locked checks until its successor's launch settles.
  That launch takes over the hold as its first step, so abandoning the revise call cannot release it, and admission commits the revision under the run lock: the binding takes the successor's request, and the reviewed revision is stale until the next review.
  A refused successor leaves the binding, its request, and its reviewed revision unchanged.
  A worktree launch holds a direct-child slot from its capacity check until admission, an eviction claim, or failure, never alongside the claim that replaces it.
- Retry claim transfer is acknowledged only after the session-owned commit fiber is forked, within the same interruption mask.
  Cancellation before transfer releases the caller's claim; cancellation afterward stops only the waiter, leaving the commit to release its claim.
- Root scripted admission seeds immutable record-only `scriptOrigin`, inherited from authenticated parents and retry predecessors, never request fields or serialized views.
  Service validation rejects writers before workspace acquisition; locked launch admission rechecks before eviction or writer-pool creation.
  Resume/respawn keeps the same record restriction; workspace revise is writer-only, and no script-origin writer can own a binding.
  Model-started trees and separately authorized root writer launches stay unchanged.
  This is cooperative admission policy, not capability confinement.
- Every run has immutable `parentRunId` and `depth`, anchored at the virtual `root` node.
  Root views contain the complete tree.
  Authenticated nested views contain the caller and its descendants, and target authorization rejects ancestors and siblings.
  Natural intermediate completion leaves descendants running.
  Explicit stop and root shutdown close leaf-first.
  Subtree stop claims every target, including its parent-stop flag, and forks the complete sequential traversal into the session scope before restoring waiter interruption.
  Retry successors keep the predecessor parent while existing descendants stay on the predecessor.
- An explicit profile always wins; omitted profiles use `generalist` for root, proxied, and scripted starts.
  The main agent chooses roles and workflow branches; the selected profile determines the configured model route.
- A public start batch captures one profile snapshot.
  Candidate fallback is readiness-only; explicit retry advances strictly through the frozen route after confirmed cleanup.
  There is no derived fallback: invalid remote or stay-open routes fail closed, including mixed and inherited routes.
  Documents and credentials are never rewritten automatically.
- Every local Pi launch separately snapshots the root Pi's current active tool names; nested callers never substitute child-local tool toggles.
  Write intent does not filter the snapshot.
  Only competing coordinator/orchestrator implementations are denied, while package-owned `subagent_*` names resolve to authenticated proxies.
  Before ownership, the snapshot must pass count, exact comma-free name, control-character, per-name, and aggregate UTF-8 bounds so Pi's CLI parser cannot normalize or inject another activation.
  A name activates only an implementation discoverable by the child under its root-derived project trust.
  Native Claude/Codex policies do not consume this snapshot.
- Pi read-only is prompt and writer-lease coordination, not capability confinement.
  In a trusted Pi child, active/discoverable native codemode retains native tool authority, but nested calls pass through Pi hooks, approvals/overrides, and file-claim observation.
  Coordinator proxies are always model-only.
  Every process, helper, transport, private harness, writer pool, and writer lease belongs to the session runtime.
  One cross-process cwd lease protects each session pool; claimless writers are exclusive, while claimed writers must be pairwise disjoint.
  Claims coordinate unchanged native tools rather than sandboxing them.
  A native claim violation atomically pauses pool admission and starts owner-scoped containment.
  Only a backend with both interrupt and resume may pause; other active offenders stop.
  Failed interruption falls back to normal stop.
  The parent alone may grant safe missing claims to a confirmed paused offender, reopen admission, resume it, or stop and replace it.
  Any unconfirmed member cleanup quarantines the whole cwd pool, preserving fail-closed writer ownership.
- Reports are in-memory assignment generations.
  Close-on-report resume/respawn paths retain the hard 64-unresolved-generation bound.
  Every supported launch closes after report; omitted or true `closeOnReport` is accepted and false is rejected before ownership.
- The local Pi IPC bridge exposes authenticated proxy tools.
  The server binds each request to its authenticated caller run and ignores ancestry fields because the proxy schema cannot carry them.
  Parent proxy executions live in one `${runId}:${requestId}`-keyed FiberMap owned by the service scope: per-run bounded concurrency, exact duplicate-identity conflict responses, nonblocking forked cancellation interrupts, and scope-finalizer interruption of surviving executions after the leaf-first shutdown.
  Each local question or proxy call acquires its exact correlation entry and releases only that waiter identity.
  Current-listener disconnect or runtime closure rejects every remaining waiter.
  Listener release performs that rejection unconditionally, but a detached old listener's later disconnect callback cannot reject correlations owned by the replacement session.
  Stale listeners do not acknowledge controls, and stale reload definitions reject without reaching the current runtime.
  Questions are interruptible, reports are idempotent, and the MCP helper writes one response frame per call even when cancellation races stdout backpressure.
- Resumable local Pi interruption closes run-level turn-input admission before RPC.
  Already admitted guidance, acknowledged parent replies, and descendant notifications drain first; notification IPC is acknowledged after the child admits `pi.sendMessage`, while acknowledgment uncertainty stays owned by the selected ancestor rather than duplicating fallback delivery.
  One Effect semaphore and a correlated IPC barrier prove that earlier child inputs were processed before the complete `clear_queue` → `abort` sequence.
  Paused or pause-pending runs reject later turn inputs.
  The adapter sends `abort` only after correlated queue-clear success and discards the returned queue text.
  Barrier, clear, or clear-transport uncertainty suppresses later commands and releases the run-level pause claim; uncertainty after `abort` keeps the existing pending-pause behavior.
- Claude and Codex native agents stay inside their parent run and sandbox.
  They do not enter the Pi registry, depth calculation, or writer admission.
  Claude classifies `parent_tool_use_id` frames as native-agent forwarding, refuses cross-session input in the generated local settings, and requires same-session UUID authority for adapter-input replay.
  One narrow exception owns Claude 2.1.259's same-session active-assignment command-queue replay of a complete task-notification envelope when synthetic/origin metadata is absent; its fresh UUID is internal subturn evidence, never an alias for adapter input.
  Every near miss remains unexplained.
  Unexplained replay stays fail closed until the supervisor proves an exact-epoch accepted report; only then may the adapter warn and reproject that report for normal close-on-report settlement.
  Digest equality is diagnostic evidence, never authority.
  The default diagnostic and optional private tail contain classification metadata only.
  Known native events update a bounded active/total/latest summary; unknown native protocol shapes fail closed.
- Current Session is the only active working set.
  It starts from a complete baseline resolved through trusted Project, Global, and built-in defaults.
  Per-profile edits apply to later launches immediately, while saved-set edits never change Current Session.
  Applying a valid saved set resolves and previews all seven routes, then replaces the baseline and clears dirty routes with one expected revision; active runs remain unchanged.
  Saving Current Session holds the profile service's revision lock through one full-snapshot store action, rejects fail-closed inherited routes or a changed session revision, and does not select a default.
  Invalid sets remain visible but cannot be applied or selected as defaults; Project-set status includes inherited Global failures.
  Route-invalid sets can be repaired, structurally invalid sets must be deleted and recreated, and malformed unnamed defaults remain clearable.
  Clearing a selected default keeps the saved set and restores lower-layer inheritance.
  Project trust is rechecked before every Project write.
- Settings catalog refresh is nonblocking and cancelable.
  The editor captures its originating activation before inspection and submits refresh through that session's application runner with editor cancellation.
  Replacement revokes submission and delayed inspection results.
  The registry receives an Effect-owned signal; a noncooperative Promise cannot retain the fiber or publish after interruption.
  A successful non-aborted refresh atomically replaces one immutable root-registry Pi-model snapshot; failure or abort retains the prior generation, and each picker captures one generation.
- Persisted tool details are strict version 2, privacy-projected, deeply frozen, and canonically bounded to 48,000 characters.
  Optional bounded write-claim, audit, current-violation-offender, awaited-target, descendant-context, admitted failed-start recovery, and action-failure `pendingDelivery` fields are additive within version 2.
  Failed-start recovery is published only after the complete cleanup barrier and derives retry eligibility from authoritative run facts.
  Await context cards never carry descendant reports.
  Older history uses bounded sanitized text fallback.
