# Advisor architecture

## Purpose and behavior

`pi-advisor` runs a bounded read-only second-model review. Off means no automatic work; on means Advisor may intervene on evidence-backed material issues. Explicit one-off review remains available while off. Ordinary progress turns only ingest observations and never synchronously checkpoint or wait. Final review may use a hard 10-second barrier. Conservative trajectory timers may request asynchronous perspectives, and verified safe stalls may use abort/recovery.

Visible results are strict version-1 custom entries, not messages. Review cards and action tombstones are durable in the parent session and excluded from LLM context. Corrections use a separate compact `display:false` custom message; the full card is never copied into parent context.

## Host surface

- Command: exactly `/advisor`, with `on`, `off`, `review`, `fix`, `dismiss`, `cancel`, `setup`, and `usage`.
- Events: session lifecycle/tree/compact, message/turn observations, tools, and agent settlement.
- Custom entries: `pi-advisor-review-card-v1`, `pi-advisor-review-action-v1`, and the internal compact checkpoint ledger.
- Renderer: entry renderer registered by the Pi boundary adapter; pure projection lives under `ui/`.

## Configuration

`config/schema.ts` decodes only `{ enabled?, provider?, model?, setupDismissed? }`. Advisor defaults to disabled and does not admit onboarding while disabled; setup dismissal defaults to false for an explicitly enabled but unconfigured Advisor. Removed Advisor fields are scrubbed on settings writes; unrelated unknown root fields are preserved but never applied. Fixed runtime values are medium reasoning, fast mode off, 90-second operations, and 120,000 recent-context characters. Model selection persists provider/model/enabled/setup dismissal atomically; `off` changes only the enabled field.

## Source map

- `src/extension.ts` — thin public entrypoint.
- `src/layer.ts` — outer Effect composition root.
- `src/application/register.ts` — sole Pi command/event/entry-renderer registration boundary.
- `src/application/controller-types.ts` — controller service and final wait contract.
- `src/application/lifecycle/`:
  - `layer.ts` — application composition and frozen projection wiring.
  - `events/turn.ts` — observation-only progress turns and bounded final review waits.
  - `events/trajectory.ts` — conservative perspective, stall, and recovery admission.
  - `events/session.ts` — startup/shutdown/tree and non-blocking onboarding admission.
  - `delivery.ts` — evidence gates, blocker verification routing, intervention budget, local card/correction transaction.
  - `commands.ts` — cancellation, one-off review, Fix/Dismiss, and committed config convergence.
  - `runtime.ts`, `checkpoint.ts`, `ledger.ts`, `status.ts`, `parent-session.ts`, `metrics.ts`, `application-state.ts`, `session-refs.ts` — hidden trust/resource machinery.
- `src/boundary/host-review-cards.ts` — Pi `appendEntry`, `registerEntryRenderer`, hidden guidance, tombstones, and active-branch restoration.
- `src/boundary/host-onboarding.ts` — authenticated-model discovery and first-run setup UI.
- Other `src/boundary/host-*` modules — guarded Pi command, context, notifier, status, and event adapters.
- `src/ui/review-card.ts` — pure strict card/action decode, sanitization, compact projection, and renderer.
- `src/ui/projection.ts` — frozen synchronous controller snapshot projection (the sole dashboard input).
- `src/settings/controller.ts` — exact `/advisor` parser.
- `src/settings/panels.ts` — contextual dashboard, setup, internal state summary, and usage report.
- `src/settings/notify.ts` — shared Fix/Dismiss card-action notifications.
- `src/settings/format.ts` — pure dashboard and usage formatting helpers.
- `src/config/schema.ts`, `options.ts`, `store.ts` — strict shape/defaults, path/options, and sole persistence door.
- `src/review/` — concern/blocker schema, prompts, evidence gates, routing, dedupe, lifecycle, budgets, trajectory detection, and bounded observations. The review/checkpoint wire contract is single-shape: `suggestions` is a required array (no dual key sets or downstream fallbacks); a missing array fails the typed parse error path and the advisor fails open.
- `src/checkpoint/` — compact ledger and checkpoint orchestrator.
- `src/runtime/` — persistent child Advisor conversation, strict response decoding, no-discovery resource loader, and read-only tools. All model/tool/session construction runs through the single `AdvisorChildFactory` Effect Context service (`child-factory.ts`); `advisorChildFactoryLayer` is the production composition and its `createSession` is the only Promise-shaped Pi host boundary. All exported runtime, instruction, tool, and model APIs are Effect-shaped; there are no Promise wrapper exports.
- `src/queue/` — bounded observation/checkpoint queue.
- `src/status/` — Effect-owned spinner resource; a scoped `FiberHandle` captures the session runtime, replaces the active animation itself, and makes shutdown wait for interruption without a separate executor or fiber registry.
- `src/logging/` and `src/domain/` — redacted diagnostics and plain domain contracts.
- `tests/support/` — direct-import test fixtures (no barrel): Promise deferred/tick, resolved config, final-turn/pass checkpoints, the standalone test executor (`executor.ts`), the controllable Effect-shaped `AdvisorRuntimeService` layer (`runtime-service.ts`), the Effect-shaped `AdvisorChildFactory` test layer (`child-factory.ts`), composable extension host doubles, and Effect-typed ConfigStore/FailureLogger test layers (`layers.ts`; production code carries no Promise-shaped test seams — `AdvisorExtensionDependencies` accepts Layer overrides only: `configStore`, `failureLogger`, and `runtimeService`). Semantically local seams (Effect deferreds, hostile accessors, spy harnesses) stay in their test files.

## State and resource boundaries

`AdvisorApplicationState` is immutable domain authority. Queue, scopes, fibers, child sessions, timers, abort listeners, host contexts, and open-card capabilities remain outside it. A deeply frozen projection is the only synchronous dashboard input.

The active branch is the authority for the latest open review card: each dashboard or Fix/Dismiss action scans backward, applying action tombstones before selecting a card. Advisor card, action, and ledger entries are excluded from parent-anchor selection. First-run setup is admitted only after session startup completes, so the modal never blocks observation forwarding.

## Safety invariants

- Exactly `read`, `grep`, `find`, and `ls`; no process or mutation capability.
- Findings are only `concern` or `blocker`. Evidence-free/low-confidence findings are suppressed; weak blockers downgrade to concern.
- Every useful accepted finding is surfaced locally, including idle-parent results.
- One ordinary visible automatic intervention per request plus one verified blocker escalation; progress perspectives consume the ordinary slot, while final suggestions are suppressed.
- Advisor may abort only after strong same-turn trajectory evidence, blocker verification, and active-tool safety checks.
- Stale results, cancellation, branch/config changes, timeouts, and provider failures fail open.
- No progress checkpoint or wait exists on ordinary tool-calling turn boundaries.
