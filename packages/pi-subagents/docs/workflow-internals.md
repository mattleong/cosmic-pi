# Workflow internals

Part of the [pi-subagents](../README.md) architecture documentation.
[ARCHITECTURE.md](../ARCHITECTURE.md) has the ownership map, and [Workflows](workflows.md) describes the user-facing behavior and its limits.
This page covers how the runner in `src/workflow/` owns runs, admits agents, persists results, and recovers after a restart.

## Modules

- `service.ts` is the session-scoped `WorkflowService` (`start`, `stop`, `skip`, `status`, `list`).
  It validates a start, registers the run, forks one run fiber per run into a `FiberMap`, and ends each run in `finish`.
  `errors.ts` holds its tagged errors.
- `runs.ts` keeps every run view in one `SynchronizedRef`, together with the live runs' controls (skips, stop signal, journal lock), and coalesces publishes to the host's synchronous Activity bridge.
- `source.ts` loads inline scripts, saved workflows, script files, nested `workflow()` references, and resume replays, and reserves run ids for planned agents.
  `script.ts` parses and validates a script and its `meta` before anything runs, trimming meta phase titles the way `phase()` titles are trimmed.
  `args.ts` compiles `meta.args`, checks start and nested `workflow()` args against it, and summarizes it for saved-workflow listings and refusals.
- `members.ts` builds a run's sandbox members over the service's state.
  `agent.ts` handles one `agent()` call, `options.ts` decodes its options, and `agent-settlement.ts` turns its outcome into view, usage, and journal bookkeeping.
- `admission-queue.ts` and `admission.ts` own FIFO admission, `budget.ts` the token budget with `delegation.ts` tracking what agents' own subagents spend, `reuse.ts` resume replay order and writer-aware reuse, and `attention.ts` the status view of agents that need a person.
- `state.ts` and `model.ts` hold pure view transitions and bounds.
  `notification.ts` builds the completion notification and its result budget, `run-text.ts` holds the text sections the notification, status, and Activity detail share, and `delivery.ts` delivers notifications.
- `journal.ts` is the in-memory resume store.
  `store.ts` (`WorkflowStore`) is the single persistence entrypoint for saved workflows, script files, and run files.
  `results.ts` defines a results-journal line, `run-record.ts` the `run.json` record, `run-record-writer.ts` keeps that record current, and `recovery.ts` reads the files of runs memory doesn't hold.
- Boundaries: `codemode-sandbox.ts` runs scripts, `host-workflow.ts` captures the starting tool call's host, `workflow-run-files.ts` owns run-file I/O, `workflow-result-file.ts` saves a clipped result's full value to a temporary file, and `process-liveness.ts` tells whether a record's process still runs.
- `tools/workflow*.ts` register `subagent_workflow` and format its text and compact presentation.
  `ui/workflow-activity.ts` projects runs into Activity items, and `ui/workflow-activity-detail.ts` writes their detail panes.

## Run lifecycle

- A start loads and validates the source, `args` (their size, then the script's `meta.args` schema when it declares one), and any resume replay; a failure rejects the call before anything runs.
  It then sizes the run's slots, creates its budget, reserves the planned agents' run ids, and saves the script copy.
- Registration is one uninterruptible step: the journal opens the run, the subagent service opens it as an owner, the view and controls are added, and the run fiber is forked.
  An open owner therefore always has a fiber that will close it.
- The run fiber writes `run.json` before the script starts, forks the per-minute run-directory refresh and the budget watcher into the run's scope, and then runs the sandbox.
  It aborts the script when the run's stop deferred or its `failed` deferred completes; the host completes `failed`, as for a call past the agent limit, to fail the run with that failure whatever the aborted script returned, unless a stop came first, so no catch in the script can keep the run going.
- `finish` runs once the script's scope has closed, so every `agent()` call has settled.
  In order, it closes the run's owner, removes its controls, records the outcome and bounded result, evicts old finished views, and writes the final record. Unless the session is tearing down, it then notes how the run ended in the journal, so a teardown before Pi accepts the report still says so, and forks notification delivery.
- `stop` notes the stop in the journal, marks the run `stopping` with who stopped it, and completes the run's stop deferred, which closes the sandbox, as one uninterruptible step.
  Only its wait for the run fiber is interruptible.
  The aborted script gets about ten seconds (a five-second close bound, then a five-second settle) to hand back its text output, and closing the run's scope bounds the sandbox's close the same way, so a worker that never exits can't keep the run from finishing.
- A stop the main agent requested sends no notification, because its result carries the state, unless its call is interrupted before returning; the finished run then sends its stopped notification like any other stop.
- `skip` (`skip.ts`) first marks a planned agent of a live run that no call has claimed as skipped, under the views' lock, so it can't race the claim; otherwise it completes the skip deferred of a queued or running agent, found by its reserved subagent run id, which resolves that `agent()` call to `null`.
  A planned agent claimed meanwhile is queued or running by then, so its skip reaches that agent.
- `layer.ts` builds `WorkflowService` on `SubagentService`, so on replacement or shutdown the workflow finalizers run first, in reverse acquisition order:
  1. the Activity publisher's closed flag, so a closing session publishes nothing and a pending publish is dropped;
  2. delivery's closed flag, then the interruption of background deliveries;
  3. the run fibers, whose own finalizers stop their agents while the subagent service is still open;
  4. last, the capacity queue's watcher.
- A torn-down run is recorded as `interrupted` and left open in the journal, so the next activation announces it.

## Sandbox and host calls

- `boundary/codemode-sandbox.ts` runs each script in a fresh in-process `CodemodeSandbox` from `@earendil-works/pi-codemode`, with Pi's 256 MiB memory bound and no timeout.
  Scripts get no Pi tools, only the `__workflow.agent`, `event`, and `load` members behind the hooks that `workflow/prelude.ts` defines in the VM.
- Host calls run as fibers of the run's scope through a `FiberSet` runtime, so closing the scope interrupts and joins every call, and each call's own scope stops its owned subagent.
  Arguments are decoded synchronously, so each call's first step runs as the sandbox issues it and calls start in script order.
- The prelude marks errors from invalid calls, which `parallel()` and `pipeline()` rethrow instead of resolving to `null`.
  `load` takes `[reference, args]` and fails, before adding the nested phases, when the reference doesn't load or args don't match the nested script's `meta.args`; like `agent()`'s host member, it rejects only for invalid calls, so the prelude marks every rejection from it as one.
  A call the budget refused replies with a `refusal` message instead of a result; the prelude counts the reply's output tokens, then throws the refusal as an error named `WorkflowBudgetError` with a budget marker of its own, which `parallel()` and `pipeline()` turn into `null` without a per-item warning.
  A run that error failed gets a retry line in its notification and status that says a resumed run gets a new budget.
  `budget.spent()` sums the replies' output tokens, the same per-call count the budget settles, the agent's own subagents included, so it matches the budget's settled count once every reply has arrived and excludes agents still running.
- `boundary/host-workflow.ts` captures the starting tool call's Pi host, context, environment, one profile snapshot, and its nesting policy for the whole run.
  `checkAgent` rejects unknown profiles, invalid `writes`, and writer options on read-only profiles before a call queues, and reports whether the profile writes.
  `resolveAgent` resolves the route, and any fork, once, when the call first holds one of its run's slots; a queued call keeps that request while it waits.

## One agent() call

- `agent.ts` decodes the call and its options, compiles any result contract, and computes the resume key from the prompt, options, and contract digest.
  `options.ts` rejects a Claude Code route option (`model`, `effort`, `agentType`) with the profile to pass instead, and trims the profile, so the key names the profile the call runs with (`generalist` when it names none).
- A call that would claim a planned agent the user skipped (`reuse.ts`, in its turn when the run resumes another) claims it in one step with publishing its view, already `skipped`, under the entry's run id and with the next call position, which ignores the agent limit since such a call can't repeat.
  It registers no skip and settles at once without a launch or a check: it holds no slot, counts nothing against the budget or usage, so it resolves `null` even once the budget is spent, logs the skip warning, and writes its results line.
- Otherwise the call consults the resume replay in its turn (see [Resume and reuse](#resume-and-reuse)); a reused result is recorded and settled at no cost.
- Otherwise the call takes the run's next call position.
  A call past the run's agent limit is an invalid call and also fails the run through its `failed` deferred, so a retry loop that catches every error ends there too.
  A call made once the budget is exhausted then replies with the budget's refusal without queuing, so it gets no view; it still used a position, so a script that retries refused calls stops at the limit.
- Queuing publishes the agent's view atomically.
  The call claims the matching planned agent's reserved run id (`state.ts`), and that entry's phase when it has none, or reserves its own, and registers its skip before Activity can offer it.
  Outside a phase, a call claims only an entry its own workflow declares: the prelude passes a nested `workflow()`'s name with each of that workflow's calls, and the entries it adds carry that name.
  A call whose entry the user skipped after the call looked for a skipped one is published already `skipped` here and settles the same way.
- Only the launch is interruptible.
  Queuing, and the bookkeeping after the call settles (its view, usage, budget, resume journal entry, and results journal line), are not, so a settled call always records its line even when the run stops meanwhile.
  An interrupted call is recorded as `stopped`.
  A writer stopped or skipped while it ran keeps its worktree unchecked, and its results line still names that worktree from its subagent's view, so a later Pi process lists it for recovery.
- The run's usage adds each settled live agent's usage and tool uses, from its owned outcome or, for an agent without one (skipped or stopped while running), from its subagent's view.
  Reused results add nothing.
- A settled worktree writer's worktree first goes through the subagent service's `workspaceDiscardUnchanged` (`run/workspace-review.ts`):
  - it waits up to ten seconds for the writer's process cleanup, then for its turn among root workspace operations, and the run's stop request or an interruption ends either wait early, keeping the proposal;
  - holding the binding like any root workspace operation, it has the engine check the worker against its baseline and, under the engine's lock and then the run lock, discard it unless another run works, or worked meanwhile, inside its trees;
  - the view and results line then carry `unchanged`, and a failed check or discard keeps the proposal with one warning.

## Admission

- `admission-queue.ts` holds FIFO grants ordered by queue time, then by the call's rank among its run's calls queued at that time, then by run start order, so runs at equal times alternate.
  Each run has its own slot queue, sized by `workflowRunConcurrency`, and the session has one capacity queue.
- The service creates the capacity queue first, so its watcher fiber, which pumps the queue on every admission-revision change, outlives every run fiber.
- In `admission.ts`, a call first holds one of its run's slots and resolves its launch once.
  A cheap `queuedWriterConflict` check runs before any attempt.
- Each start attempt then waits in the capacity queue, which grants starts in queue order only as far as the root's `queuedStartsAdmissible` allows.
  A grant lasts until its start settles; the root counts it by the call's reserved run id only until the start holds a launch slot, an eviction claim, or a record of its own.
- A start refused for capacity waits again in its place.
  A transient writer conflict (`SubagentWriterConflictError.transient`) gives the slot back and waits, holding nothing.
  A change in that writer's paused state only updates the waiting reason.
  After each admission-revision release it asks `queuedWriterConflict` again, and once no transient conflict remains it waits for a run slot again.
  Other refusals resolve the call to `null` with a warning.
- On the root side, `run/admission-signal.ts` keeps an admission revision that advances only when a holding that can refuse a start is released: a process slot, writer slot, file a writer or retry claims, unfinished cleanup, retry or eviction claim, unavailable writer pool, or a worktree launch's held direct-child slot.
  The service rechecks it on every exit from the run lock and every publication; release points outside both call `RunContext.recheckAdmission`.
- `queuedStartsAdmissible` and `queuedWriterConflict` check under the run lock, without validation, backend resolution, or preflight.
  They count only holdings whose release advances the revision, and only conflicts that clear by themselves, so they never keep waiting a start that a full start would admit.
- Main-agent reserve: workflow starts (`request.workflow`) leave `WORKFLOW_ROOT_RESERVE` (2) root slots free for the main agent while another workflow agent holds a slot or a let-through start is pending, in launch admission, the worktree pre-check, and the queued-start checks alike.
  A workflow agent holds a slot through its run, or through the launch slot of a worktree it is still creating (`LaunchSlot.workflow`), so a reader of another run can't take the reserve meanwhile.
  With no workflow agent holding a slot, one may take any free slot.
  The main agent's own starts ignore the reserve, and `workflowRunConcurrency` keeps each run within the slots workflow agents may hold.

## Token budget

- `budget.ts` counts a run's output tokens.
  Settled agents count the larger of their reported and live output, and running agents count their live usage from the subagent projection.
  Each agent also counts its descendants, the subagents whose `parentRunId` chain reaches it (`delegation.ts`), and its settled spend, which the run's usage and the results line carry, includes theirs.
  The projection drops ended records once enough runs end, so each descendant's latest spend is kept until its agent settles.
- Its watcher fiber, in the run's scope, follows every projection change: it notes running agents' descendants and, until exhaustion, measures; the view shows the live count each time it grows by a twentieth of the total.
- Exhaustion is sticky.
  It ends every admission wait and every start still under way (interrupting a start stops an agent already admitted).
  Queued calls it refuses settle as skipped with the reason `budget exhausted` and reply with the refusal, which their `agent()` call throws, and the first refusal logs the run's only budget warning; every refusal is counted for the view.
  Agents already running finish.

## Resume and reuse

- A replay is a per-key FIFO over the earlier run's successful results, keyed by prompt, profile, schema digest, isolation, and writes.
- `reuse.ts` makes calls consult the replay one at a time, in the order the script issued them, each taking its turn in its first step.
  An entry taken from the replay is settled, journal line included, before a stop takes effect.
- A journaled worktree writer is reused only while the subagent service's `workspaceBindingStatus` reports its worktree `pending` (listed again as a proposal) or `integrated` (not listed).
  The binding is read in the call's turn; otherwise (`closed` or `unbound`) the entry misses, the call runs again, and the run logs why.
  The workflow service keeps no worktree set of its own.
- A worktree writer whose worktree was discarded because it made no changes is journaled like a reader: its memory entry has no `workspaceId`, and a results line with `unchanged: true` replays without one, so a resume reuses it without a binding check and never lists it as a proposal.
  A writer whose discard failed keeps its proposal and follows the binding rules above.
- A call that claims a planned agent the user skipped claims it in its own turn, so no later call can see that entry, and takes nothing from the replay; since it starts nothing, a writer's skipped call never closes the replay, and the earlier result stays for any later call with the same key.
  A skip that lands after the call took its result is too late, and the reused call claims the entry as usual.
- A call with a writer profile and without `isolation: "worktree"` that misses closes the replay in its own turn, whatever the session writer mode, so every later call runs live.
  That includes such a writer whose earlier result came from a worktree that can no longer be reused, since the session's writer mode may now put its rerun in the checkout.

## Persistence

### Memory journal

- `journal.ts` keeps `agent()` results for resume in a process-global `Symbol.for` slot (`workflow-journal/v3`), the module's only `globalThis` property, so journals survive `/reload` and `/tree`.
- Journals are keyed by Pi session id: at most 16 sessions, and per session the 32 most recent runs and 16 MiB of result text, never dropping an open run or the newest closed one.
- A run stays open until Pi accepts its notification, or closes at once when it needs none.
  The next activation of the same session reports runs still open as `interrupted` before opening its own, and each stays open until its notice is accepted, so a notice lost to another teardown is posted again.
- Without a session id, journals last only for the activation and runs keep no record.

### Run files

- Each run has a private directory under `<agent-dir>/subagents/workflow-runs` holding its script copy, results journal (`results.ts` defines the line), full results too long for a line, and `run.json`.
  `store.ts` is the entrypoint, and `boundary/workflow-run-files.ts` owns the I/O.
- Saved workflows, script files and run files are read through core's `SafeFile`, the trusted project before the agent directory.
  `SafeFile` wants a canonical containment root, so the store resolves each root on every read: the agent directory or a script's directory can pass through a symlink, as macOS's `/tmp` does, and a run directory may not exist when the store is built.
- Every Pi process shares the runs directory, so a run start prunes only directories outside the newest 64 that were also unwritten for 24 hours, never one this session runs.
  Directory creation, journal appends, record writes, and the per-minute refresh while a run lives all count as writes.
  The refresh is short because timers don't advance while the machine sleeps, so a live run marks its directory again soon after waking.
  Run ids add three random bytes to the activation's clock-derived namespace, so Pi processes starting in the same millisecond get their own directories.
- Run files are best effort and untrusted.
  Readers require regular files inside the run's directory, decode records and lines strictly, and skip malformed ones.

### run.json and restart recovery

- `run-record-writer.ts` writes the record atomically (a temporary file renamed over it) before the script starts, on a stop request, when the run ends (`interrupted` under a teardown), and once its report or notice is accepted.
  Writes are serialized and best effort; the first failure logs one warning.
- `recovery.ts` reads the files of runs memory doesn't hold, and only when their record names this session: resume replays (results journal and full results, up to 16 MiB), notices owed after a restart, and status summaries.
- At activation the service reads the runs memory left open, then forks one fiber that announces them, skipping (and closing) any whose record another Pi process of the session already marked notified, and then scans the run directories for this session's newest 32 runs that a teardown interrupted, or whose process died while they ran or before Pi accepted their report.
  Records are filtered by session before that limit, so other sessions' runs never crowd this session's out.
  It announces each until a notice is accepted and marks the record; a run that ended by itself carries its final state (`WorkflowInterruptedRun.ended`), so the notice says how it ended.
- A record names its process by pid and the machine's boot time (`bootedAt`).
  A `running` record counts as live elsewhere only while its pid is alive, it names this boot (within a minute, for wall-clock adjustments), and its directory was written within two hours, so a reused pid doesn't hide a crashed run.
  A permission error from the pid probe still counts as alive, since a sandbox can forbid probing the user's own processes.

## Delivery and notifications

- `delivery.ts` retries a notification with backoff, from 100 ms doubling to 30 s, while the session is current.
  Only the delivery is interruptible: once Pi accepts a report or notice, closing the run in the journal and marking its record notified happen uninterruptibly, so a teardown can't leave an announced run open to be announced again.
- Workflow notifications use the `pi-subagents-workflow` message through the shared host notifier.
  Completed and failed runs join or start a turn; a user's stop, an interrupted tool stop, and interrupted-run notices wait for the next turn.
- `run-text.ts` holds the restart guidance, which sends a saved workflow or script file back to its own file and only an inline script to the run's copy.

## Activity projection

- `boundary/host-activity.ts` publishes the items `ui/run-activity.ts` projects, workflows among them from `ui/workflow-activity.ts`.
  Each run is one `kind: "workflow"` item whose summary is the narrator line (the newest line the script logged; the service's own lines, `workflowServiceLog` in `state.ts`, are agent-facing and never narrate), whose phases (at most 32) carry producer `work` counts, including `failed` and `skipped`, and `planned` counts, and whose stop runs in place after confirmation.
- Placeholders sit under each agent's reserved run id:
  - queued agents, with an in-place skip that asks for confirmation, at most 64 per workflow;
  - calls that settled without a subagent run, failed or cancelled with their reason, and marked `skipped` when the user skipped them or the budget refused them, at most 16 per workflow, failures first;
  - the script's unclaimed planned agents, at most 64 per workflow: pending with an in-place skip that asks for confirmation while the workflow runs, and carrying the workflow's `endedAt` once it finishes so never-run rows sort with its history;
    one the user skipped is no longer `planned` but a cancelled row marked `skipped` with its reason, dated to the skip, like the call that later claims it.
- Subagent run rows take the provider's `ACTIVITY_LIMITS.items` slots first.
  Every shown workflow then gets its row before any placeholder, live workflows' placeholders come next, and finished workflows' placeholders take what is left; a run id already shown is never repeated.
  Titles and text are clipped to Cosmic UI's `ACTIVITY_LIMITS`.
- The workflow item's `unphasedPlanned` counts planned agents in phases beyond the 32 published.
  Planned agents never count as work, nor skipped ones as planned, so a phase holding only skipped ones follows the rules for phases without work; the call that claims a skipped one counts as skipped work, like any skipped call, and phase `work` counts include results reused on resume as finished work and every failed call, started or not.
- The workflow source holds the last published views, the only ones the host holds revisions for, so detail and actions resolve against them between coalesced publishes.
  Stop and skip then act on `WorkflowService` state by stable run ids.
- A root-level member nests under its workflow by its own `run.workflow` membership while that workflow is running or stopping, and once the member reaches a final state, even after the workflow leaves the snapshot.
  A former member working again after its workflow ended is published as a root run.
  Resume is hidden on a completed member while its workflow still owns it.

## Owned runs

- `run/owned-runs.ts` owns the registry of in-process owners, such as workflow runs, and their claims on reports.
- `startOwned` admits an ordinary root child carrying `workflow` membership.
  Under the admission lock, launch claims completion generation 1 for the owner before the record is registered, so root delivery never selects it, and the claim is bound to the caller's scope.
- `awaitOwned` waits through questions and pauses, then consumes the generation in the same locked step that reads it.
  The outcome carries the run's usage and its tool-use count, which `run/events.ts` raises on each recorded tool start.
- Interruption, scope close, and `closeOwner` share one release policy.
  A run that is still live because its stop failed, or an unread completed writer report, is handed back to root delivery; everything else is consumed.
- Hand-back and `closeOwner` relinquish the run: root guards lift, and the record drops its result contract and switches to the ordinary system prompt built for it at launch (`releasedSystemPrompt`), so a later resume runs it as a plain root child.
- While an owner is live, root await, retry, and resume of a completed member fail with `workflow_owned_run`.
  Paused resume stays allowed, and question notices name the workflow.

## Structured results

- `domain/result-contract.ts` compiles a script's JSON Schema into a `ResultContract`: tool parameters (a non-object root wrapped under `value`), a strict-safety flag, a digest for the journal key, and a decoder.
  The subset checks and the import below live in `domain/json-schema.ts`, which `workflow/args.ts` shares for `meta.args`; an args schema is imported at its own root, since it never becomes tool parameters.
- Compilation rejects any `pattern` or `patternProperties` key, including under `propertyNames` and draft-07 forms Pi's TypeBox still reads, that isn't a string or doesn't compile with the ECMAScript `u` flag, since it would break the child's tool.
  Compiling never runs a pattern on input.
- The root imports schemas with patterns ignored, relaxes every `oneOf` to `anyOf`, and widens `integer` to a `number` that is a multiple of 1, so no script-authored regex runs in the root and integers of any size pass.
  Its decoder therefore admits more than the schema: it doesn't evaluate `pattern`, `format`, or `oneOf` exclusivity, and for an object with `patternProperties` it skips their value schemas and that object's `additionalProperties`.
  The child still receives the schema as written, and strict safety is computed from it.
- `boundary/child-process.ts` writes a local Pi child's schema into its private run directory and passes it with `--pi-subagents-result-schema`.
  `boundary/host-child-result.ts` registers the child-only `subagent_result` tool, which asks for strict sampling only for strict-safe schemas, ends the turn on acceptance, and sends at most two reminders per prompt.
- Submissions cross IPC as `structured_result`.
  `run/structured-result.ts` validates them and, under the run lock, records the first value for the current assignment epoch, refusing any after a committed pause.
- Claude and Codex report the value through the supervisor, whose report handler validates it with the same decoder and returns a mismatch to the model as a tool error.
- `run/settlement.ts` decides precedence.
  An accepted value completes the assignment with its canonical JSON, even over a tool-use ending, later text, or a racing pause.
  Otherwise valid JSON in the final text, whole or in the last fenced block, completes it; otherwise the run fails.
  A Claude or Codex report is checked again and fails with `backend_report_schema_invalid` on a mismatch.
- Resume keeps the contract on `record.launch`; retries and revision successors drop it.
