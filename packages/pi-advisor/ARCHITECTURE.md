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
- `src/application/host-bindings.ts` explicitly bridges controller-owned handlers to the Pi adapter; no synthetic `ExtensionAPI` proxy is used.
- `src/application/controller.ts` is the public controller surface (types re-export, stub layer, application layer entry).
- `src/application/controller-types.ts` holds controller errors, catch-up helpers, and the Context service (historical key retained).
- `src/application/controller-helpers.ts` holds pure delivery/verification/messaging helpers used by the application layer.
- `src/application/orchestration.ts` owns application orchestration and the transactional checkpoint/delivery flow.
- `src/layer.ts` is the sole outer composition root for controller, child runtime, queue, persistence, logging, notification, command, and platform Layers.
- `src/runtime/` owns the child advisor session runtime (`runtime.ts` class + service), wire types, checkpoint parse, prompts, session lifecycle helpers, client, tools, and resource state.
- `src/queue/` owns `service.ts`, pure `state.ts` transitions, and `errors.ts`.
- `src/checkpoint/` owns checkpoint ledger and orchestrator resources.
- `src/review/` contains review domain logic: `schema`/`parse`/`format` (via `review/index.ts` barrel), findings, routing, budgets, trajectory, observation protocol, context.
- `src/config/` owns `resolve.ts`, `store.ts` (config persistence service), and model picking.
- `src/logging/` owns `log.ts` persistence and `logger.ts` service.
- `src/ui/` forms the synchronous UI boundary (projection, renderer, status).
- `src/settings/` owns settings/status/usage command registration (`controller.ts`) and formatting helpers (`format.ts`).
- `src/domain/` contains shared plain contracts (candidate classification, metrics, labels).
- `src/shared/utils.ts` holds tiny shared type guards.
- `src/boundary/` isolates Pi, clock, JSON, filesystem, executor, and host-context APIs.

## State and resources

`AdvisorApplicationState` is immutable domain authority. Queue, fibers, scopes, runtimes, abort listeners, and status resources stay outside it. Only a deeply frozen controller projection reaches synchronous commands/renderers.

## Lifecycle

```text
Pi callback -> extension -> session runtime -> AdvisorController
observation -> synchronous admission -> queue/checkpoint -> verified delivery transaction
                                           -> application state -> frozen projection
session replacement/shutdown -> checkpoint/queue/child/runtime finalizers
```
