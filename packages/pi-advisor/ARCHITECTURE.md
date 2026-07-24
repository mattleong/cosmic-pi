# Advisor architecture

## Purpose

Runs bounded second-model review of Pi responses, optionally delivers advice/revision guidance, and exposes settings, status, usage, and review controls.

## Host surface

- Commands: `/advisor`, `/advisor-settings`, `/advisor-status`, and `/advisor-usage`.
- Events: session lifecycle/tree/compact, message and turn events, tool execution, and agent settlement.
- Renderer: the Advisor review message renderer.

## Source map

- `src/extension.ts` is the thin public entrypoint.
- `src/application/register.ts` owns Pi command/event registration and session forwarding.
- `src/application/controller.ts` is the unconfigured `AdvisorController` stub Layer only (not a re-export hub).
- `src/application/controller-types.ts` holds controller errors, catch-up helpers, and the Context service (historical key retained).
- `src/application/controller-helpers.ts` holds pure delivery/verification/messaging helpers used by the application layer.
- `src/application/lifecycle.ts` re-exports the lifecycle Layer entry.
- `src/application/lifecycle/` owns session lifecycle split by role:
  - `layer.ts` — composition entry (session wiring, commands, controller surface)
  - `application-state.ts` — immutable state transitions and frozen controller publication
  - `status.ts` — status spinner/rendering controls
  - `session-refs.ts` — shared mutable session handles (`createSessionRefs`)
  - `runtime.ts` — child runtime start/stop/replace (`makeRuntimeControls`)
  - `events.ts` — host event registration + session init/shutdown/compact/tree
  - `delivery.ts` — review delivery transaction (`makeDeliver`)
  - `checkpoint.ts` — checkpoint request + catch-up wait (`makeCheckpointControls`)
  - `parent-session.ts` — pure parent session reads through boundary adapters
  - `metrics.ts` — pure metrics helpers
- `src/application/state.ts` owns immutable application state.
- `src/layer.ts` is the sole outer composition root for controller, child runtime, queue, persistence, logging, notification, command, and platform Layers.
- `src/runtime/` owns the child advisor session runtime:
  - `runtime.ts` — service Layer + public re-exports
  - `session-runtime.ts` — public `AdvisorRuntime` façade and child lifecycle orchestration
  - `session-events.ts` — synchronous child-event ingress normalization and Effect consumption
  - `session-safety.ts` — child lookup and tool-identity safety checks
  - `resource-loader.ts` — no-discovery resource loader
  - plus wire types, checkpoint parse, prompts, session helpers, client, tools, resource-state
- `src/queue/` owns:
  - `service.ts` — Effect queue service Layer
  - `review-queue.ts` — `AdvisorReviewQueue` class + helpers
  - pure `state.ts` transitions and `errors.ts`
- `src/settings/` owns:
  - `controller.ts` — command registration door
  - `panels.ts` — dashboard/settings/status/usage UI flows
  - `types.ts` — command/config state contracts
  - `format.ts` — pure formatting
- `src/checkpoint/` owns checkpoint ledger and orchestrator resources.
- `src/review/` contains review domain logic: `schema`/`parse`/`format` (via `review/index.ts` barrel), findings, routing, budgets, trajectory, observation protocol, context.
- `src/config/` owns `schema.ts` (shape/defaults), `options.ts` (path + load/write/normalize), `store.ts` (persistence door), and model picking.
- `src/logging/` owns `log.ts` persistence and `logger.ts` service.
- `src/ui/` is pure projection/renderer presentation only.
- `src/status/service.ts` owns the Effect status spinner resource (not under `ui/`).
- `src/settings/` owns settings/status/usage command registration (`controller.ts`) and formatting helpers (`format.ts`).
- `src/domain/` contains shared plain contracts (candidate classification, metrics, labels, safe-data snapshots, runtime-error classification).
- `src/shared/utils.ts` holds tiny shared type guards.
- `src/boundary/` isolates foreign APIs only: Pi, clock, JSON, filesystem, executor, plus host adapters (`host-context`, `host-bindings`, `host-notifier`, `host-status`, `host-commands`).

## State and resources

`AdvisorApplicationState` is immutable domain authority. Queue, fibers, scopes, runtimes, abort listeners, and status resources stay outside it. Only a deeply frozen controller projection reaches synchronous commands/renderers.

## Lifecycle

```text
Pi callback -> extension -> session runtime -> AdvisorController
observation -> synchronous admission -> queue/checkpoint -> verified delivery transaction
                                           -> application state -> frozen projection
session replacement/shutdown -> checkpoint/queue/child/runtime finalizers
```
