# Architecture

`pi-subagents` owns session-scoped background agents on local Pi, Claude, and Codex on macOS and Linux.

## Ownership and boundaries

- `extension.ts`, `application/`, and `layer.ts` register the extension and compose its Effect runtime through Cosmic Core's session-runtime slot. Root sessions own application services; nested Pi processes use authenticated proxies.
- `config/store.ts` is the configuration persistence entrypoint. `profiles/` owns route planning and the revisioned Current Session working set. `domain/` holds pure routing and file-claim policy.
- `run/` owns `SubagentService`: authoritative run records, admission and writer ownership, process lifecycle, assignment transitions, completion claims, and immutable fleet projections. `writer-pool.ts` encapsulates pool membership and lifecycle transitions; the service retains the shared run lock and run records. Factories receive the capabilities they need from the service's composition root.
- `backend/` translates Pi, Claude, and Codex behavior into normalized handles, controls, and events. `boundary/` and `supervisor/` own host integration, processes, files, leases, and authenticated transport. Run orchestration does not interpret native wire protocols.
- `workspace/` owns isolated-writer artifacts and Git operations. Run-level bindings retain parent authority and cleanup evidence; root workspace operations serialize separately from ordinary run activity.
- `tools/` owns public contracts, execution, and compact presentation. `settings/` owns commands and editors; `ui/` and settings rendering consume immutable projections. Host Activity actions recheck activation, revision, and capabilities before reaching services.

## Lifecycle

One root runtime owns the descendant tree and its processes, transports, leases, and fibers. Only the current session-slot token may activate tools or publish state. `/tree` and `/reload` preserve the Current Session profile snapshot while replacing the runtime.

Launch planning captures a profile and nesting-policy revision. Candidate fallback ends when service ownership begins. Each assignment has a monotonic epoch; delayed events cannot change a later assignment. Reports and completion claims survive backend cleanup.

Natural completion leaves descendants running. Explicit stop and runtime replacement close the tree leaf-first. Cancelling a caller after ownership transfer stops its wait while the session-scoped commit retains cleanup responsibility.

## Critical invariants

- Authenticated ancestry determines subtree visibility and target authority; caller-supplied identifiers never grant parent authority.
- Writer admission, assignment changes, completion consumption, and cleanup evidence remain coordinated under their owning locks. Uncertain process or lease cleanup blocks reuse and can quarantine a writer pool.
- Shared-checkout claims coordinate writers; they do not sandbox filesystem access. Worktree reports are proposals. Only the direct parent may review, test, and integrate an exact revision against current parent work.
- Tools and UI read frozen projections. A terminal state or returned start receipt does not prove cleanup or completion. Native result contracts remain separate from bounded presentation details.
- Current Session edits affect later launches. Saved-set edits do not change the active working set, and Project writes recheck trust.

## Detailed contracts

- [Routing, admission, and launch](docs/routing.md)
- [Local backends, writer pools, workspaces, and transport](docs/local-backends.md)
- [Completion, cancellation, tool presentation, and Activity](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)
- [Native Pi codemode scripting](docs/native-codemode.md)
