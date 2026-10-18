# Completion, projection, and delivery

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and [Local backends](local-backends.md) for backend-specific completion evidence.

## Assignment epochs, questions, and phases

Every assignment has a monotonic, never-reused epoch and a `preparing`/`issuing`/`running`/`reported` phase.

- Supervisor epochs are prepared before task issue, advance only after a live authenticated peer acknowledges them, and become unready on disconnect until a new peer handshakes. Each supervisor call captures the epoch it observed.
- Events from older epochs, and activity, tool, progress, warning, and question events while idle `reported`, are ignored. Handle-scoped lifecycle warnings stay visible but never trigger a parent turn.
- Progress, warnings, and questions normalize to `supervisor_contact` events. Warnings update the parent-visible projection and session history without a model message; the latest child warning and latest system warning are kept separately and folded into the terminal outcome.
- Child instructions escalate risks that could invalidate current parent work into questions. One question may be used per assignment and one may block per run at a time.
- Reply, MCP cancellation, socket loss, adapter cancellation, and scope close settle the exact owned question. Every definite question-death path emits a correlated cancellation, for which the channel reserves queue capacity, so `waiting_for_parent` never outlives its question.
- A reply timeout after transmission returns `reply_outcome_uncertain`, closes the question without retry, and keeps a system warning.

### Parent messages

`subagent_send` is the one parent-message path; there is no separate reply tool. Each target is claimed under the run lock, which decides its delivery:

- A target in `waiting_for_parent` is **answered**: the claim marks the reply in flight, clears the question, and commits in the owner scope, so cancelling the caller never abandons the claimed question. A definitely unsent reply (`reply_send_failed`) restores the question for another send.
- Any other target is **guided**: the message steers its running turn under the existing steer admission, and the turn-input claim is released when the caller finishes.
- A target with a reply already in flight refuses with `reply_in_flight` rather than steering; uncertain-delivery codes keep their meaning.
- Each target's result is separate. Cards list answered targets in `answeredRunIds`; the others were guided. Activity and fleet reply and message actions use the same path.
- Report `deliveryId` retries with identical text return the original sequence without a second event; conflicting reuse fails.

### Start confirmation and report commit

- A report received while `controls.start` is in flight is held in one bounded slot and committed only after start confirmation, or correlated `run_started` evidence after an uncertain result.
- Definite resume-start failure restores the prior view, report and warning fields, active tools, and assignment state under the matching attempt token, keeping warnings observed during the attempt. Outcome uncertainty keeps the new assignment.
- Confirmation, rollback, and reconciliation share one predicate under the run lock: the attempt token matches, the assignment is still issuing, and the run is active. Late prompt replies cannot revive a stopped or failed run or create another report generation.
- Activation drains `pendingReport` and `pendingRunSettled` under the run lock. A buffered report wins over settlement and commits its watermark, payload, `reported` phase, and completed projection atomically, so backend exit can never replace an accepted report with a retryable failure. `settlement.ts` owns this drain and commit.

### Claude guidance delivery

Local Claude guidance has a separate optional `steeringDelivery` fact: `pending`, `confirmed`, `not-sent`, `report-unconfirmed`, or `unresolved`, bound to the handle, epoch, and delivery sequence. A matching accepted report completes with a warning that guidance stayed unconfirmed. Terminal pending guidance becomes `unresolved` and blocks route retry and retry hints, even after cleanup. Details are in [Local Claude](local-backends.md#local-claude).

## Close-on-report lifetime and root shutdown

- Every run closes after reporting.
- Completion payloads and exclusive await claims survive process cleanup.
- `subagent_send` answers or steers active assignments and never starts an idle session; `agent_send` may [resume](#resume-by-any-agent) a finished local Pi run. Local Pi supports paused in-place resume and respawn of completed, failed, and stopped sessions; Claude and Codex do not advertise resume. Each resume is a new epoch with session-owned admission.
- Natural completion or failure closes only that run's backend scope; descendants stay attached to their original run nodes. Cleanup interrupts the run's proxy waits and joins finalizers that release their completion claims, so descendant reports reach a surviving ancestor or the root.
- Explicit stop marks the subtree against new admission and closes it leaf-first. Root shutdown, replacement, tree navigation, and reload close all children leaf-first, detach confirmed pool members, then release each safely releasable final lease.
- Local Pi run directories, transcripts included, stay until eviction or runtime end, so a stopped run's `Session:` link keeps working. A paused, completed, failed, or stopped run can resume until its state is reclaimed or a retry claims or supersedes it ([resume admission](routing.md#resume-admission)).
- Graceful shutdown is not crash recovery: parent death after `spawn-started` leaves a manual-recovery lock.

## Projection and delivery

### Projection

The service stores every committed run mutation as one immutable `{ revision, runs }` snapshot in a `SubscriptionRef` while holding the run lock, then invokes the best-effort host publisher. List and rendering read the snapshot without the lock. Await captures its revision in the same locked check, then waits for a strictly newer revision; every wake rechecks authoritative state.

The root TUI installs one read-only widget above the editor from the same projection.

- It shows every starting, running, stopping, waiting, or paused run plus the ancestors needed to keep the tree, marks active await targets, and emits nothing for terminal-only state. The ordinary footer is suppressed only while the widget has content.
- Root start and await executions hold a presentation lease, so their partial results emit no duplicate hierarchy. Non-TUI, nested, and widget-failure paths keep the bounded live card.
- Await leases are presentation only; descendant changes repaint the widget without changing completion semantics.
- Session replacement and shutdown clear the exact widget, subscribers, ticker, and leases.

### Persisted details

- Details use strict version 2 from one Effect Schema model. The public details door applies privacy projections, strips unknown fields, and rejects malformed known children without salvage.
- Each result is fitted in order: cards with reports (status and await only), report-free cards, then condensed cards. Condensed cards drop live activity, skipped candidates, and path lists, shorten issue text, keep IDs, counts, offender, cleanup, and workspace evidence, and mark `contentOmitted`.
- Values are deeply frozen and at most 48,000 characters of canonical JSON. Version-1 or unsupported history uses a bounded sanitized text fallback; nothing reconstructs cards.
- Start details hold the request-ordered entry list and never run cards. Await details hold cards, `awaitUntil`, and only the latest report generation, with explicit truncation evidence.
- Await cards target only the requested IDs for completion and claims, adding report-free descendants and any run whose question ended the wait, up to 12 cards. Banners count the true `runCount`, and omitted runs get a cue to query them with `subagent_status`.
- Usage cost renders only when the backend reports it (Pi and Claude do; Codex doesn't). A fleet subtotal over runs with unknown cost is marked as a lower bound.
- Absent capabilities are unknown. An explicit lack of `resume` keeps stop-and-replace guidance.
- `subagent_models` details persist each candidate's policy fields plus `status` and `reason`, keeping all seven routes and up to 32 candidates per route even when condensed.

### Completion records and claims

- Each accepted report or terminal failure creates one unresolved outcome-generation record with its text or bounded error and a fold of the latest child and system warnings. The per-record `completionGenerations` map is the sole payload and outbox.
- `completionClaims` maps a generation to one exclusive opaque owner token. Await claims the current generation when finished, or the next one while working, so a claim may precede its payload. A second await fails with `completion_claim_conflict`.
- Competing status sees bounded metadata with report text and transcript redacted. Consumption removes only the exact payload and matching claim.
- Report and terminal transitions insert the payload, open the completion latch, resolve any pending pause, and publish before releasing the lock. Peer notices and backend cleanup transfer to the session scope in the same uninterruptible commit, so cancelling the caller abandons neither.
- A failure after resumed report generation N allocates N+1; public `reportGeneration` counts accepted reports only.

### Delivery

- The completion worker takes the completion gate, then the run lock, and selects at most 12 unclaimed payloads in deterministic order. It keeps the gate through host notification and deletes only acknowledged `(runId, generation)` keys; partial acknowledgement retries the remainder.
- If any eligible payload remains, the worker reopens the latch, so nothing is stranded. Retry delay starts at 100 ms, resets after progress, and caps at 30 seconds.
- Delivery walks ancestry to the nearest eligible connected Pi process. Paused, pause-requested, stopping, and parent-stop-claimed ancestors are ineligible. Nested messages put the folded warning before report text, so truncation cannot erase qualifications.
- If no Pi ancestor accepts, the root notifier bounds, sanitizes, redacts, and chunks the message. An accept-then-throw root result is uncertain and retried.
- Questions use a separate run-keyed map and latch worker, queued in the same transition that publishes `waiting_for_parent`. An await claims its targets' questions, and the worker skips claimed ones. A successful await confirms only exact `(runId, notificationGeneration, requestId)` receipts for fully rendered runs.
- Uncertain ancestor question sends stay unacknowledged for retry, never falling through to another recipient.
- A definite failure whose frozen route still has candidates includes one `subagent_lifecycle` retry hint; uncertain or exhausted runs don't.

### Retention

- Resolved generations are removed; the public projection keeps only the latest bounded report, error, and warning. Each record has a hard bound of 64 unresolved generations.
- After 50 terminal records, start admission may reclaim the oldest terminal leaf with no descendants, unresolved or claimed outcome, process, cleanup ownership, or recovery identity. Retention never rejects a valid start.
- Eviction is reclaim-before-admit: an exclusive `evictionClaim` reserves the prospective admission, private state is reclaimed outside the lock while the record stays registered (resume rejects it), and a final locked phase revalidates and swaps records atomically.
- Reclaim failure or post-reclaim rejection clears the claim, keeps the candidate registered and quarantined against unsafe resume, and admits nothing.

## Parent wake policy

`boundary/host-parent-wake.ts` decides when root notifications may start a parent turn, on the shared `registerSessionWake` from pi-cosmic-core, adding question reminders, the interrupt notice, and headless drain. Wake turns run `before_agent_start`, so they keep the delegation section.

- **Idle and busy parents.** A notice starts a turn only while the parent is idle (no run and no compaction). While busy it is sent with `triggerTurn: false`, so Pi appends it at the end of the current turn, outside the steering queue that Esc clears. Before a run settles, the policy continues it when a notice arrived after the last assistant message; a notice after that boundary wakes the parent with one hidden nudge. Multi-chunk completions trigger only on their last chunk.
- **Interrupt hold.** After `agent_settled` reports `aborted`, completions and questions are appended without a turn until the user's next prompt, and the user sees how many subagents are active.
- **Unanswered questions.** Before a parent turn settles, `agent_before_settle` adds one hidden reminder per pending direct-child question generation and continues. A question still unanswered at the next settle produces one user warning instead.
- **Active children in the prompt.** `boundary/host-active-runs-prompt.ts` adds an `active_subagents` section while direct children are active, so the parent remembers them after compaction. Where the model honors mid-conversation system messages, it lists the live set and stays byte-identical while nothing changes. Otherwise it is byte-stable between compactions, so it never rewrites the cached prompt: empty until the branch has a compaction, then a snapshot captured at the first run start after each compaction, pointing at `subagent_status` for current state.
- **Headless drain.** In `print` and `json` modes, a parent turn with active subagents waits on `awaitParentDrain` until no run is active and every completion reached its notifier, or a direct child waits for a reply. The wake owner then rechecks direct-child questions with the same one-reminder policy. RPC children and the TUI never drain.

## Agent messages

`agent_list`, `agent_send`, and `agent_read` reach every agent in the root tree plus `main`, the root session's main agent; `subagent_*` keeps managing the caller's own subtree. `run/agent-messages.ts` owns the operations and `run/agent-messaging.ts` their pure policy. The root binds the caller from its session or a run's authenticated channel; no request names its sender.

### Dispositions

A message is delivered when it is sent or refused; nothing is stored for later. One claim under the run lock decides the delivery from the target's state, and once admitted the delivery commits in the session scope, so cancelling the sender never abandons it.

- **Runs.** A run waiting on its parent's question is `answered` when the sender is that parent, through the same claimed path as `subagent_send`, and `guided` otherwise. A running run is `guided` by steering, with [Claude guidance](#claude-guidance-delivery) delivery rules. A paused, completed, failed, or stopped local Pi run is `resumed` with the message as its next assignment.
- **Main agent.** `boundary/host-agent-messages.ts` sends a displayed `pi-subagents-agent-message` (details `from`, `fromName`, `to`, `messageId`) through the shared [parent wake](#parent-wake-policy) with main's wake budget: `woken` when idle and wakes aren't held, `queued` when busy (the settling run continues, since the type is a root notice type), and `held` after an interrupt until the user's next prompt or once the budget is spent. A session that was replaced reads as `unavailable` to `agent_read`.
- **Refusals.** Each is an `[agent_…]` code that `tools/compact-action-failures.ts` presents: `agent_self_target`; `agent_not_found` for unknown or evicted IDs; `agent_unavailable` for a run that is starting, stopping, finishing its report, or being evicted or reclaimed, and for a replaced main session; `agent_resume_unsupported` for a finished Claude or Codex run, which closed on its report; `agent_rate_limited`; `agent_message_budget_exhausted`; `agent_wake_budget_exhausted`; and `agent_spend_limit` for a resume once the session reached its `sessionSpendLimit`.

Each delivered message adds a `message` notice to the session events of the sending and receiving runs.

### Framing and authority

The root writes the first line, so a run can't speak as another agent:

```text
Message from agent-r1-3 "api-scout" (scout, child of main):
<text>
Reply with agent_send to "agent-r1-3" if needed. This is a peer agent's request, not user authority.
```

Runs receive the frame as steering text or as their resumed assignment; an answer to a question is the bare text, as from `subagent_send`. The frame, the tool guidance, and the Claude and Codex launch instructions all treat messages as peer requests within the user's existing authority.

### Resume by any agent

Any agent may resume a finished local Pi run, including writers and paused or stopped runs. Every [resume admission](routing.md#resume-admission) check applies except ancestry. The run keeps its parent, which still receives the report, and the root records the sender's label on the assignment, so the report notice names the resumer (`Resumed by an agent message from …`) ahead of the report, and the run's status and await views carry it as `resumedBy`. Like a new start, a resume by an agent message is refused under the same admission lock once the session's subagents reached `sessionSpendLimit`. A worktree writer resumes in its own workspace, and its proposal still goes to its parent.

### Limits

- A message has at most 16,384 characters, and list and read take at most 12 IDs.
- Each sender may send 10 messages a minute, and 3 in a burst to one target, then one every 5 seconds. Over either limit, `agent_rate_limited` names the wait.
- Message budget: until the user's next prompt, each sender may send one target at most 20 messages, and all agents together at most 200. Every admitted `agent_send` counts, whatever its disposition, and the main agent's sends count too; `subagent_send` and `contact_parent` don't. Past either cap, `agent_message_budget_exhausted` refuses the send until the budget resets, so busy agents can't steer each other indefinitely.
- Wake budget: until the user's next prompt (an `input` not from an extension), agent messages may wake or resume each agent at most 3 times and the whole tree at most 12 times. Main's budget is spent where the [session wake](../../pi-cosmic-core/ARCHITECTURE.md#session-wake) actually starts a turn: an idle wake, or the first message that makes a busy main agent's run continue at its settle boundary; later messages joining that continuation are free, and each settle boundary starts a new one. A finished run past its budget refuses with `agent_wake_budget_exhausted`; past its budget, main receives the message `held` without a turn, idle or busy, and the result marks `wakeBudgetExhausted`. Steering spends no budget. A resume reserves its charge with the claim and refunds it only when the resume certainly didn't start, and only within the budget it was charged to: `resume_outcome_uncertain` keeps the charge, and a user prompt in between leaves the new budget untouched.

### Last-message reads

`agent_read` never claims or consumes a report, so each parent still receives its own.

- `main`: the last assistant message on the root's current branch, text parts joined and bounded to 32 KiB, with `idle` or `busy`; `unavailable` without text once the session that owned it was replaced.
- A run: the latest assistant message of its current or last assignment, bounded to 16 KiB. A finished run without one falls back to its retained report, then its error; `source` says which, and `reportGeneration` dates it. Otherwise `textStatus` is `none`.

`agent_list` and `agent_read` are script-callable with structured results ([codemode](native-codemode.md#script-boundary)); `agent_send` is model-only, and the executor refuses scripted sends.

## Report archive and previews

- The root notifier writes each delivered report generation to `<agent dir>/subagents/reports/<session>/<run>-<generation>-<archive UUID>.md` (directory 0700, file 0600). Each file is created exclusively, so reused IDs in another runtime cannot overwrite it.
- Reports up to 4,000 characters arrive whole with the path; longer ones arrive as a whole-line preview with shown and total characters, line count, and path. If the file can't be written, the report is inlined within the 32 KiB notification bound.
- Each root session start prunes reports older than seven days, then the oldest beyond 64 MiB, then empty session directories.
- Before `/reload` or leaving the session replaces the runtime, the root holds wakes and hands every eligible completion to the notifier (bounded to two seconds), then appends one `pi-subagents-stopped` message naming the runs it stops, without starting a turn.
- `/tree` is different: Pi has already switched branches, so the runs stop without appending reports or a message to the new branch. Only the user's warning remains.

## Live transcript in the fleet

Each tool completion carries a bounded output preview (seven lines, at most 1,000 characters) decoded from the native result and sanitized within the session-event budget. The fleet and Activity details interleave the start of each assistant message (up to 1,200 characters) with tool groups. The latest assistant message is omitted once it is the delivered report, shown in full below. Pi children also report context-window fill, which turns to a warning at 80%.

## Stalls, wait timeouts, and partial output

- `run/stall.ts` derives presentation-only stall signals: a tool open for five minutes, three consecutive failed tool calls, or two minutes without activity while no tool is open. Every streamed model event counts as activity. Nothing stops or retries a run because of elapsed time.
- `subagent_await` accepts `timeoutSeconds` (1–3600). A timeout ends only that wait, like a cancellation: children keep running, claims are released, and the outcome is `timed_out`.
- A wait ends early with outcome `attention` when a run it doesn't await asks this caller a question; the question stays in the outbox.
- A root wait ends with `user_input` when the user sends a message, so the parent can read it.
- A failed assignment's error includes up to 2,000 characters of the failing attempt's own text, never earlier attempts' ([completion rules](local-backends.md#supervisor-channel-and-completion-ownership)).

## Script results and report read-back

The script-facing contract is in [Native Pi codemode scripting](native-codemode.md). Service rules:

- Root models, start, await, status, and lifecycle declare version-3 orchestration results from Effect Schema, separate from persisted details. The contract is encoded inside the claim scope before consumption, and only completely returned reports are consumed.
- Scripted execution is identified from native `parentToolCallId` provenance on execution-start and admission events. Script evidence cannot be downgraded, model origin requires both observations, and missing evidence fails closed.
- Scripted starts enforce read-only intent after route resolution and before admission; lifecycle permits only stop. Scripted await and status reject parent attention before consumption, and await leaves questions unacknowledged.
- Scripted root starts seed an immutable, record-only `scriptOrigin`, inherited by descendants and retry successors. Validation rejects such writers before workspace acquisition, admission rechecks before eviction or pool creation, resume keeps it, and revise cannot admit a script-origin writer.
- Other coordinator tools and every nested-Pi `subagent_*` proxy are model-only; `agent_list` and `agent_read` are script-callable at every Pi depth. These gates don't confine native tools or child capability.
- `includeDeliveredReports` reveals the latest retained final text only after its outcome was delivered and while no claim owns any generation. It returns no receipt and adds no outbox entry; it is bounded in-memory read-back, not history.

## Tool result certainty

Root and local Pi registrations keep bounded activation-owned receipts. A matching `tool_result` hook sets Pi's error flag for actual target-operation failures, including mixed batches, without replacing content. Status and await calls are not failures merely because they describe failed workers.

`actionFailureDisposition` in `tools/outcome.ts` is the single classifier:

- **pending:** only a `send` failure with code `steer_outcome_uncertain` and the version-2 `pendingDelivery: true` flag, which only the local Claude caller-wait timeout produces.
- **unconfirmed:** other `_outcome_uncertain` and `_cleanup_unconfirmed` codes, including an unflagged `steer_outcome_uncertain`.
- **failed:** everything else.

The decoder accepts the flag on any action failure, so a misplaced flag keeps its code-based meaning; producers persist it only on that exact send code.

- `marksSubagentToolError`: pending-only or pending-plus-confirmed sends are not errors; any unconfirmed or definite failure marks the call.
- Model text lists guidance awaiting confirmation, unconfirmed targets, and failed targets separately, and forbids resending, retrying, interrupting, or replacing a worker merely because confirmation is pending.
- A pending issue is a warning that makes the compact outcome uncertain. Recovery hints for uncertain or cleanup-unconfirmed codes never advise retrying or resending.
- Later status and await report delivery through the card's `steeringDelivery`. The `/subagents` fleet reuses this classification.

## Cancelled waits and report availability

- `subagent_await` keeps a call-local snapshot of requested IDs, latest observed states, descendant context, and pending parent actions. It returns `cancelled: true` only after an interruption-only exit and owned finalizers settle; an aborted signal alone never converts a failure into cancellation.
- If delivery was attempted before a late abort, the script result marks those reports `unknown`; opt-in status can recover an already-delivered report.
- A root wait returns only after its claims are released, without stopping children, consuming reports, or retrying.
- Await and status wait interruptibly for the notification gate, then the run lock. Only claim insertion and its scoped finalizer are masked, and the private scope owns claims only.
- Proxy cancellation has no root-cleanup acknowledgement. Its result carries `cancellationCleanup: "unconfirmed"`, and an immediate replacement await may fail with `completion_claim_conflict`.
- Finished observations classify `reportStatus` as `available`, `claimed`, `delivered`, or `missing` without touching claims. Cards without it have unknown availability.

## Run cancellation and cleanup

Cleanup evidence is independent of task state and accepted reports; its fields are described in [Cleanup ordering and quarantine](local-backends.md#cleanup-ordering-and-quarantine).

- `cleanup` and `writerCleanupQuarantined` are optional additive fields in version-2 cards and orchestration targets. Absence is unknown, not confirmed cleanup.
- Native lifecycle `status: "succeeded"` acknowledges the operation, not cleanup. Compact stop results stay warnings while cleanup is pending or quarantined.
- Explicit stop may reverify transport cleanup only when `cleanup.recovery` is `stop`, including on terminal runs; Activity and the fleet expose this without restarting the task. Manual recovery covers unknown finalizers, incomplete descendant snapshots, and uncertain lease failures.
- Cleanup quarantine never recommends stopping healthy pool peers.

Cancellation and ownership:

- `session-owned.ts` owns the one claim-then-owner-scoped-commit mask shared by launch, retry, interrupt, stop, and resume (a send that answers a question uses the same owner-scoped commit), so cancelling a waiter never abandons ownership while owner-scope closure still interrupts the commit.
- Subtree stop claims every target and its parent-stop flag, then forks the leaf-first traversal into the session scope. It joins descendant cleanup, including already-stopping and terminal descendants, before closing ancestors, and leaves terminal outcomes unchanged.
- Writer lease preparation masks its shared ownership claim through finalizer installation; pre-ownership checks stay interruptible.
- Process lifecycle installs its settlement handler before spawn admission, so unclaimed cancellation is a no-op and claimed cleanup settles its latch.
- `record-cleanup.ts` masks scope closure through backend and lease release and outcome publication, because closing a scope can't be retried. A stalled owned release keeps shutdown waiting rather than falsely confirming cleanup.
- Shutdown disables projection publication without blocking late cleanup commits or private state reclamation.

## Tool registration and compact presentation

Shared rules for registration, replay, compact issues, and expansion are in [tool presentation](../../../docs/architecture/tool-presentation.md). Package specifics:

### Activation

- `src/extension.ts` checks the child marker before importing the root application.
- Preview settings load as an interruptible best-effort bootstrap. The shared session-runtime slot owns replacement, and only its current token may register tools or publish activation state.
- Factory-time `registerCodePreviewReplay`, anchored to `/subagents`, owns historical coordinator rows; adoption publishes only after registration succeeds. Child proxies use the plain shell.
- Pi drops its pending tool-restore list whenever a tool is deactivated, so subagent tools stay active through `/tree` and the outgoing `/reload` shutdown. A later registration deactivates only tools it activated that the session hadn't kept active.
- Each runtime composes its own `CodePreviewSchedulerService.layer`; replacement and shutdown revoke stale scheduling.

### Arguments and results

- `tools/schema.ts` holds the one tool catalog: each tool's parameter schema plus any cross-field validator. Root execution and the nested-Pi wire carry the same `{ tool, args }` input.
- Each `prepareArguments` hook validates and coerces as Pi does, rejects blank strings, and returns `[invalid_arguments]` lists naming allowed values and likely replacements for unknown fields.
- `execute-result.ts` separates model text, persisted details, and version-2 script results.
- Model text is compact. A start lists one line per run (`id name · profile · runtime/model:effort`, plus `worktree <id>` for an isolated writer) and its failures. A status or await card is a header line, then only the fields that need attention (parent, a cwd other than the caller's, retry, route warnings, workspace proposal, quarantined cleanup, warnings, failure, a pending question) and the final report. `subagent_status` with `verbose` adds route selection, context, capabilities, process, cwd, and timing. Pending cleanup is never reported; only quarantine is.
- A worktree writer's proposal is stated once, as `proposal: N files, +A −D · subagent_workspace apply workspaceId=…`, in cards, issue details, and notifications.
- `subagent_workspace` pages complete immutable diffs and keeps patches out of persisted details. Its producers record display spans while composing output, so expansion never parses text.
- `boundary/host-tool-result.ts` owns the receipts that set Pi's error flag, including decoded child-proxy results, and tracks call provenance from native events, never arguments. Unknown provenance fails closed.

### Shell coverage

- All ten root tools and the child proxies use the shared presentation shell and the shared compact setting, projected from decoded domain details.
- `contact_parent` uses content-only callbacks; arbitrary replies stay verbatim, prefixed once with `PARENT_REPLY_PREFIX`. Warning calls keep the full warning as issue detail; settled questions and replies decline compaction.
- The seven supervisor tools are served over private MCP and have no Pi renderer.

### Compact issues

- Typed projections emit one `CompactIssue` per problem or recovery step. Messages start with a subagent, launch, or profile name, never a run or workspace ID. `tools/compact-action-failures.ts` owns each failure code's message and recovery guidance.
- Headings name runs by display name and show one combined count without routine IDs or route metadata.
- Routine facts are `info` issues, such as a stop the call requested, a retry moving past its failed option, or an isolated writer's workspace outcome (`ready to apply`, or an automatic discard).
- Workspace rows show whether the diff was reviewed and whether the parent tested its prepared pair or nothing was tested. Left-out worker files are a warning.
- Static discovery counts eligible options and disabled or unavailable profiles without claiming launch readiness.
- Report-only omissions use the optional `reportsOnlyOmitted: true` flag; other omissions keep warnings and full-status guidance.
- Compact summaries never derive grant paths, cleanup, or retry authority from bounded cards.

### Notification rows

`application/messages.ts` registers root and child message renderers. Each row shows typed counts and a lone run's name, with full content on expansion. `host-notifier.ts` attaches display metadata without altering content, delivery keys, or acknowledgement. A completed worktree writer's notification leads with its proposal line, which names the workspace ID and adds the change counts once they are known, so truncating a long report can't drop it.

## Activity provider and fleet

- `boundary/host-activity.ts` registers the root's Cosmic UI Activity provider. Pure `ui/run-activity.ts` projects the complete authorized root tree, including terminal history, into items, details, and action policy.
- Launch leases appear as provider count metadata and await leases as row metadata, without synthetic rows or moving run ownership.
- Each item's revision hashes its published fields, plus assignment and question identity for runs, so unrelated progress never makes an action stale.
- Credentials are redacted before summaries or details leave the producer.
- Actions recheck cancellation, session token, item revision, and capabilities before reaching the service. Destructive actions declare their confirmation scope, including descendant shutdown for stop.
- Message, reply, rename, and resume hand off to the abort-aware Pi input boundary after the manager closes. Post-input checks compare captured assignment and question identity and current capabilities, not the item revision. Stop and interrupt run in place.
- Rename belongs to the user: it changes only the root-owned display name, for any runtime, and never reaches the child.
- Parent-contact questions target the parent, never the user. Pauses and missing-question waits remain blocked rows.
- `host-ui.ts` removes the legacy widget only after Cosmic UI acknowledges its provider, and restores it if that acknowledgement is lost. `/subagents` falls back to the standalone fleet only when the unified manager is absent or unavailable before admission.
- The full-screen fleet shows one parent-before-child hierarchy, expanded initially. Left/Right collapse or expand a subtree, and Enter inspects a run. Fleet actions carry the epoch, session, state, and question identity captured by their prompt, rechecked under the run lock.
