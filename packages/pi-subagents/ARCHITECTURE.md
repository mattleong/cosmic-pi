# Architecture

`pi-subagents` owns session-scoped background agents on local Pi, Claude, and Codex on macOS and Linux, and messaging among the agents of one root session.

## Ownership and boundaries

- `extension.ts`, `application/`, and `layer.ts` register the extension and compose its Effect runtime through Cosmic Core's session-runtime slot. Root sessions own application services; nested Pi processes use authenticated proxies.
- `config/store.ts` is the configuration persistence entrypoint. `profiles/` owns route planning, custom agent resolution, and the revisioned Current Session working set. `domain/` holds pure routing policy.
- `run/` owns `SubagentService`: authoritative run records under one shared lock, admission and writer pools, process lifecycle, assignment transitions, completion claims, agent messaging, and immutable fleet projections. Factories receive only the capabilities they need from the service's composition root. The root session's main agent is reached through host capabilities in `boundary/host-agent-messages.ts`.
- `backend/` translates Pi, Claude, and Codex behavior into normalized handles, controls, and events. `boundary/` and `supervisor/` own host integration, processes, files, leases, and authenticated transport. Run orchestration never interprets native wire protocols.
- `workspace/` owns isolated-writer artifacts, Git operations, and worktree hooks with their process-cleanup quarantine. Run-level bindings keep parent authority and cleanup evidence; workspace operations serialize separately from ordinary run activity.
- `delegation/` owns each delegation mode's prompt guidance, applied to the root session through `boundary/host-delegation-prompt.ts`.
- `tools/` owns public contracts, execution, and compact presentation. `settings/` owns commands and editors. `ui/` and settings rendering consume immutable projections, and Activity actions recheck activation, revision, and capabilities before reaching services.

## Lifecycle

One root runtime owns the descendant tree and its processes, transports, leases, and fibers. Only the current session-slot token may activate tools or publish state. On shutdown, publication is revoked, the operation scope retires so blocked work settles without publishing, and backends close leaf-first.

- Launch planning captures one profile, agent, and nesting-policy revision; a launched agent is frozen into the run's route continuation. Immediate-parent model, effort, and fork facts come from authenticated Pi snapshots owned by the parent's run record; registry, authentication, trust, and tool policy stay root-owned.
- Candidate fallback ends when service ownership begins. A per-launch model override replaces the route with that one candidate and never falls back. Each assignment has a monotonic epoch, so delayed events cannot change a later assignment. Reports and completion claims survive backend cleanup.
- Run records keep a bounded report. Root settlement archives each completed report, uncut up to a hard cap, to the session's private report directory and records any capture cut and the archive on the run, then releases the full text; notices, reads, and awaits link that file instead of holding it ([report archive](docs/completion-delivery.md#report-archive-and-previews)).
- Natural completion leaves descendants running. Explicit stop and runtime replacement close the tree leaf-first. Cancelling a caller after ownership transfer stops only its wait; the session-scoped commit keeps cleanup responsibility.
- `/tree` and `/reload` keep the Current Session snapshot while replacing the runtime, and session subagent spend survives as custom session entries. `/reload` and leaving the session first append pending reports and a notice naming the runs they stop, without starting a turn; `/tree` stops the runs without touching the new branch.
- Private run state lasts until eviction or runtime end, and each root session start sweeps state left by crashed sessions.

## Critical invariants

- `agent_start`, `agent_await`, `agent_lifecycle`, and `agent_worktree` take their authority from ancestry; `agent_list`, `agent_read`, and `agent_send` reach any agent in the same root tree; the caller's identity is always authenticated (never caller-supplied). An `agent_send` from any of a waiting run's ancestors, including `main`, answers its question, since a question reaches the nearest ancestor that can take it. It may resume any finished local Pi run except while a stop of that run or an ancestor is in progress; the run still reports to its own parent, and the report notice names the resumer ([agent messages](docs/completion-delivery.md#agent-messages)). Reading never claims or consumes a report.
- Writer admission, assignment changes, completion consumption, and cleanup evidence stay coordinated under their owning locks. Cleanup disposition is independent of task outcome, and closed scopes and uncertain lease commits are never replayed.
- Shared-checkout writers in one cwd share its writer pool and cross-process lease without file claims; they coordinate by task scope and are not isolated from each other. Another process holding the lease refuses the whole pool.
- Worktree reports are proposals. Only an explicit `apply` by the authenticated direct parent integrates one, publishing exactly one revision's changed paths and refusing parent drift in them. Files the checkout's `.worktreeinclude` copies into isolated trees never enter a capture, so they never reach Git objects, revisions, or publication. An interrupted publication holds its source leases until its own session's discard rolls it back or refuses; once that session ends, another root may roll it back only under fresh leases on the same directories. Rules are in [Isolated workspace lifecycle](docs/local-backends.md#isolated-workspace-lifecycle).
- Workspace operations wait for a finished writer's process cleanup and refuse a running writer or quarantined cleanup. Destructive workspace operations serialize with admission and never remove a tree a run still holds. Another session's root may adopt, discard, or sweep an orphaned workspace only once its owner lease is free and it holds the original writer lease; adoption rewrites the owner atomically under the checkout's store lock.
- Only a child's main agent may contact its parent (progress, warnings, and blocking questions), submit its report, or send agent messages; native sub-agent identity is decided at the call, never from output ordering.
- Tools and UI read frozen projections. A terminal state or start receipt does not prove cleanup or completion. Native result contracts stay separate from bounded presentation details.
- Delegation modes change only the root session's prompt guidance; they never restrict tools or reach nested children.
- Current Session edits affect later launches. Saved-set edits never change the active working set, and Project writes recheck trust.

## Non-goals

Runs belong to one live root session, which owns their processes, authority, reports, and cleanup. Features that need a second owner are out of scope:

- **Detached runner or file-based run state.** Private files are scratch state the root owns and the startup sweep reclaims, never a source of truth another process resumes.
- **Missions or schedules.** Work starts from a parent turn; nothing runs without a session to receive its report.
- **Watchdog reviewer.** Stall detection and the parent's own review supervise runs; a second reviewer would split the parent's authority.
- **Agent memory.** Profiles and [custom agents](docs/routing.md#custom-agents) route to a runtime and model; the parent writes each assignment, and runs carry no memory between sessions.
- **Lazy tool loader.** Tools register with the activation, and children receive the root's active tools at launch.
- **Pane inspectors.** The root's fleet and Activity views show every run's transcript from one projection.
- **Cross-session messaging.** It belongs to [pi-intercom](../pi-intercom/ARCHITECTURE.md); pi-subagents never reaches another root.
- **Workflow scripts.** Orchestration is the parent agent's job, optionally through native codemode scripts calling the ordinary tools.

## Detailed contracts

- [Routing, admission, and launch](docs/routing.md)
- [Local backends, writer pools, workspaces, and transport](docs/local-backends.md)
- [Completion, cancellation, tool presentation, and Activity](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Native Pi codemode scripting](docs/native-codemode.md)
- [Reference and procedures](docs/reference.md)
