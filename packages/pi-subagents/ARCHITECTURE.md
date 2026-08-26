# Architecture

`pi-subagents` is an Effect-managed extension for session-scoped, profile-routed background subagents across local and Herdr hosts. Pi owns the process. Each parent session owns one managed runtime, profile/config state, backend registry, run registry, and fleet projection; replacement or shutdown closes them together.

## Topic documentation

- [Routing, candidate planning, and launch](docs/routing.md)
- [Local Pi, Claude, Codex, writer pools and leases, and supervisor transport](docs/local-backends.md)
- [Herdr topology and ownership](docs/herdr-ownership.md)
- [Completion, projection, and delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)

## Ownership map

- `src/extension.ts`, `src/application/`, and `src/layer.ts` register Pi callbacks, capture session capabilities, compose the runtime, and preserve temporary profile routes across the allowed replacement paths.
- `src/config/` is the strict version-4 data boundary. `store.ts` is the only persistence door. `src/profiles/` owns built-ins, canonical candidate validation, route resolution, and revisioned session overlays.
- `src/run/` owns admission, immutable launch-time routing, cooperative exact-file claims, session writer pools, process/control transitions, retained assignments, completion claims and delivery, bounded history, and the synchronous fleet projection. `tool-policy.ts` owns canonical subagent tool names and derives the child orchestration denylist.
- `src/backend/` contains the six local/Herdr Pi, Claude, and Codex drivers plus their pure protocol and policy modules. A selected driver owns execution after readiness succeeds; fallback never crosses an ownership boundary.
- `src/boundary/` contains Pi, Node, process, filesystem, Herdr, native-catalog, writer-lease, RPC, and supervisor adapters. `host-child-pi.ts` shares one-shot credential scrubbing and the eligible OpenAI priority request hook between local and delegated Pi children. Supervisor tool execution returns plain response data; one outer writer commit publishes exactly one MCP response before writer shutdown proceeds.
- `src/settings/` owns command orchestration, pure route edits, the replace-only immutable Pi model/provenance catalog, and the stateful disposable profile workspace. `src/settings/ui/` contains only pure selectors, model-choice projection, and rendering.
- `src/tools/` owns Pi tool schemas, execution, persisted detail schemas, bounded text formatting, and cooperative renderers. `src/ui/` owns pure fleet and run presentation; the fleet delegates generic selection/pane/layout/detail-scroll state and framed screen composition to the shared `ListDetailShell` (`pi-cosmic-ui/manager/list-detail-shell`) while keeping prompts, notices, busy/capability/action policy, the all-layout Enter policy, no-follow detail scrolling, headings, and geometry local.
- `src/supervisor/` owns the import-free MCP argument contract and Effect RPC v2 protocol.

## Invariants

- A public start batch captures one profile snapshot. Candidate fallback is readiness-only; explicit retry advances strictly through the frozen route after confirmed cleanup. Herdr protocol readiness is one deliberate exception to literal host selection: any version other than protocol 20, or a CLI/server protocol mismatch, retries that same candidate on the local host before advancing the route. The fallback preserves runtime, model, effort, context, write intent, fast mode, and claims, forces `closeOnReport:true`, and records a prominent warning.
- Every process, pane, helper, transport, private harness, writer pool, and writer lease belongs to the session runtime. One cross-process cwd lease protects each session pool; claimless writers are exclusive, while claimed writers must be pairwise disjoint. Claims coordinate unchanged native tools and Bash rather than sandboxing them. Any unconfirmed member cleanup quarantines the whole cwd pool, preserving fail-closed writer ownership.
- Reports are in-memory assignment generations. Retained next-assignment admission stops at 63 unresolved reports, reserving generation 64 for a later terminal backend failure; no run records generation 65. Close-on-report resume paths retain the hard 64-generation bound.
- The parent channel and delegated bridge share one supervisor contract. Questions are correlated and interruptible, reports are idempotent, and the MCP helper writes one response frame per call even when cancellation races stdout backpressure.
- Settings catalog refresh is nonblocking and cancelable. A successful non-aborted refresh atomically replaces one immutable Pi-model/provenance snapshot; failure or abort retains the prior generation, and each picker captures one generation.
- Persisted tool details are strict version 2, privacy-projected, deeply frozen, and canonically bounded to 48,000 characters. Optional bounded write-claim and audit fields are additive within version 2. Older history uses bounded sanitized text fallback.
