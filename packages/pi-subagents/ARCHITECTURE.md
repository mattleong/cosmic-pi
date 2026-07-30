# Architecture

`pi-subagents` is an Effect-managed Pi extension for session-scoped Pi child-agent processes. Profile routing, child lifecycle, RPC coordination, completion delivery, and UI projection are owned by one scoped runtime per active parent session.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint and child-recursion guard.
- `src/layer.ts` — session Layer composition for `SubagentService`, `SubagentProfileService`, and the single `SubagentConfigStore` persistence door.
- `src/application/register.ts` — tool, command, notification, and session lifecycle wiring. Generation-based latest-wins preparation prevents stale asynchronous settings loads from reactivating an abandoned runtime.
- `src/boundary/child-process.ts` — Pi RPC child spawn, fresh/fork session setup, tool policy, transport, and process-tree integration.
- `src/boundary/bounded-line-parser.ts` — UTF-8-safe RPC line room with per-frame and aggregate queued-byte limits, decoder-tail flushing, and final unterminated-frame handling.
- `src/boundary/process-tree.ts` — detached process-group termination, including post-leader-exit POSIX cleanup.
- `src/boundary/host-child.ts` — child-only `contact_parent` tool and IPC bridge. It intentionally bypasses the parent TUI preview shell because the headless child has no interactive preview host.
- `src/boundary/host-profile-resolution.ts` — Pi model-registry/auth capture and concrete profile-start resolution. It rejects per-launch routing fields, evaluates only the selected profile's ordered route, enforces policy, resolves context/intent/effort, and records selection provenance.
- `src/boundary/host-notifier.ts` — exception-safe, generation-aware parent delivery for completions, questions, and warnings.
- `src/boundary/host-ui.ts`, `host-environment.ts`, and `native-clock.ts` — synchronous host projection, process-role detection, and render-clock adapters.
- `src/config/` — the single profile-policy persistence door. `schema.ts` owns bounded version-3 Effect Schema decoding, `options.ts` owns global/project merge and policy matching, and `store.ts` owns reads, inspection, and atomic profile patches for global `<agent-dir>/pi-subagents.json` and trusted project `<cwd>/<CONFIG_DIR_NAME>/pi-subagents.json`.
- `src/profiles/` — fixed profile definitions, version-3 route contracts, deterministic ordered Pi candidate planning, and the session-loaded profile service. Selectors are exactly `parent` or canonical `pi/<provider>/<model-id>`.
- `src/run/` — Pi run models, RPC protocol decoding, errors, bounded session timelines, immutable projection, completion scheduling, controls, process lifecycle, and the scoped fleet owner. `service.ts` is the sole registry and lock owner.
- `src/tools/` — strict TypeBox contracts, Effect orchestration, bounded model-facing formatting, versioned frozen card details, pure rendering, and cooperative `pi-code-previews` registration.
- `src/settings/` — `/subagents` dispatch and TUI-only profile settings with staged single-route edits and atomic persistence.
- `src/ui/` — pure responsive fleet presentation, state projection, terminal sanitization, and width-aware structured session output.

## Runtime and registry ownership

`SubagentService` is the only run-registry owner. It allocates names and opaque runtime-prefixed IDs under its lock. Every child process is acquired in a child Scope forked from the session runtime. Closing or replacing that runtime aborts all children, settles pending requests, and clears the projection. Successful `session_tree` navigation replaces the runtime so the selected branch starts with an empty fleet.

Profile discovery and launch share one contract. `subagent_models` exposes the seven fixed profiles and their ordered static candidates. `subagent_start` has no model selector; it chooses `profile ?? defaultProfile` and evaluates only that route. Friendly preparation, execution validation, and host resolution reject forged `model` and `backend` fields. Built-ins use `{ "model": "parent", "effort": "default" }`; configured routes are the only way to choose another Pi model.

Candidate `default` effort uses the profile default and then parent effort as a soft preference; concrete configured and per-launch efforts are hard. Omitted context uses the profile default. Explicit context is hard, and fork requires a persisted parent session with a stable leaf; it never silently degrades to fresh. Denied, unavailable, unauthenticated, context-incompatible, and effort-incompatible candidates are skipped in declared order before service start. A deliberately configured discouraged candidate remains eligible with a visible warning. Once a candidate enters `SubagentService.start`, routing never falls through.

## Pi process and protocol boundary

Children run Pi in RPC mode over stdin/stdout. A separate Node IPC channel carries `contact_parent` requests and peer-awareness notices. Both transports are bounded and schema-decoded before events enter shared state. Fresh children use a dedicated session directory with filesystem-safe segments. Forked children receive a private copy of the stable parent branch, never the live parent file; non-portable provider thinking blocks are removed. Runtime-only Pi API keys cross the process boundary through an ephemeral environment bootstrap rather than arguments.

Pi writers inherit active parent tools except recursive orchestration tools. Read-only children receive only the conservative inspection allowlist (`read`, `grep`, `find`, `ls`, and web content tools). Shell, mutation, orchestration, and unknown extension tools are excluded at both resolution and process launch.

Child finalization bounds transport writes and performs graceful RPC shutdown before process-tree termination. POSIX cleanup signals the detached group even after its leader exits and performs a final forced sweep. Live Windows trees use bounded `taskkill`; post-exit PID sweeping is skipped to avoid PID-reuse hazards. Completed runs close their process scope immediately while retaining the Pi session file and output for later resume. Steady-state RPC is bounded to ten seconds. Process exit is settled only after buffered events drain, and writer ownership remains reserved until cleanup completes.

## Controls and settlement

RPC registration, response ownership, and stop-time sweeping are serialized by the service lock. Terminal transitions are atomic and monotonic. Foreground questions, pauses, and settlement release the owning waiter exactly once. Accepted replies, interrupts, and resumes commit in session scope even if the requesting tool is cancelled. Ambiguous send, reply, interrupt, resume, and writer-start outcomes use operation-specific `*_outcome_uncertain` errors and are never retried or rolled back automatically.

The public await conditions are `all_finished` and `any_finished`; finished means completed, failed, or stopped. Await also returns early for `waiting_for_parent` so the parent can call `subagent_reply` and await again. Status, await, and foreground start claim completion generations through final rendering, preventing duplicate automatic delivery. Cancelled or truncated claims are released. Unclaimed completions and actionable questions/warnings use bounded, generation-aware delivery with exponential retry; routine progress remains projection-only.

## UI and projection ownership

UI and notifications consume immutable projections. Start/await cards use versioned, deeply frozen, bounded snapshots. Run history has one structured `sessionEvents` timeline plus bounded final text. Responsive renderers hide run IDs unless technical mode is enabled, preserve names and states before truncating model IDs, and render expanded final reports as Markdown. Presentation code never owns child sessions or processes.

## Configuration and write coordination

Configuration version 3 deliberately rejects legacy versions and Claude routes rather than silently selecting a fallback. Missing global routes use the parent candidate; missing project routes inherit global routes. Present-invalid routes fail closed. Patches preserve unrelated fields, revalidate trust and version inside the persistence door, and reject concurrent external edits.

Every launch resolves `writeIntent: "writer" | "read-only"`. At most one writer may be active in the shared cwd, and ownership is retained through cleanup. One start call accepts up to twelve agents but at most one foreground item. Multi-target status, guidance, and lifecycle operations normalize duplicate IDs and return per-run successes and typed failures so partial effects are never hidden. True parallel writers remain deferred until isolated worktrees exist.
