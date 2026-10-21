# Completion, projection, and delivery

Part of the [pi-subagents](../README.md) architecture documentation. See [ARCHITECTURE.md](../ARCHITECTURE.md) for ownership and [Local backends](local-backends.md) for backend-specific completion evidence.

## Assignment epochs, questions, and phases

Every assignment has a monotonic, never-reused epoch and a `preparing`/`issuing`/`running`/`reported` phase.

- Supervisor epochs are prepared before task issue, advance only after a live authenticated peer acknowledges them, and become unready on disconnect until a new peer handshakes. Each supervisor call captures the epoch it observed.
- Events from older epochs, and activity, tool, progress, warning, and question events while idle `reported`, are ignored. Handle-scoped lifecycle warnings stay visible but never trigger a parent turn.
- Progress, warnings, and questions, all sent with `agent_contact_parent`, normalize to `supervisor_contact` events. Warnings update the parent-visible projection and session history without a model message; the latest child warning and latest system warning are kept separately and folded into the terminal outcome.
- Child instructions escalate risks that could invalidate current parent work into questions. One question may block per run at a time; an assignment may ask again once it settles.
- Reply, MCP cancellation, socket loss, adapter cancellation, and scope close settle the exact owned question. Every definite question-death path emits a correlated cancellation, for which the channel reserves queue capacity, so `waiting_for_parent` never outlives its question.
- A reply timeout after transmission returns `reply_outcome_uncertain`, closes the question without retry, and keeps a system warning.

### Parent messages

`agent_send` is the one message path; there is no separate reply tool. Its target is claimed under the run lock, which decides its delivery:

- A target in `waiting_for_parent` is **answered** when the sender is one of its ancestors, including `main`, since its question reaches the nearest ancestor that can take it: the claim marks the reply in flight, clears the question, and commits in the owner scope, so cancelling the caller never abandons the claimed question. A definitely unsent reply (`reply_send_failed`) restores the question for another send. Any other sender **guides** it: the guidance steers the turn blocked in `agent_contact_parent`, so the run sees it only once an ancestor answers, and the result marks it `parked` and tells the sender so.
- A running target is **guided**: the message steers its running turn under the existing steer admission, and the turn-input claim is released when the caller finishes. Guidance whose native delivery is still being confirmed returns `confirmed: false` rather than failing; the model is told not to resend.
- A paused or finished local Pi target is **resumed** when the sender is one of its ancestors, including `main`, and refused otherwise ([Resume by ancestors](#resume-by-ancestors)).
- A target with a reply already in flight refuses with `reply_in_flight` rather than steering; uncertain-delivery codes keep their meaning and their compact issue says not to resend.
- The user's Activity and fleet reply and message actions go through the same delivery as bare text, with `main`'s authority to answer. They apply only while the run is as the user saw it, and never resume a run; the resume action does that.
- Report `deliveryId` retries with identical text return the original sequence without a second event; conflicting reuse fails.

### Start confirmation and report commit

- A report received while `controls.start` is in flight is held in one bounded slot and committed only after start confirmation, or correlated `run_started` evidence after an uncertain result.
- A definite resume-start failure fails the resumed assignment with its error and closes the run's backend; earlier reports stay with their completion generations. Outcome uncertainty keeps the new assignment with a system warning.
- Confirmation, uncertainty, and reconciliation share one predicate under the run lock: the attempt token matches, the assignment is still issuing, and the run is active. Late prompt replies cannot revive a stopped or failed run or create another report generation.
- Activation drains `pendingReport` and `pendingRunSettled` under the run lock. A buffered report wins over settlement and commits its watermark, payload, `reported` phase, and completed projection atomically, so backend exit can never replace an accepted report with a retryable failure. `settlement.ts` owns this drain and commit.

### Claude guidance delivery

Local Claude guidance has a separate optional `steeringDelivery` fact: `pending`, `confirmed`, `not-sent`, `report-unconfirmed`, or `unresolved`, bound to the handle, epoch, and delivery sequence. A matching accepted report completes with a warning that guidance stayed unconfirmed. Terminal pending guidance becomes `unresolved` and suppresses a failed run's next-candidate hint, even after cleanup. Details are in [Local Claude](local-backends.md#local-claude).

## Close-on-report lifetime and root shutdown

- Every run closes after reporting.
- Completion payloads and exclusive await claims survive process cleanup.
- `agent_send` answers or steers active assignments, and from an ancestor may [resume](#resume-by-ancestors) a paused or finished local Pi run, as do the user's Activity and `/subagents` resume actions. Local Pi supports paused in-place resume and respawn of completed, failed, and stopped sessions; Claude and Codex do not advertise resume. Each resume is a new epoch with session-owned admission.
- Natural completion or failure closes only that run's backend scope; descendants stay attached to their original run nodes. Cleanup interrupts the run's proxy waits and joins finalizers that release their completion claims, so descendant reports reach a surviving ancestor or the root.
- Explicit stop marks the subtree against new admission and closes it leaf-first. Root shutdown, replacement, tree navigation, and reload close all children leaf-first, detach confirmed pool members, then release each safely releasable final lease.
- Local Pi run directories, transcripts included, stay until eviction or runtime end, so a stopped run's `Session:` link keeps working. A paused, completed, failed, or stopped run can resume until its state is reclaimed ([resume admission](routing.md#resume-admission)).
- Graceful shutdown is not crash recovery: parent death after `spawn-started` leaves a manual-recovery lock.

## Projection and delivery

### Projection

The service stores every committed run mutation as one immutable `{ revision, runs }` snapshot in a `SubscriptionRef` while holding the run lock, then invokes the best-effort host publisher. List and rendering read the snapshot without the lock. Await captures its revision in the same locked check, then waits for a strictly newer revision; every wake rechecks authoritative state.

The root TUI installs one read-only widget above the editor from the same projection.

- It shows every starting, running, stopping, waiting, or paused run plus the ancestors needed to keep the tree, marks active await targets, and emits nothing for terminal-only state. The ordinary footer is suppressed only while the widget has content.
- Each row counts the agent messages its run sent or received (`messageCount` on the run view, since session events are bounded). For eight seconds after a tracked run's latest message, the message replaces the run's tool activity; the widget's existing refresh ticker, which runs while any tracked run is shown, clears it.
- Root start and await executions hold a presentation lease, so their partial results emit no duplicate hierarchy. Non-TUI, nested, and widget-failure paths keep the bounded live card.
- Await leases are presentation only; descendant changes repaint the widget without changing completion semantics.
- Session replacement and shutdown clear the exact widget, subscribers, ticker, and leases.

### Persisted details

- Details use strict version 2 from one Effect Schema model. The public details door applies privacy projections, strips unknown fields, and rejects malformed known children without salvage.
- Each result is fitted in order: cards with reports (await only), report-free cards, then condensed cards. Condensed cards drop live activity, skipped candidates, and path lists, shorten issue text, keep IDs, counts, cleanup, and workspace evidence, and mark `contentOmitted`.
- Values are deeply frozen and at most 48,000 characters of canonical JSON. Version-1 or unsupported history uses a bounded sanitized text fallback; nothing reconstructs cards.
- Start details hold the request-ordered entry list and never run cards. Await details hold cards, `awaitUntil`, and only the latest report generation, with explicit truncation evidence.
- Await cards target only the requested IDs for completion and claims, adding report-free descendants and any run whose question ended the wait, up to 12 cards. Banners count the true `runCount`, and omitted runs get a cue to query them with `agent_read`.
- Usage cost renders only when the backend reports it (Pi and Claude do; Codex doesn't). A fleet subtotal over runs with unknown cost is marked as a lower bound.
- Absent capabilities are unknown. An explicit lack of `resume` keeps stop-and-replace guidance.
- `agent_profiles` details persist each candidate's policy fields plus `status` and `reason`, keeping all seven routes, up to 32 candidates per route, and every resolved custom agent even when condensed. Routes too large even condensed leave the call without details, so it renders its full text generically.

### Completion records and claims

- Each accepted report or terminal failure creates one unresolved outcome-generation record with its text or bounded error and a fold of the latest child and system warnings. The per-record `completionGenerations` map is the sole payload and outbox.
- `completionClaims` maps a generation to one exclusive opaque owner token. Await claims the current generation when finished, or the next one while working, so a claim may precede its payload. A second await fails with `completion_claim_conflict`.
- Consumption removes only the exact payload and matching claim.
- Report and terminal transitions insert the payload, open the completion latch, resolve any pending pause, and publish before releasing the lock. Peer notices and backend cleanup transfer to the session scope in the same uninterruptible commit, so cancelling the caller abandons neither.
- A failure after resumed report generation N allocates N+1; public `reportGeneration` counts accepted reports only.

### Delivery

- The completion worker takes the completion gate, then the run lock, and selects at most `MAX_COMPLETION_DELIVERY_BATCH` (12) unclaimed payloads in deterministic order. It keeps the gate through host notification and deletes only acknowledged `(runId, generation)` keys; partial acknowledgement retries the remainder.
- If any eligible payload remains, the worker reopens the latch, so nothing is stranded. Retry delay starts at 100 ms, resets after progress, and caps at 30 seconds.
- Delivery walks ancestry to the nearest eligible connected Pi process. Paused, pause-requested, stopping, and parent-stop-claimed ancestors are ineligible. Nested messages carry the same [run block](#model-facing-run-blocks) as a root notice, whose warning line follows the outcome and points to `agent_read` for the whole warning.
- If no Pi ancestor accepts, the root notifier sends the batch as one sanitized, redacted notice of [run blocks](#model-facing-run-blocks). An accept-then-throw root result is uncertain and retried.
- Questions use a separate run-keyed map and latch worker, queued in the same transition that publishes `waiting_for_parent`. The question notice is the one path that delivers a whole question, line breaks included; it and the `agent_read` card indent every question line, so child text can't pass for a card field or an instruction. Awaits never claim or acknowledge it, so it goes out once even while an await returns early on it and shows only its preview (a root send that throws after Pi accepted it is retried, so that notice may repeat). A notice that can't be delivered is retried, and `agent_read` returns the whole pending question meanwhile.
- Each ancestor send carries a stable key: a report's run ID and generation, or a question's run ID and notification generation. Uncertain sends, of questions and reports alike, stay unacknowledged and are retried to the same ancestor with the same key, never falling through to another recipient; the receiving Pi process keeps the keys it showed in memory for its lifetime and acknowledges a repeat without showing it again. A definite refusal still falls through to the next ancestor or the root.
- A root child's failure names its frozen route's next candidate, or says none is left, unless unresolved guidance leaves its outcome unclear ([route continuation](routing.md#explicit-route-continuation)).

### Retention

- Resolved generations are removed; the public projection keeps only the latest bounded report, error, and warning. Each record has a hard bound of 64 unresolved generations.
- After 50 terminal records, start admission may reclaim the oldest terminal leaf with no descendants, unresolved or claimed outcome, process, cleanup ownership, or recovery identity. Retention never rejects a valid start.
- Eviction is reclaim-before-admit: an exclusive `evictionClaim` reserves the prospective admission, private state is reclaimed outside the lock while the record stays registered (resume rejects it), and a final locked phase revalidates and swaps records atomically.
- Reclaim failure or post-reclaim rejection clears the claim, keeps the candidate registered and quarantined against unsafe resume, and admits nothing.

## Parent wake policy

`boundary/host-parent-wake.ts` decides when root notifications may start a parent turn, on the shared `registerSessionWake` from pi-cosmic-core, adding question reminders, the interrupt notice, and headless drain. Wake turns run `before_agent_start`, so they keep the delegation section.

- **Idle and busy parents.** A notice starts a turn only while the parent is idle (no run and no compaction). While busy it is sent with `triggerTurn: false`, so Pi appends it at the end of the current turn, outside the steering queue that Esc clears. Before a run settles, the policy continues it when a notice arrived after the last assistant message; a notice after that boundary wakes the parent with one hidden nudge.
- **Interrupt hold.** After `agent_settled` reports `aborted`, completions and questions are appended without a turn until the user's next prompt, and the user sees how many subagents are active.
- **Dialog hold.** While an extension dialog is open, notices are appended without a turn; the parent wakes once the dialog closes.
- **Unanswered questions.** Before a parent turn settles, `agent_before_settle` adds one hidden reminder per pending direct-child question generation and continues. A question still unanswered at the next settle produces one user warning instead.
- **Active children in the prompt.** `boundary/host-active-runs-prompt.ts` adds an `active_subagents` section while direct children are active, so the parent remembers them after compaction. Where the model honors mid-conversation system messages, it lists the live set and stays byte-identical while nothing changes. Otherwise it is byte-stable between compactions, so it never rewrites the cached prompt: empty until the branch has a compaction, then a snapshot captured at the first run start after each compaction, pointing at `agent_list` for current state.
- **Headless drain.** In `print` and `json` modes, a parent turn with active subagents waits on `awaitParentDrain` until no run is active and every completion reached its notifier, or a direct child waits for a reply. The wake owner then rechecks direct-child questions with the same one-reminder policy. RPC children and the TUI never drain.

## Agent messages

`agent_list`, `agent_send`, and `agent_read` reach every agent in the root tree plus `main`, the root session's main agent; `agent_start`, `agent_await`, `agent_lifecycle`, and `agent_worktree` keep managing the caller's own subtree. `run/agent-messages.ts` owns the operations and `run/agent-messaging.ts` their pure policy. The root binds the caller from its session or a run's authenticated channel; no request names its sender.

### Dispositions

A message is delivered when it is sent or refused; nothing is stored for later. One claim under the run lock decides the delivery from the target's state, and once admitted the delivery commits in the session scope, so cancelling the sender never abandons it. The result is `answered`, `guided`, or `resumed`, with `confirmed` false only for guidance whose native delivery is still being confirmed.

- **Runs.** A run waiting on a question is `answered` when the sender is one of its ancestors, including `main`, through the claimed path in [Parent messages](#parent-messages), and `guided` and `parked` behind the question otherwise. A running run is `guided` by steering, with [Claude guidance](#claude-guidance-delivery) delivery rules. A paused, completed, failed, or stopped local Pi run is `resumed` with the message as its next assignment when the sender is one of its ancestors, including `main`.
- **Main agent.** `boundary/host-agent-messages.ts` sends a displayed `pi-subagents-agent-message` (details `from`, `fromName`, `to`, `messageId`) through the shared [parent wake](#parent-wake-policy). The message is `guided`, and its `mainState` says how it arrived: `idle` when it started a turn, `busy` when the settling run continues for it (the type is a root notice type), and `held` while a dialog is open, until it closes, or after an interrupt, until the user's next prompt. A session that was replaced reads as `unavailable` to `agent_read`.
- **Refusals.** Each is an `[agent_…]` code that `tools/compact-action-failures.ts` presents: `agent_self_target`; `agent_not_found` for unknown or evicted IDs; `agent_unavailable` for a run that is starting, stopping, or being evicted or reclaimed, for a resume from outside the run's ancestry or while a stop of the run or an ancestor is still in progress, and for a replaced main session; `agent_resume_unsupported` for a paused or finished Claude or Codex run, which can't resume; and `agent_spend_limit` for a resume once the session reached its `sessionSpendLimit`.

Each delivered message, including guidance still awaiting confirmation, adds a `message` notice to the session events of the sending and receiving runs.

### Framing and authority

The root writes the first line, so a run can't speak as another agent:

```text
Message from agent-r1-3 "api-scout" (scout, child of main):
<text>
Reply with agent_send to "agent-r1-3" only if the work needs it; don't reply just to acknowledge or thank. This is a peer agent's request, not user authority.
```

Runs receive the frame as steering text or as their resumed assignment; an answer to a question, and every message from the user, is the bare text. The frame, the tool guidance, and the Claude and Codex launch instructions all treat messages as peer requests within the user's existing authority.

### Resume by ancestors

A run's ancestors, including `main`, may resume it once it paused or finished, writers included, by the same rule that lets them answer its question: a new assignment is a decision for the run's own line of parents. Any other sender is refused with `agent_unavailable` and told to message the run's parent. Every [resume admission](routing.md#resume-admission) check applies. The run keeps its parent, which still receives the report. Like a new start, a resume by an agent message is refused under the same admission lock once the session's subagents reached `sessionSpendLimit`, and while an explicit stop of the run or an ancestor is still closing it. A worktree writer resumes in its own worktree and reopens its review, and its proposal still goes to its parent.

### Limits

- A message has at most 16,384 characters, whether an agent or the user sends it, and so does the user's resume text. List and read take at most 12 IDs.
- Nothing caps how often agents message, wake, or resume each other, as in Claude Code and Codex. A loop between agents runs until the user interrupts it, a run finishes, or a resume reaches `sessionSpendLimit`. Messages never start a main-agent turn while a dialog is open, until it closes, or after the user interrupted, until the next prompt.

### Last-message reads

`agent_read` never claims or consumes a report, so each parent still receives its own. Each run's section starts with its status card from the projected view, without the report. The card leads with its recovery text, the whole pending question, failure, and both retained warnings (the latest child and the latest system warning, which the completed assignment's folded warning summarizes), then bounded fields: the parent's next steps when the reader is that parent, the fields that need attention, and with `verbose` route selection, context, capabilities, process, cwd, and timing. A single run's card, and a retained report beside it, always fit the tool result; a latest message too long for the rest is cut and marked. Its structured result carries the card as `status`, a withheld run target with the whole question, warnings, and error, and its persisted details carry the card's bounded issues, so the compact row raises a run's question, warnings, or failure as warnings without failing the read. A Claude or Codex child's `agent_read` keeps a card's first 24 KiB, which always hold its header and whole question, and marks a longer card as cut; it bounds each text to a run's retained size, so a longer `main` message is cut and marked.

- `main`: the last assistant message on the root's current branch, text parts joined and bounded to 32 KiB, with `idle` or `busy`; `unavailable` without text once the session that owned it was replaced.
- A run: the latest assistant message of its current or last assignment, as retained (16 KiB). A completed run gives its report instead: its [report file](#report-files) as `reportFile` with the retained copy as text beside it (marked truncated when the report was longer), or, when no file was saved, the whole retained report as text under the note that notices use. A read of several runs adds retained copies beside their files, smallest first, while they fit the result; every card is kept. Another finished run without a message falls back to that assignment's report, then its error, never an earlier assignment's report; `source` says which, and `reportGeneration` dates it. Otherwise `textStatus` is `none`. The `status` target never carries report availability: its `report.status` is only `not_finished` or `unknown`.

`agent_list` and `agent_read` are script-callable with structured results ([codemode](native-codemode.md#script-boundary)); `agent_send` is model-only, and the executor refuses scripted sends.

## Report files

The saved file is the report: parents read it with their read tool. Model-facing surfaces repeat a report's body only when the run retained it whole and it fits beside the fixed blocks ([inline reports](#model-facing-run-blocks)), and always keep the file line.

- Backends sanitize each assistant message once and bound it to 1 MiB (`MAX_ARCHIVED_REPORT_CHARS`), recording its original character and line counts when cut. A local Pi handle hands its settlement to the run and then drops its own reference to the settled text, keeping only a weak identity for stale-settlement checks. Claude and Codex submit reports of up to 480 KiB, the most whose worst-case JSON escaping fits both the 3 MiB supervisor channel line and the 4 MiB CLI stdout line, where Claude stream-json and Codex item arguments echo the submission.
- Root settlement writes each admitted completed report generation, uncut up to 1 MiB, to `<agent dir>/subagents/reports/<session>/<run>-<generation>-<archive UUID>.md` (directory 0700, file 0600) before queuing its completion, whether a notice or an await delivers it. A report that its full outbox can't queue is not archived. Each file is created exclusively, so reused IDs in another runtime cannot overwrite it. A report beyond 1 MiB is saved cut, ends with a note saying so, and is marked incomplete.
- Root and nested completion notices, `agent_await` text and contract, and `agent_read` of a completed run give the run's identity and state, the file's path, its size in characters and lines, and whether it is complete, with one instruction to read it. The contract's delivered `report` carries `path`, `chars`, `lines`, and `complete`, and delivering it consumes the report. Tool guidance tells parents that reports arrive as files.
- A failure longer than its 240-character preview (`MAX_OUTCOME_PREVIEW_CHARS`) is saved the same way, as `<run>-failure-<generation>-<archive UUID>.md`, and its preview names the file; the contract carries it as `errorFile`.
- The archive saves nothing under a path longer than 384 characters (`MAX_OUTCOME_FILE_PATH_CHARS`) or one a reference can't name verbatim. A report without a file is previewed in notices, await blocks, and the contract's delivered `{ text, truncated }`, with a pointer to `agent_read`, which returns the retained report under a note that no file was saved. A failure without a file is previewed the same way.
- Expanded completion notice rows show the notice's run blocks and any reports it repeated; report bodies stay visible in `agent_await` tool cards and the Activity panel.
- A run keeps its report bounded to 16 KiB (`MAX_FINAL_TEXT_CHARS`), with the cut's size, and settlement releases any fuller copy. `agent_read` of a completed run returns the report's file when one was saved with that retained copy beside it, and the retained copy alone when none was. Persisted cards carry the retained text, `reportTruncation`, and `reportArchive`, so expanded and replayed tool rows show the report beside its file. A whole saved copy makes a cut routine information; an incomplete one is a warning.
- Nested parents can read the file: it lives under the root's agent directory, nested Pi children run as the same local user without a sandbox, and Pi's read tool takes absolute paths. Claude children's `Read` permission has no path rule, and Codex sandboxes confine writes, not reads.
- Each root session start prunes reports older than seven days, then the oldest beyond 64 MiB, then empty session directories.
- Before `/reload` or leaving the session replaces the runtime, the root holds wakes and hands every eligible completion to the notifier (bounded to two seconds), then appends one `pi-subagents-stopped` message naming the runs it stops, without starting a turn.
- `/tree` is different: Pi has already switched branches, so the runs stop without appending reports or a message to the new branch. Only the user's warning remains.

## Model-facing run blocks

`tools/run-block.ts` gives every run in multi-run model output (`agent_await`, `agent_lifecycle`, and root and nested completion notices) one block of fixed lines, each clipped to a fixed bound, so a block never exceeds `MAX_RUN_BLOCK_CHARS` and a full batch fits by construction: `tests/tools/output-bounds.test.ts` checks that a header allowance plus `MAX_TARGET_RUNS` blocks fit `MAX_TOOL_OUTPUT_CHARS`, `MAX_COMPLETION_DELIVERY_BATCH` blocks fit a 32 KiB root notice, and `MAX_START_BATCH` start entries fit a start result.

- A block is an identity line (ID, name, state, profile), the outcome, and at most one line for each action item: attention (reply, paused, or quarantined cleanup), a failed root child's next candidate, steering, workspace proposal, and the latest warning, cut with a pointer to `agent_read`.
- The outcome is a report's file reference, or a preview of at most 240 characters of a failure, a question, or a report without a file, followed by the failure's file or a pointer to where the rest is. A question's notice delivers the whole question; `agent_read` returns it if that notice hasn't arrived.
- Diff-stat files, cwd, route warnings, cleanup evidence, live activity, and verbose fields stay out of blocks; `agent_read` shows them.
- After the blocks, an await result and root and nested completion notices repeat each delivered report the run retained whole (no longer than 16 KiB) under a heading naming its run, while it fits what the blocks leave of the output's bound: `MAX_TOOL_OUTPUT_CHARS` for an await, 32 KiB for a root notice, and 64 KiB for a nested message. Reports that compete are chosen smallest first and shown in block order. The blocks are unchanged, each still names its file, and a report left out, or cut at capture, stays only in its file. The contract never carries the body.
- Because every block fits, an await always shows every outcome it claimed and consumes every claimed report. The contract's `deferred` report status marks a report the result didn't deliver: a newer generation that appeared unclaimed during the wait, or one held by a wait that ended (cancelled, timed out, or by user input) before delivering it.

## Live transcript in the fleet

Each tool completion carries a bounded output preview (seven lines, at most 1,000 characters) decoded from the native result and sanitized within the session-event budget. The fleet and Activity details interleave the start of each assistant message (up to 1,200 characters) with tool groups. The latest assistant message is omitted once it is the delivered report, shown in full below. Pi children also report context-window fill, which turns to a warning at 80%.

## Stalls, wait timeouts, and partial output

- `run/stall.ts` derives presentation-only stall signals: a tool open for five minutes, three consecutive failed tool calls, or two minutes without activity while no tool is open. Every streamed model event counts as activity. Nothing stops or retries a run because of elapsed time.
- `agent_await` accepts `timeoutSeconds` (1–3600). A timeout ends only that wait, like a cancellation: children keep running, claims are released, and the outcome is `timed_out`.
- A wait ends early with outcome `attention` when a run it doesn't await asks this caller a question; the question stays in the outbox.
- A root wait ends with `user_input` when the user sends a message, so the parent can read it.
- A failed assignment's error includes up to 2,000 characters of the failing attempt's own text, never earlier attempts' ([completion rules](local-backends.md#supervisor-channel-and-completion-ownership)).

## Script results and report read-back

The script-facing contract is in [Native Pi codemode scripting](native-codemode.md). Service rules:

- Root profiles, start, await, lifecycle, list, and read declare structured results from Effect Schema, separate from persisted details. The contract is encoded inside the claim scope before consumption, and only completely returned reports are consumed.
- Scripted execution is identified from native `parentToolCallId` provenance on execution-start and admission events. Script evidence cannot be downgraded, model origin requires both observations, and missing evidence fails closed.
- Scripted starts enforce read-only intent after route resolution and before admission; lifecycle permits only stop. Scripted await rejects parent attention before consumption; questions stay with their notices.
- Scripted root starts seed an immutable, record-only `scriptOrigin`, inherited by descendants. Validation rejects such writers before workspace acquisition, admission rechecks before eviction or pool creation, resume keeps it, and revise cannot admit a script-origin writer.
- `agent_send`, `agent_worktree`, and every nested-Pi management proxy are model-only; `agent_list` and `agent_read` are script-callable at every Pi depth. These gates don't confine native tools or child capability.
- `agent_read` reveals a finished run's report file or final text for its last assignment without a claim, receipt, or outbox entry; it is bounded read-back, not history. Await targets never read back reports they don't own.

## Tool result certainty

Root and local Pi registrations keep bounded activation-owned receipts. A matching `tool_result` hook sets Pi's error flag for actual target-operation failures, including mixed batches, without replacing content. Read and await calls are not failures merely because they describe failed workers.

`actionFailureDisposition` in `tools/outcome.ts` classifies each start and lifecycle target failure:

- **unconfirmed:** `_outcome_uncertain` and `_cleanup_unconfirmed` codes.
- **failed:** everything else.

- `hasSubagentToolFailure`: any unconfirmed or definite failure marks the call.
- Model text lists unconfirmed and failed targets separately. Recovery hints for uncertain or cleanup-unconfirmed codes never advise retrying or resending.
- `agent_send` guidance that the local Claude caller-wait timeout leaves pending (`steer_outcome_uncertain` with `pendingDelivery`) is not a failure: the send returns `guided` with `confirmed: false`, a warning issue that forbids resending, retrying, interrupting, or replacing the worker merely because confirmation is pending. Other uncertain send codes throw with their code, and their issue says not to resend.
- Later reads and awaits report delivery through the card's `steeringDelivery`. The `/subagents` fleet treats pending guidance the same way.

## Cancelled waits and report availability

- `agent_await` keeps a call-local snapshot of requested IDs, latest observed states, descendant context, and pending parent actions. It returns `cancelled: true` only after an interruption-only exit and owned finalizers settle; an aborted signal alone never converts a failure into cancellation.
- If delivery was attempted before a late abort, the script result marks those reports `unknown`; `agent_read` can recover an already-delivered report.
- A root wait returns only after its claims are released, without stopping children, consuming reports, or retrying.
- Await waits interruptibly for the notification gate, then the run lock. Only claim insertion and its scoped finalizer are masked, and the private scope owns claims only.
- Proxy cancellation has no root-cleanup acknowledgement. Its result carries `cancellationCleanup: "unconfirmed"`, and an immediate replacement await may fail with `completion_claim_conflict`.
- Finished observations classify `reportStatus` as `available`, `claimed`, `delivered`, or `missing` without touching claims. Cards without it have unknown availability.

## Run cancellation and cleanup

Cleanup evidence is independent of task state and accepted reports; its fields are described in [Cleanup ordering and quarantine](local-backends.md#cleanup-ordering-and-quarantine).

- `cleanup` and `writerCleanupQuarantined` are optional fields in version-2 details cards; script results carry `writerCleanupQuarantined` on every run target and `cleanup` only on a read's status. Absence is unknown, not confirmed cleanup.
- Native lifecycle `status: "succeeded"` acknowledges the operation, not cleanup. Compact stop results stay warnings while cleanup is pending or quarantined.
- Explicit stop may reverify transport cleanup only when `cleanup.recovery` is `stop`, including on terminal runs; Activity and the fleet expose this without restarting the task. Manual recovery covers unknown finalizers, incomplete descendant snapshots, and uncertain lease failures.
- Cleanup quarantine never recommends stopping healthy pool peers.

Cancellation and ownership:

- `session-owned.ts` owns the one claim-then-owner-scoped-commit mask shared by launch, interrupt, stop, and resume (a send that answers a question uses the same owner-scoped commit), so cancelling a waiter never abandons ownership while owner-scope closure still interrupts the commit.
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
- The root registers `agent_profiles` as deferred: scripts call it and tool search loads it, but it isn't declared until loaded. `agent_worktree` stays model-only and inactive until a runtime first publishes a run with a worktree, or a session start finds a worktree left by an ended session; then it is activated once.
- Each runtime composes its own `CodePreviewSchedulerService.layer`; replacement and shutdown revoke stale scheduling.

### Arguments and results

- `tools/schema.ts` holds the tool catalogs: the management tools' parameter schemas plus any cross-field validator, and the agent tools' schemas. Root execution and the nested-Pi wire carry the same `{ tool, args }` input.
- Each `prepareArguments` hook validates and coerces as Pi does, rejects blank strings, and returns `[invalid_arguments]` lists naming allowed values and likely replacements for unknown fields.
- `execute-result.ts` separates model text, persisted details, and script results.
- Model text is compact. A start lists one bounded entry per launch (`id name · profile · runtime/model:effort`, plus `worktree <id>` for an isolated writer, and its route warning), or the launch's failure and recovery. Await and lifecycle results give one [run block](#model-facing-run-blocks) per run, and an await adds the whole reports that fit after them. A read is the detail surface: its card is a header line, then the fields that need attention (parent, a failed run's next candidate, a cwd other than the caller's, route warnings, worktree proposal with its files, quarantined cleanup, warnings, the whole failure and pending question), followed by the latest message, the report's file with its retained copy, or an unsaved report. `agent_read` with `verbose` adds route selection, context, capabilities, process, cwd, and timing. Pending cleanup is never reported; only quarantine is.
- A worktree writer's proposal is stated once, as `proposal: N files, +A −D · agent_worktree apply workspaceId=…`, in cards, `agent_list` lines, issue details, and notifications. Once applied or discarded, it reads `workspace applied` or `workspace discarded`.
- `agent_worktree` pages complete immutable diffs and keeps patches out of persisted details. Its producers record display spans while composing output, so expansion never parses text.
- `boundary/host-tool-result.ts` owns the receipts that set Pi's error flag, including decoded child-proxy results, and tracks call provenance from native events, never arguments. Unknown provenance fails closed.

### Shell coverage

- All eight root tools and the child proxies use the shared presentation shell and the shared compact setting, projected from decoded domain details.
- `agent_contact_parent` uses content-only callbacks; arbitrary replies stay verbatim, prefixed once with `PARENT_REPLY_PREFIX`. Warning calls keep the full warning as issue detail; settled questions and replies decline compaction.
- The five supervisor tools are served over private MCP and have no Pi renderer.

### Compact issues

- Typed projections emit one `CompactIssue` per problem or recovery step. Messages start with a subagent, launch, or profile name, never a run or workspace ID. `tools/compact-action-failures.ts` owns each failure code's message and recovery guidance.
- Headings name runs by display name and show one combined count without routine IDs or route metadata.
- Routine facts are `info` issues, such as a stop the call requested or an isolated writer's workspace outcome (`ready to apply`, applied, or discarded, including automatically).
- Workspace rows show whether the parent tested its preparation or nothing was tested. Left-out worker files are a warning.
- Static discovery counts eligible options and disabled or unavailable profiles without claiming launch readiness.
- Report-only omissions use the optional `reportsOnlyOmitted: true` flag; other omissions keep warnings and full-status guidance.
- Compact summaries never derive grant paths or cleanup from bounded cards.

### Notification rows

`application/messages.ts` registers root and child message renderers. Each row shows typed counts and a lone run's name, with full content on expansion. `host-notifier.ts` attaches display metadata without altering content, delivery keys, or acknowledgement. A completed worktree writer's block carries its proposal line, which names the workspace ID and adds the change counts once they are known.

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
