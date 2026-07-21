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
- `src/application/controller.ts` canonically owns application orchestration and the transactional checkpoint/delivery flow. Its Context key intentionally retains the historical identity.
- `src/advisor-controller.ts` is an internal compatibility re-export for existing direct-source tests and callers.
- `src/layer.ts` is the sole outer composition root for controller, child runtime, queue, persistence, logging, notification, command, and platform Layers.
- `src/advisor-runtime.ts`, `src/review-queue.ts`, and `src/checkpoint-orchestrator.ts` own child, queue, and checkpoint resources.
- `src/domain/candidate.ts` contains candidate/message classification; `src/domain/metrics.ts` contains plain metrics contracts.
- Other pure review/routing/dedupe/budget/trajectory modules remain package-local domain logic.
- `src/boundary/` isolates Pi, clock, JSON, filesystem, executor, and host-context APIs.
- `src/advisor-projection.ts`, `src/status-service.ts`, `src/renderer.ts`, and command rendering in `src/settings.ts` form the synchronous UI boundary.

## State and resources

`AdvisorApplicationState` is immutable domain authority. Queue, fibers, scopes, runtimes, abort listeners, and status resources stay outside it. Only a deeply frozen controller projection reaches synchronous commands/renderers.

## Lifecycle

```text
Pi callback -> extension -> session runtime -> AdvisorController
observation -> synchronous admission -> queue/checkpoint -> verified delivery transaction
                                           -> application state -> frozen projection
session replacement/shutdown -> checkpoint/queue/child/runtime finalizers
```
