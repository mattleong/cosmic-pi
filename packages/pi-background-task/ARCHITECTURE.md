# Architecture

`pi-background-task` runs local commands in session-owned background processes. It exposes the
`background_task` tool, `/tasks`, and Activity/footer projections. Tasks are neither durable jobs
nor a command sandbox, and completion does not automatically send messages or trigger agent turns.

## Ownership and boundaries

- [Application](src/application.ts) owns the managed session-runtime slot and binds tools,
  commands, preview replay, and UI publication to an activation. [Layer composition](src/layer.ts)
  supplies configuration, process execution, task service, and preview scheduling.
- [Task service](src/task/service.ts) owns the registry, admission, stop/wait coordination, and
  scoped process monitors. Registry transitions and each task's mutable log buffer share a
  semaphore. [Registry policy](src/task/registry.ts), [admission](src/task/admission.ts), and
  [output matching](src/task/output-match.ts) keep deterministic work separate from orchestration.
- [Local-process boundary](src/boundary/local-process.ts) owns shell spawning, output streams,
  bounded ingress, process-tree termination, and release through Effect's process platform and
  core's process-tree helpers.
- [Log buffers](src/task/log-buffer.ts) own retained output and byte accounting;
  [publication](src/task/publication.ts) coalesces updates into immutable projections.
- [Config store](src/config/store.ts) resolves global and trusted project settings and handles
  explicit writes. Reading configuration never creates a default file or probes an untrusted
  project. [Settings controller](src/settings/controller.ts) adapts commands and settings UI.
- [Tool execution](src/tools/command.ts) produces text, presentation details, and a separate
  [native result contract](src/tools/contract.ts) from service facts. Renderers do not infer task
  state from log text or own processes.
- [Host UI](src/boundary/host-ui.ts), [Activity integration](src/boundary/host-activity.ts), and
  [manager](src/ui/manager.ts) consume projections. The manager owns local interaction state and
  delegates shared screen mechanics to Cosmic UI; service state remains authoritative.

## Lifecycle

Session start and successful tree navigation capture cwd, trust, and session identity, then
replace the runtime. Deactivation revokes publication and command capabilities before cleanup,
so settling old processes cannot repopulate replacement UI. Startup loads trusted preview
settings before the current activation registers its wrapped tool. History replay is
presentation-only and never starts tasks.

Tree navigation joins process-tree cleanup before activating a fresh registry. Tool callbacks
retain their activation token; `/tasks` captures authority for each invocation. Retained managers,
settings pickers, and Activity actions cannot target a later registry, even when task IDs repeat.
Shutdown closes admission and attempts to settle active processes before interrupting their monitors.

## Critical invariants

- Metadata is normalized and bounded before IDs, monitors, or processes are allocated, including
  calls that bypass the tool schema.
- Stop requests retain active capacity until exit is confirmed. A termination failure leaves a
  task `stopping`; `stopAll` attempts every captured task before reporting aggregate failures.
- Admitted readers retain their task record. Clearing or evicting registry entries removes
  discoverability without invalidating in-flight waits or reinserting removed tasks.
- Output and ingress are bounded independently. Dropped output remains explicit; literal waits
  never match across a dropped-byte gap. Wait and publication deadlines use monotonic time.
- Projections and log slices are detached and immutable. Neither consumer mutation nor later
  buffer eviction can alter earlier results or authoritative byte accounting.
- Structured results project domain facts rather than parsing display text. Encoding failure
  preserves the receipt of an applied action, without replay or rollback. A terminal state alone
  does not prove success or process-tree cleanup.

The focused [process lifecycle note](docs/process-lifecycle.md) explains cancellation handoff and
platform cleanup limits. [Task-service tests](tests/task-service.test.ts),
[process tests](tests/local-process.test.ts), [lifecycle tests](tests/lifecycle-stress.test.ts),
and [log-buffer tests](tests/log-buffer.test.ts) protect these invariants. Tool semantics, settings,
and rendering are described in the [reference](docs/reference.md).
