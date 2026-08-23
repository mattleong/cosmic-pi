# Architecture

`pi-subagents` is an Effect-managed extension for session-scoped, profile-routed background subagents across local and Herdr hosts. Pi owns the process; one managed runtime, backend registry, run registry, and configuration store are composed for each started parent session and disposed on replacement or shutdown.

## Detailed documentation

- [Routing, candidate planning, and launch](docs/routing.md)
- [Local Pi, Claude, Codex, writer leases, and supervisor transport](docs/local-backends.md)
- [Herdr topology and ownership](docs/herdr-ownership.md)
- [Completion, projection, and delivery](docs/completion-delivery.md)
- [Settings workspace](docs/settings-workspace.md)

## Source map

- `src/extension.ts` — thin Pi registration entrypoint and child-recursion guard.
- `src/layer.ts` — session Layer composition for `SubagentService`, `SubagentProfileService`, the single `SubagentConfigStore` persistence door, backend boundaries, native model catalog, and writer leases.
- `src/application/` — `register.ts` host/tool/lifecycle wiring plus generation-checked `profile-override-handoff.ts` and reload-only `profile-reload-handoff.ts`.
- `src/domain/routing.ts` — import-free routing vocabulary and runtime effort policy shared without profile/run cycles.
- `src/config/` — `schema.ts` strict v4 shape, `options.ts` resolution/provenance, and the sole persistence door `store.ts`.
- `src/profiles/` — `definitions.ts`, `model.ts`, `resolve.ts`, `service.ts`, and `session-overrides.ts` own fixed profiles, ordered routes, and revisioned session overlays.
- `src/backend/` — `model.ts` and `service.ts` define the driver contract/registry; `local.ts` composes all six adapters; `local-pi.ts`, `local-claude*.ts`, `local-codex*.ts`, and `local-cli-events.ts` own runtime behavior; `local-pi-protocol.ts` is the single pure schema door for Pi's native RPC plus both directions of the private parent-contact protocol; `herdr*.ts` own shared Herdr behavior; `claude-policy.ts` and `local-supervisor-prompt.ts` are pure foreign-runtime policy.
- `src/boundary/child-process.ts` and `process-tree.ts` — local Pi spawn/release, native Pi stdin/stdout RPC ownership, and Effect-native process-tree cleanup with a Clock-owned Windows helper deadline plus one Promise compatibility door for synchronous Node callbacks. `child-process.ts` receives only schema-decoded parent-contact events from the IPC boundary.
- `src/boundary/local-pi-ipc.ts` and `host-child.ts` — the sole raw Node IPC adapter for both parent and child, including bounded callback settlement, definite-versus-uncertain delivery failures, schema validation before typed ingress, idempotent listener detachment, child disconnect handling, and the Promise-shaped Pi child bootstrap/contact tool.
- `src/boundary/local-cli-process.ts` — Local CLI Context.Service/preflight door over `local-cli-harness.ts` private state/auth, Effect-child-process bounded readiness probes, `local-cli-transport.ts` bounded JSONL/process ownership, and `claude-writer-cwd.ts` platform path validation.
- `src/boundary/native-model-catalog.ts` — cancelable, no-inference Claude/Codex model discovery backed by scoped Effect child processes and Effect `Cache`: structurally keyed concurrent callers share one lookup, successful catalogs remain cached, failures expire immediately, and interruption aborts the lookup only after its final waiter exits.
- `src/boundary/writer-lease.ts` — canonical cwd identity plus the token-bound reserved/spawn-started lease, dead-reservation takeover, and tombstone release protocol; validation, stable reads, and synchronization waits remain interruptible while only exclusive-create/evidence, phase-transition, takeover, and release commits are masked.
- `src/boundary/herdr-environment.ts`, `herdr-cli.ts`, `herdr-harness.ts`, `herdr-codex-hooks.ts`, `herdr-codex-session-hook.mjs`, `herdr-launch-safety.ts`, and `herdr-host.ts` — inherited environment, fixed protocol, private harness and interactive-Claude transcript suppression, Codex hook discovery/trust plus no-inference SessionStart bootstrap, mutation safety, and exact topology ownership.
- `src/boundary/supervisor-channel.ts`, `supervisor-rpc-protocol.ts`, `supervisor-mcp-helper.mjs`, `supervisor-mcp-helper.ts`, `host-pi-supervisor-extension.ts`, and `pi-supervisor-bridge-client.ts` — the private supervisor transport and delegated-Pi bridge. The parent channel runs the v2 typed group through Effect RPC over scoped Effect Socket/NodeSocketServer services, with staged acquisition, a bounded masked config-publication commit followed by an interruption checkpoint, Deferred-shared exact-once cleanup, per-connection authentication deadlines, schema-bounded NDJSON framing, and explicit assignment/question acknowledgements. The erasable-TypeScript helper is a thin MCP JSON-RPC stdio adapter and Effect RPC client whose active tool calls are owned by a scoped `FiberMap`; a minimal `.mjs` launcher loads it through the package-owned Jiti dependency because Node refuses native type stripping below `node_modules`. The delegated Pi extension uses a session-runtime slot whose Layer owns its scoped MCP bridge over `rpc-session.ts`; that shared foreign-protocol boundary retains per-call timeout isolation, interrupt-driven MCP cancellation, and confirmed helper cleanup. The schema-branded channel token stays `Redacted` in the parent and is unwrapped only for constant-time request authentication and the private config document.
- `src/boundary/rpc-session.ts` — shared scoped NDJSON request/response sessions over spawned helpers: acquisition-scoped process ownership, a bounded frame queue with a writer fiber, a synchronous pending-call map plus `Deferred` replies and notification acknowledgements, per-call timeouts that isolate only their own call, transport-death fail-all, byte-bounded line parsing with an optional short-probe lifetime cap, and shared confirm-before-settle process-tree teardown.
- `src/boundary/host-child.ts` — child bootstrap plus the parent-contact tool; blocking questions wait on a `Deferred` under a hard timeout, and cancellation or timeout emits a `contact_cancel` envelope so the supervisor view releases its waiting question.
- `src/boundary/host-profile-resolution.ts`, `host-notifier.ts`, `host-ui.ts`, and `host-environment.ts` — Pi profile/auth capture, bounded delivery, repaint scheduling, and child-environment checks. Transferable runtime API keys remain `Redacted` until the child-process or Herdr private-environment transport materializes them.
- `src/boundary/bounded-line-parser.ts` and `harness-shared.ts` — shared Node-adjacent bounded parser and private-filesystem/auth primitives; `native-clock.ts` is the named wall-clock boundary.
- `src/boundary/node-builtins.ts` — the one `process.getBuiltinModule` door for raw Node `child_process`/`fs`/`path` access whose contracts the Effect FileSystem, Path, and ChildProcess services cannot express (detached process-group spawns, exclusive/no-follow private files, native path semantics).
- `src/run/` — `service.ts` and `internal.ts` wire the registry; `admission.ts`, `launch.ts`, `process-lifecycle.ts`, `record-cleanup.ts`, and `retry.ts` own admission/spawn/cleanup plus signal-driven initialization and lease settlement and exclusive failed-run continuation claims; `assignment.ts`, `events.ts`, `report-lifecycle.ts`, `settlement.ts`, `control.ts`, and `resume.ts` own live transitions; `completion.ts`, `completion-observations.ts`, and `notification-delivery.ts` own delivery through two persistent latch-driven outbox workers; `coordination.ts` and `tool-policy.ts` separate record-aware coordination from child policy; `model.ts`, `errors.ts`, `limits.ts`, `state.ts`, `projection.ts`, `session-events.ts`, `warnings.ts`, `fast-mode.ts`, `model-catalog.ts`, `native-model-selector.ts`, and `launch-validation.ts` own bounded domain policy/projection.
- `src/supervisor/protocol.ts` — the shared Effect RPC v2 group and schema-bounded payload/result/error contracts, including schema-branded run, channel, delivery, and auth-token identities plus normalized supervisor events. It remains erasable TypeScript because the standalone helper imports it directly under the package's Node 22.22+ engine.
- `src/tools/` — `schema.ts`, `subagent.ts`, and `execute.ts` own focused tool contracts/execution; `details*.ts`, `format.ts`, `output.ts`, and `render*.ts` own bounded persisted details and cooperative rendering.
- `src/settings/controller.ts` and `profile-route-editor.ts` — command/persistence orchestration and pure route draft operations; `src/settings/ui/` owns the pure responsive profile workspace and selectors.
- `src/ui/fleet.ts`, `metrics.ts`, `run-state.ts`, `sanitize.ts`, and `session-output.ts` — pure fleet/session projection and presentation.
- `tests/run/` and `tests/tools/` mirror the largest orchestration/tool surfaces with shared fixtures; the remaining focused `tests/**/*.test.ts` suites cover backend, boundary, config, profile, settings, and UI contracts. `tests/support/` holds the shared Effect-generator test registration helpers and the test-side Node builtin door.

## Core invariants

### Routing and fallback

Version 4 accepts only exact profile/candidate fields. Ordered candidates may fall through only during bounded readiness before service/resource ownership; once `SubagentService.start` begins, no later candidate is attempted implicitly. After a failed run has confirmed cleanup, explicit `subagent_lifecycle` retry claims it exactly once and creates a linked successor starting strictly after its selected candidate in the frozen launch-time route; uncertain execution or cleanup fails closed, and only route exhaustion permits a generalist replacement. A public start batch captures one immutable profile snapshot. See [Routing](docs/routing.md).

### Backend and writer ownership

Every backend process, transport, harness, child scope, and writer lease belongs to the session runtime. Runtime startup returns its initial fleet projection and private supervisor bridge as activation values, so only the current session publishes either host capability. Writers acquire and durably mark one token-bound stable-directory lease before every spawn; cleanup is ordered spawn settlement → backend scope closure → confirmed lease release, and uncertainty quarantines ownership. See [Local backends](docs/local-backends.md).

### Herdr topology

Herdr uses only the parent-inherited session and requires one exact inherited calling pane. Launches split that pane, then the newest live owned subagent pane in the same current workspace/tab; active-tab changes do not invalidate committed runs. Workspace/tab/pane/terminal/agent/native-session selectors are exact evidence; every mutation revalidates them, mismatches are sticky, focus restoration never steals newer user focus, only exact subagent panes are closed, and uncertain topology is retained rather than adopted or retried. See [Herdr ownership](docs/herdr-ownership.md).

### Completion and delivery

Reports are bounded in-memory assignment generations. Epoch/sequence/delivery identity are committed atomically; await claims are exclusive and cancellation-safe; monotonic `SubscriptionRef` revisions close the check-to-subscribe race without manual waiter registries; unclaimed outcomes are delivered exactly once through the bounded retrying outbox; renderers consume immutable snapshots only. See [Completion and delivery](docs/completion-delivery.md).

### Settings and persistence

Session overrides are immediate in-memory copy-on-write routes; trusted project and global edits use the single config store, optimistic concurrency, and reload-required publication. Invalid declarations fail closed and model/runtime changes cannot persist unsupported combinations. See [Settings workspace](docs/settings-workspace.md).
