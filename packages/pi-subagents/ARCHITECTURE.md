# Architecture

`pi-subagents` is an Effect-managed Pi extension for session-scoped child-agent processes. Pi RPC and Claude Code CLI children share one backend-neutral run model while retaining backend-specific protocols and capabilities.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint and child-recursion guard.
- `src/layer.ts` — session Layer composition.
- `src/application/` — tool, command, notification, and session lifecycle wiring.
- `src/boundary/child-process.ts` — child backend dispatch plus the Pi RPC process, session-fork, and process-tree adapter.
- `src/boundary/claude-process.ts` — installed `claude -p` process ownership, CLI-managed authentication, explicit native-tool policy, and NDJSON transport.
- `src/boundary/claude-protocol.ts` — bounded Claude stream-json decoding and backend-neutral event translation.
- `src/boundary/host-child.ts` — child-only `contact_parent` Pi extension and IPC bridge.
- `src/boundary/native-clock.ts` — synchronous native clock isolated for Pi render callbacks.
- `src/boundary/host-environment.ts` — process-role detection.
- `src/boundary/host-notifier.ts` — exception-safe immediate parent transcript delivery.
- `src/boundary/host-ui.ts` — synchronous immutable fleet projection bridge.
- `src/run/` — backend/capability and run models, normalized child events, Pi protocol decoding, errors, bounded text and structured child-session timelines, projection, and scoped fleet owner.
- `src/tools/subagent.ts` — the single agent-facing management tool, with cooperative `pi-code-previews` shell rendering.
- `src/tools/renderers/session-output.ts` — shared width-aware child-session presentation for tool results and fleet details, with grouped activity, Markdown final reports, and optional technical metadata.
- `src/settings/controller.ts` — `/subagents` command registration.
- `src/ui/` — pure responsive fleet presentation, scroll projection, and terminal-text sanitization.

## Ownership

`SubagentService` is the only run-registry owner. Every child process is acquired in a child Scope forked from the session runtime. Closing the session runtime aborts and terminates every process, settles pending requests, and clears the host projection. A successful `session_tree` event replaces that runtime, so children rooted in the abandoned branch are stopped silently and the selected branch starts with an empty fleet.

Child Pi processes run in RPC mode. Standard Pi RPC uses stdin/stdout; a separate Node IPC channel carries `contact_parent` requests and peer-awareness notices. Claude children run the installed `claude -p` command with streaming JSON input/output, the CLI's normal authentication resolution, safe mode, and backend-owned read-only or writer tool allowlists. The Phase 1 flag contract is verified against Claude Code 2.1.220; `--tools` restricts the available native tools, while role-specific `--disallowedTools` entries provide a second deny layer. Claude raw messages are decoded and translated before entering shared run state. Structured Claude rate-limit events distinguish allowed requests with unavailable overage from rejected requests: warnings remain non-interrupting, while rejection starts a short grace period for the authoritative result envelope before the service fails and terminates an otherwise-hung turn. Backend capabilities prevent unsupported operations from being approximated: Phase 1 Claude runs support fresh start, completion, stop, local rename, and continuation after completion, but not steering, interruption, forked Pi context, peer notices, or parent contact. The process boundary tags transports, and each is decoded against only its permitted bounded protocol schema. Pi blocking parent questions execute sequentially, and the parent claims each question before sending its single reply. Fresh Pi children use a dedicated session directory with filesystem-safe session/run segments. Forked Pi children receive a private copy of the stable parent branch, never the live parent file; non-portable provider thinking blocks are removed from that copy. Runtime-only Pi API keys cross the process boundary through an ephemeral environment bootstrap rather than process arguments. Child finalization bounds transport writes and uses backend-specific graceful shutdown before verified process-tree termination. Claude initialization has a separate 60-second readiness deadline, while steady-state RPC remains bounded to 10 seconds. Process exit is observed only after stdio closes, buffered RPC events drain before exit settlement, exited handles cannot signal stale PIDs, and failed writers retain ownership until external scope cleanup completes. Stop cleanup continues independently when its requesting tool is cancelled. Terminal state transitions are atomic and monotonic, while foreground questions, pauses, and settlements release the owning tool waiter exactly once. Interrupt settlement is correlated independently from the RPC response so delayed abort responses cannot turn a pause into completion, and post-pause parent contacts are ignored. Child-controlled stdout, stderr, transcripts, identifiers, and management messages are bounded; stderr included in direct boundary errors is sanitized and redacted. Successful and failed Claude result envelopes both contribute their reported usage before terminal settlement. Unknown protocol values are decoded with Effect Schema before entering run state.

The UI and host notifications consume immutable projections. They never own child sessions or processes.

## Write coordination

Every launch declares `writeIntent: "writer" | "read-only"`. The service permits only one active writer in the shared cwd. Pi children receive the parent active tools except recursive orchestration tools. Claude children instead receive a backend-owned native-tool allowlist: read-only runs omit and explicitly deny mutation and shell tools, while writer runs add Edit, Write, and Bash. Read-only Claude runs still permit WebFetch and WebSearch, so read-only describes local workspace mutation rather than network isolation. Pi peer notices make shared-workspace concurrency explicit. True parallel writers are deferred until isolated worktrees are implemented.
