# Architecture

`pi-background-task` runs local commands in session-owned background processes. It exposes the
`background_task` tool, `/tasks`, and Activity/footer projections. Tasks are neither durable jobs
nor a command sandbox. A finish sends the agent a message, and may start its turn, only when the
task's start opted in with `notify`; otherwise completion sends nothing.

## Ownership and boundaries

- [Application](src/application.ts) owns the managed session-runtime slot and binds tools,
  commands, preview replay, and UI publication to an activation. [Layer composition](src/layer.ts)
  supplies configuration, process execution, task service, and preview scheduling.
- [Task service](src/task/service.ts) owns the registry, admission, stop/wait coordination, and
  scoped process monitors. Registry transitions and each task's mutable log buffer share a
  semaphore. [Registry policy](src/task/registry.ts), [admission](src/task/admission.ts), and
  [output matching](src/task/output-match.ts) keep deterministic work separate from orchestration.
- [Local-process boundary](src/boundary/local-process.ts) owns shell spawning, the task's stdin
  pipe, output streams, bounded ingress, process-group termination, and release. It runs commands
  in Pi's shell with Pi's command prefix, as the bash tool does, unless the package's `shellPath`
  replaces both; [host shell settings](src/boundary/host-shell.ts) are read when the runtime starts.
  It spawns through Node's child-process API so that it alone signals each group, using core's
  process-tree helpers and host-exit guard.
- [Terminal normalization](src/task/terminal-text.ts) runs per stream at intake. [Log
  buffers](src/task/log-buffer.ts) own retained output, bounded events, and byte accounting;
  [log paging](src/tools/log-page.ts) renders the labeled plain text results share;
  [publication](src/task/publication.ts) coalesces updates into immutable projections.
- [Config schema](src/config/schema.ts) defines the persisted fields and the config type;
  [options](src/config/options.ts) own bounds, normalization, and a setting descriptor for every
  field. The [config store](src/config/store.ts) resolves global and trusted project settings and
  handles explicit single-field writes. Reading configuration never creates a default file or
  probes an untrusted project, and a write never replaces a document it can't read.
- The [`/tasks` command](src/settings/controller.ts) opens Cosmic UI's Activity view when the
  runtime is available, and shows a notice when the runtime or Activity is not; the [settings
  subcommand](src/settings/task-settings.ts) adapts the shared settings command and picker.
- [Tool execution](src/tools/command.ts) produces text, presentation details, and a separate
  [native result contract](src/tools/contract.ts) from service facts. Renderers do not infer task
  state from log text or own processes.
- [Host UI](src/boundary/host-ui.ts) and [Activity integration](src/boundary/host-activity.ts)
  consume projections; service state remains authoritative.
- The task service decides when an opted-in exit notice is due. The [notice
  message](src/task/notice.ts) owns its stored type and redacted details. [Notice
  delivery](src/boundary/host-notice.ts) formats it and hands it to core's shared session wake, which
  starts a turn only for an idle session; in a subagent's own session it never starts one, since an
  idle subagent's run is settling, reported, or paused for its parents. A subagent's run end stops
  its tasks, so there the tool registers extra guidance, and a completed run that settles with tasks
  still running continues once per prompt with a reminder to wait for or stop them. That decision
  reads the published task projection without waiting: Pi commits settle entries before it checks
  whether the run was aborted, so a decision that waited could leave the reminder in a run paused
  meanwhile. The [notice
  renderer](src/ui/notice-message.ts) shows delivered and historical notices without delivery
  authority.

## Lifecycle

Session start and successful tree navigation capture cwd, trust, and session identity, then
replace the runtime. Deactivation revokes publication and command capabilities before cleanup,
so settling old processes cannot repopulate replacement UI. Startup loads trusted preview
settings before the current activation registers its wrapped tool. History replay is
presentation-only and never starts tasks. Command metadata and completions register eagerly;
the settings implementation loads on invocation, not during startup. Invocations capture the
session-slot generation and exact host signal before loading, pin that signal for downstream
handlers without freezing other host getters, and recheck authority before opening UI, changing
settings, or reporting failures.

Tree navigation joins process-tree cleanup before activating a fresh registry. Tool callbacks
retain their activation token; `/tasks` captures authority for each invocation. Retained settings
pickers and Activity actions cannot target a later registry, even if a task ID repeats.
Shutdown closes admission and attempts to settle active processes before interrupting their monitors.
If Pi exits without shutdown, core's host-exit guard kills every task group that has not settled.
Exit notices belong to the activation that started their tasks: closed admission stops the service
from sending any, and deactivation revokes the delivery callback before cleanup, so tasks stopped by
shutdown or replacement never message the agent.

## Critical invariants

- Metadata is normalized and bounded before IDs, monitors, or processes are allocated, including
  calls that bypass the tool schema. Only the monitor receives the full command; task snapshots,
  results, and UI hold a clipped display copy.
- Stop requests retain active capacity until exit is confirmed. A termination failure leaves a
  task `stopping`; `stopAll` stops every captured task concurrently before reporting aggregate
  failures. A stop or timeout that follows leader exit does not replace the command's outcome.
- Cleanup reaches each task's original process group, not processes that leave it. A settled
  group is never signalled again.
- Admitted readers retain their task record. Clearing or evicting registry entries removes
  discoverability without invalidating in-flight waits or reinserting removed tasks.
- Stored output is plain text: intake keeps printable text, newlines, and tabs, turns carriage
  returns into line breaks, and removes every other control and escape sequence, colors included,
  so reads, waits, and Activity share each event's text as stored and retained budgets
  count only that text. Events are split to a bounded size, and reads select whole events, so
  cursors page without skipping output.
- Retained budgets charge a per-event overhead, and evicted events are released at once. Each
  event owns a copy of its text, so keeping part of a large write never keeps the whole write
  alive outside the budget. Ingress has its own per-task bound outside those budgets, as does the
  ledger of recent discard totals that keeps loss reports exact: it grows by doubling with
  evictions to at most 4,096 cursors (32 KiB) while a task runs, and shrinks to 256 (2 KiB) when
  it finishes.
- Dropped output remains explicit to the reads that asked for it: a log read or output wait
  reports discarded output after its cursor or within its lines, never routine eviction it did not
  ask for, and literal waits never match across a dropped-byte gap. Each result reports only the
  loss within what it returns, and output lost after the newest event belongs to whatever follows
  it, so a cursor chain reports each discarded byte once. A finished task's trailing loss becomes
  a textless event with its own cursor. Wait and publication deadlines use monotonic time.
- Projections and log slices are detached and immutable. Neither consumer mutation nor later
  buffer eviction can alter earlier results or authoritative byte accounting.
- Structured results project domain facts rather than parsing display text. Encoding failure
  preserves the receipt of an applied action, without replay or rollback. A terminal state alone
  does not prove success or process-tree cleanup.
- An exit notice is sent at most once, from the registry transition that settles the task or the
  return of the last read in progress on it. A finished state that a tool read reports, the agent's
  own stop, including one that finds the task already finished, or a start that reported its spawn
  failure claims the notice first, so the agent never learns the same finish twice.

The focused [process lifecycle note](docs/process-lifecycle.md) explains cancellation handoff and
platform cleanup limits. [Task-service tests](tests/task-service.test.ts),
[process tests](tests/local-process.test.ts), [lifecycle tests](tests/lifecycle-stress.test.ts),
[real-process cleanup tests](tests/process-cleanup.test.ts), and
[log-buffer tests](tests/log-buffer.test.ts) protect these invariants. Tool semantics, settings,
and rendering are described in the [reference](docs/reference.md).
