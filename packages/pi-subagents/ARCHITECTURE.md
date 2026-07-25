# Architecture

`pi-subagents` is an Effect-managed Pi extension for session-scoped child-agent processes.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint and child-recursion guard.
- `src/layer.ts` — session Layer composition.
- `src/application/` — tool, command, notification, and session lifecycle wiring.
- `src/boundary/child-process.ts` — Node child-process, strict JSONL RPC, session-fork, and process-tree adapter.
- `src/boundary/host-child.ts` — child-only `contact_parent` Pi extension and IPC bridge.
- `src/boundary/native-clock.ts` — synchronous native clock isolated for Pi render callbacks.
- `src/boundary/host-environment.ts` — process-role detection.
- `src/boundary/host-notifier.ts` — exception-safe immediate parent transcript delivery.
- `src/boundary/host-ui.ts` — synchronous immutable fleet projection bridge.
- `src/run/` — run model, protocol decoding, errors, bounded text and structured child-session timelines, projection, and scoped fleet owner.
- `src/tools/subagent.ts` — the single agent-facing management tool, with cooperative `pi-code-previews` shell rendering.
- `src/tools/renderers/session-output.ts` — shared width-aware child-session presentation for tool results and fleet details, with grouped activity, Markdown final reports, and optional technical metadata.
- `src/settings/controller.ts` — `/subagents` command registration.
- `src/ui/` — pure responsive fleet presentation, scroll projection, and terminal-text sanitization.

## Ownership

`SubagentService` is the only run-registry owner. Every child RPC process is acquired in a child Scope forked from the session runtime. Closing the session runtime aborts and terminates every process, settles pending requests, and clears the host projection.

Child Pi processes run in RPC mode. Standard Pi RPC uses stdin/stdout; a separate Node IPC channel carries `contact_parent` requests and peer-awareness notices. The process boundary tags those transports, and each is decoded against only its permitted protocol schema. Blocking parent questions execute sequentially so every request remains replyable. Fresh children use a dedicated session directory with filesystem-safe session/run segments. Forked children receive a private copy of the stable parent branch, never the live parent file; non-portable provider thinking blocks are removed from that copy. Child finalization bounds cooperative abort before escalating through process-tree termination. Process exit is observed only after stdio closes, and buffered RPC events drain before exit settlement. Terminal state transitions are atomic and monotonic, while foreground questions, pauses, and settlements release the owning tool waiter exactly once. Interrupt settlement is correlated independently from the RPC response so delayed abort responses cannot turn a pause into completion. Child-controlled stdout, stderr, transcripts, and messages are bounded. Unknown protocol values are decoded with Effect Schema before entering run state.

The UI and host notifications consume immutable projections. They never own child sessions or processes.

## Write coordination

Every launch declares `writeIntent: "writer" | "read-only"`. The service permits only one active writer in the shared cwd. This is an orchestration contract, not a reduced tool profile: all children receive the parent active tools except recursive subagent tools. Peer notices make shared-workspace concurrency explicit. True parallel writers are deferred until isolated worktrees are implemented.
