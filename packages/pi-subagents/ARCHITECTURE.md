# Architecture

`pi-subagents` owns session-scoped background agents on local Pi, Claude, and Codex on macOS and Linux.

## Ownership and boundaries

- `extension.ts`, `application/`, and `layer.ts` register the extension and compose its Effect runtime through Cosmic Core's session-runtime slot. Root sessions own application services; nested Pi processes use authenticated proxies.
- `config/store.ts` is the configuration persistence entrypoint. `profiles/` owns route planning and the revisioned Current Session working set. `domain/` holds pure routing and file-claim policy.
- `run/` owns `SubagentService`: authoritative run records, admission and writer ownership, process lifecycle, assignment transitions, completion claims, and immutable fleet projections. `writer-pool.ts` encapsulates pool membership and lifecycle transitions; the service retains the shared run lock and run records. Factories receive the capabilities they need from the service's composition root.
- `backend/` translates Pi, Claude, and Codex behavior into normalized handles, controls, and events. `boundary/` and `supervisor/` own host integration, processes, files, leases, and authenticated transport. Run orchestration does not interpret native wire protocols.
- `workspace/` owns isolated-writer artifacts, Git operations, and durable setup- and verification-process quarantine. Run-level bindings retain parent authority and cleanup evidence; root workspace operations serialize separately from ordinary run activity.
- `delegation/` owns each delegation mode's prompt guidance. The root application applies Current Session's mode through `boundary/host-delegation-prompt.ts` and shows its profile set and mode in the footer.
- `tools/` owns public contracts, execution, and compact presentation. `settings/` owns commands and editors; `ui/` and settings rendering consume immutable projections. Host Activity actions recheck activation, revision, and capabilities before reaching services.

## Lifecycle

One root runtime owns the descendant tree and its processes, transports, leases, and fibers. A dedicated operation scope is retired after publication is revoked and before leaf-first backend cleanup, so blocked admitted work settles without publishing during shutdown. Only the current session-slot token may activate tools or publish state. `/tree` and `/reload` preserve the Current Session profile snapshot while replacing the runtime; the session's subagent spend survives replacement as custom session entries. Private run state stays until eviction or runtime end, and each root session start sweeps state that crashed or killed sessions left behind.

Launch planning captures a profile and nesting-policy revision. Immediate-parent model, effort, and fork facts come from authenticated Pi snapshots owned by the parent's run record; registry, authentication, trust, and tool policy remain root-owned. Candidate fallback ends when service ownership begins. Each assignment has a monotonic epoch; delayed events cannot change a later assignment. Reports and completion claims survive backend cleanup.

Natural completion leaves descendants running. Explicit stop and runtime replacement close the tree leaf-first. `/reload` and leaving the session first append pending reports and a notice naming the runs they stop, without starting a turn; `/tree` stops the runs without adding either to the branch the user moved to. Cancelling a caller after ownership transfer stops its wait while the session-scoped commit retains cleanup responsibility.

## Critical invariants

- Authenticated ancestry determines subtree visibility and target authority; caller-supplied identifiers never grant parent authority.
- Writer admission, assignment changes, completion consumption, and cleanup evidence remain coordinated under their owning locks. Cleanup disposition is independent of task outcome and preserves bounded, redacted phase/reason evidence without replacing reports or other warnings. Explicit stop may recover a quarantined process only through its original cleanup owner's observational proof; closed scopes and uncertain lease commits are never replayed. Pool member cleanup quarantine is independent of claim-containment admission pauses.
- Shared-checkout claims coordinate writers; they do not sandbox filesystem access. Destructive workspace operations serialize occupancy checks with admission and protect every artifact tree still held by a run. Orphan cleanup rechecks saved directory identity after lock waits, and collection rechecks predecessor references under the source lock. Worktree reports are proposals, and only an explicit direct-parent call applies one: `apply` or the review, prepare, and integrate path, each integrating an exact revision against current parent work. The coordinator discards a completed writer's workspace by itself only when it changed nothing. A nested Pi worktree writer owns the workspaces it creates from its worker tree and must resolve them before its own workspace can be reviewed, applied, integrated, revised, or discarded; once that writer has ended with confirmed cleanup, the root or its ancestors may only discard them. Another session's root may only discard a workspace, and only once its creating session's owner lease is free and no writer lease holds its worker tree.
- Only a child's main agent may submit its report or ask the parent a blocking question. Claude and Codex identify a native sub-agent caller at the call, and that identity, never output ordering, decides refusal.
- Tools and UI read frozen projections. A terminal state or returned start receipt does not prove cleanup or completion. Native result contracts remain separate from bounded presentation details.
- Delegation modes change only the root session's prompt guidance. They never restrict tools or reach nested children.
- Current Session edits affect later launches. Saved-set edits do not change the active working set, and Project writes recheck trust.

## Non-goals

Runs belong to one live root session, which owns their processes, authority, reports, and cleanup. Features that need a second owner are out of scope:

- **Detached runner or file-based run state.** Run records live in the root runtime under one lock; private files are scratch state that the root owns and the startup sweep reclaims, never a source of truth another process resumes.
- **Missions or schedules.** Work starts from a parent turn; nothing runs without a session to receive its report.
- **Watchdog reviewer.** Stall detection and the parent's own review supervise runs; a second reviewing agent would split the parent's authority.
- **User-authored agent files or agent memory.** Profiles route to a runtime and model; the parent writes each assignment's instructions, and runs carry no memory between sessions.
- **Lazy tool loader.** Tools register with the activation, and children receive the root's active tools at launch.
- **Pane inspectors.** The root's fleet and Activity views show every run's transcript from one projection.
- **Cross-session messaging.** Target authority comes from authenticated ancestry within one tree; sessions cannot address each other's runs.
- **Workflow scripts.** Orchestration is the parent agent's job, optionally through Pi's native codemode scripts calling the ordinary tools.

## Detailed contracts

- [Routing, admission, and launch](docs/routing.md)
- [Local backends, writer pools, workspaces, and transport](docs/local-backends.md)
- [Completion, cancellation, tool presentation, and Activity](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Native Pi codemode scripting](docs/native-codemode.md)
