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
- `src/backend/` — `model.ts` and `service.ts` define the driver contract/registry; `local.ts` composes all six adapters; `local-pi*.ts`, `local-claude*.ts`, `local-codex*.ts`, and `local-cli-events.ts` own runtime protocols; `herdr*.ts` own shared Herdr behavior; `claude-policy.ts` and `local-supervisor-prompt.ts` are pure foreign-runtime policy.
- `src/boundary/child-process.ts`, `process-tree.ts`, and `host-child.ts` — local Pi spawn/release, process-tree cleanup, and child bootstrap.
- `src/boundary/local-cli-process.ts` — Local CLI Context.Service/preflight door over `local-cli-harness.ts` private state/auth, `local-cli-transport.ts` bounded JSONL/process ownership, and `claude-writer-cwd.ts` platform path validation.
- `src/boundary/native-model-catalog.ts` — cancelable, no-inference Claude/Codex model discovery backed by Effect `Cache`: structurally keyed concurrent callers share one lookup, successful catalogs remain cached, failures expire immediately, and interruption aborts the lookup only after its final waiter exits.
- `src/boundary/writer-lease.ts` — canonical cwd identity plus the token-bound reserved/spawn-started lease, dead-reservation takeover, and tombstone release protocol; validation, stable reads, and synchronization waits remain interruptible while only exclusive-create/evidence, phase-transition, takeover, and release commits are masked.
- `src/boundary/herdr-environment.ts`, `herdr-cli.ts`, `herdr-harness.ts`, `herdr-codex-hooks.ts`, `herdr-codex-session-hook.mjs`, `herdr-launch-safety.ts`, and `herdr-host.ts` — inherited environment, fixed protocol, private harness and interactive-Claude transcript suppression, Codex hook discovery/trust plus no-inference SessionStart bootstrap, mutation safety, and exact topology ownership.
- `src/boundary/supervisor-channel.ts`, `supervisor-mcp-helper.mjs`, `host-pi-supervisor-extension.ts`, and `pi-supervisor-bridge-client.ts` — authenticated private supervisor transport and delegated-Pi bridge; open uses scoped acquire/release plus interruption-safe cleanup of a foreign Promise that succeeds late, and the schema-branded channel token stays `Redacted` in the parent and is unwrapped only for constant-time comparison, private config, and authenticated wire output.
- `src/boundary/host-profile-resolution.ts`, `host-notifier.ts`, `host-ui.ts`, and `host-environment.ts` — Pi profile/auth capture, bounded delivery, repaint scheduling, and child-environment checks. Transferable runtime API keys remain `Redacted` until the child-process or Herdr private-environment transport materializes them.
- `src/boundary/bounded-line-parser.ts` and `harness-shared.ts` — shared Node-adjacent bounded parser and private-filesystem/auth primitives; `native-clock.ts` is the named wall-clock boundary.
- `src/run/` — `service.ts` and `internal.ts` wire the registry; `admission.ts`, `launch.ts`, `process-lifecycle.ts`, `record-cleanup.ts`, and `retry.ts` own admission/spawn/cleanup plus exclusive failed-run continuation claims; `assignment.ts`, `events.ts`, `report-lifecycle.ts`, `settlement.ts`, `control.ts`, and `resume.ts` own live transitions; `completion.ts`, `completion-observations.ts`, and `notification-delivery.ts` own delivery; `coordination.ts` and `tool-policy.ts` separate record-aware coordination from child policy; `model.ts`, `errors.ts`, `limits.ts`, `state.ts`, `projection.ts`, `session-events.ts`, `warnings.ts`, `fast-mode.ts`, `model-catalog.ts`, `native-model-selector.ts`, and `launch-validation.ts` own bounded domain policy/projection.
- `src/supervisor/protocol.ts` — one strict authenticated client-message union with schema-branded run, channel, delivery, and auth-token identities, plus normalized supervisor events.
- `src/tools/` — `schema.ts`, `subagent.ts`, and `execute.ts` own focused tool contracts/execution; `details*.ts`, `format.ts`, `output.ts`, and `render*.ts` own bounded persisted details and cooperative rendering.
- `src/settings/controller.ts` and `profile-route-editor.ts` — command/persistence orchestration and pure route draft operations; `src/settings/ui/` owns the pure responsive profile workspace and selectors.
- `src/ui/fleet.ts`, `metrics.ts`, `run-state.ts`, `sanitize.ts`, and `session-output.ts` — pure fleet/session projection and presentation.
- `tests/run/` and `tests/tools/` mirror the largest orchestration/tool surfaces with shared fixtures; the remaining focused `tests/**/*.test.ts` suites cover backend, boundary, config, profile, settings, and UI contracts.

## Core invariants

### Routing and fallback

Version 4 accepts only exact profile/candidate fields. Ordered candidates may fall through only during bounded readiness before service/resource ownership; once `SubagentService.start` begins, no later candidate is attempted implicitly. After a failed run has confirmed cleanup, explicit `subagent_lifecycle` retry claims it exactly once and creates a linked successor starting strictly after its selected candidate in the frozen launch-time route; uncertain execution or cleanup fails closed, and only route exhaustion permits a generalist replacement. A public start batch captures one immutable profile snapshot. See [Routing](docs/routing.md).

### Backend and writer ownership

Every backend process, transport, harness, child scope, and writer lease belongs to the session runtime. Writers acquire and durably mark one token-bound stable-directory lease before every spawn; cleanup is ordered spawn settlement → backend scope closure → confirmed lease release, and uncertainty quarantines ownership. See [Local backends](docs/local-backends.md).

### Herdr topology

Herdr uses only the parent-inherited session and requires one exact inherited calling pane. Launches split that pane, then the newest live owned subagent pane in the same current workspace/tab; active-tab changes do not invalidate committed runs. Workspace/tab/pane/terminal/agent/native-session selectors are exact evidence; every mutation revalidates them, mismatches are sticky, focus restoration never steals newer user focus, only exact subagent panes are closed, and uncertain topology is retained rather than adopted or retried. See [Herdr ownership](docs/herdr-ownership.md).

### Completion and delivery

Reports are bounded in-memory assignment generations. Epoch/sequence/delivery identity are committed atomically; await claims are exclusive and cancellation-safe; monotonic `SubscriptionRef` revisions close the check-to-subscribe race without manual waiter registries; unclaimed outcomes are delivered exactly once through the bounded retrying outbox; renderers consume immutable snapshots only. See [Completion and delivery](docs/completion-delivery.md).

### Settings and persistence

Session overrides are immediate in-memory copy-on-write routes; trusted project and global edits use the single config store, optimistic concurrency, and reload-required publication. Invalid declarations fail closed and model/runtime changes cannot persist unsupported combinations. See [Settings workspace](docs/settings-workspace.md).
