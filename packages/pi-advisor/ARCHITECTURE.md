# Advisor architecture

## Purpose and behavior

`pi-advisor` runs a bounded read-only second-model review. Off means no automatic work; on means Advisor may intervene on evidence-backed material issues. Explicit one-off review remains available while off. Ordinary progress turns only ingest observations and never synchronously checkpoint or wait. Final review may use a hard 10-second barrier. Conservative trajectory timers may request asynchronous perspectives, and verified safe stalls may use abort/recovery.

Visible results are strict version-1 custom entries, not messages. Review cards and action tombstones are durable in the parent session and excluded from LLM context. Corrections use a separate compact `display:false` custom message; the full card is never copied into parent context.

## Host surface

- Command: exactly `/advisor`, with `on`, `off`, `review`, `fix`, `dismiss`, `cancel`, `setup`, and `usage`.
- Events: session lifecycle/tree/compact, message/turn observations, tools, and agent settlement.
- Custom entries: `pi-advisor-review-card-v1`, `pi-advisor-review-action-v1`, and the internal compact checkpoint ledger.
- Renderer: entry renderer registered by the Pi boundary adapter; pure card rendering lives under `ui/`.

## Configuration

`config/schema.ts` decodes only `{ enabled?, provider?, model?, setupDismissed? }`. Advisor defaults to disabled and does not admit onboarding while disabled; setup dismissal defaults to false for an explicitly enabled but unconfigured Advisor. Removed Advisor fields are scrubbed on settings writes; unrelated unknown root fields are preserved but never applied. Fixed runtime values are medium reasoning, fast mode off, 90-second operations, and 120,000 recent-context characters. Model selection persists provider/model/enabled/setup dismissal atomically; `off` changes only the enabled field. Commands and automatic onboarding share one persistence and `afterCommit` publication path. Every committed config advances `cancellationEpoch`, so stale checkpoint and recovery work needs no separate config revision.

## Source map

- `src/extension.ts` — thin public entrypoint. It exports the extension factory, dependency types, catch-up helper, and durable public types, not internal services or Layers.
- `src/layer.ts` — outer Effect composition root; application services stay private while the executor's `AdvisorPlatform` remains in the session runtime.
- `src/application/register.ts` — sole Pi command/event/entry-renderer registration boundary and sole live application Effect-to-Promise crossing. Argument completion is pure and direct.
- `src/application/controller.ts` — narrow controller service plus final-wait and durable lifecycle contracts. The service exposes only session initialization/shutdown, compact/tree, event dispatch, and command handling.
- `src/application/lifecycle/`:
  - `layer.ts` — application composition, private resource operations, and Effect command handling. Each command captures one fixed settings snapshot at Effect start.
  - `events.ts` and `events/*` — internal Effect event dispatcher, observation-only progress turns, bounded direct final review waits, conservative perspective/stall/recovery admission, and startup/shutdown/tree. Observation mutations run before each handler's first asynchronous yield. Onboarding runs non-blocking in the application scope.
  - `delivery.ts` — evidence gates, blocker verification routing, intervention budget, complete-final finding reconciliation, and the local card/correction transaction.
  - `commands.ts` — cancellation, one-off review, Fix/Dismiss, and committed config convergence.
  - `runtime.ts`, `checkpoint.ts`, `ledger.ts`, `status.ts`, `parent-session.ts`, `metrics.ts`, `application-state.ts`, `session-refs.ts` — hidden trust/resource machinery.
- `src/boundary/host-review-cards.ts` — Pi `appendEntry`, `registerEntryRenderer`, hidden guidance, tombstones, and active-branch restoration.
- `src/boundary/host-onboarding.ts` — authenticated-model discovery and first-run setup UI.
- Other `src/boundary/host-*` modules — guarded Pi command Promise, context, onboarding, and status adapters. Internal event dispatch is Effect-native; notifications use the shared synchronous host boundary directly.
- `src/boundary/read-only-fs.ts` and `executor.ts` — capability-narrow raw Node reads for `O_NOFOLLOW` and bigint inode checks with Effect `Path.Path` normalization, composed without process authority. TOCTOU test hooks enter through an isolated Layer override rather than mutable module state; `node.ts` retains only pure synchronous configuration/log path arithmetic.
- `src/ui/review-card.ts` — pure strict card/action decode, sanitization, compact card data, and renderer.
- `src/settings/controller.ts` — pure `/advisor` argument completion and the Effect command handler. Settings receive one command snapshot and never reread application state after a modal yields.
- `src/settings/panels.ts` — Effect sequencing for the contextual dashboard, setup, committed configuration changes, internal state summary, and usage report.
- `src/settings/notify.ts` — shared Fix/Dismiss card-action notifications.
- `src/settings/format.ts` — pure dashboard and usage formatting helpers.
- `src/config/schema.ts`, `options.ts`, `store.ts` — strict shape/defaults, path/options, and sole persistence door.
- `src/review/` — concern/blocker schema, prompts, evidence gates, routing, dedupe, lifecycle, budgets, trajectory detection, and bounded observations. `review/schema.ts` owns the review codecs, verdict lanes, canonical fingerprint rules, aggregate review bound, and the broader lifecycle finding shape. The checkpoint wire contract has one shape: `suggestions` is required, and missing or extra keys fail open through the typed response-format path. `review/context.ts` snapshots each untrusted message record before inspection, then redacts the candidate and dynamic headings before correlation and composition.
- `src/checkpoint/` — compact ledger and checkpoint orchestrator.
- `src/runtime/` — persistent child Advisor conversation, no-discovery resource loader, and read-only tools. `runtime/checkpoint-parse.ts` is the sole strict checkpoint JSON decode boundary; it maps Schema failures to fixed redacted model errors before tracing. `makeAdvisorRuntimeOperations` builds the plain Context-service contract and owns mailbox, child-state, and lifecycle primitives; the internal session state machine remains private to this room. All model/tool/session construction runs through the single `AdvisorChildFactory` Effect Context service (`child-factory.ts`); `advisorChildFactoryLayer` is the production composition and its `createSession` is the only Promise-shaped Pi host boundary. All exported runtime, instruction, tool, and model APIs are Effect-shaped; there are no Promise wrapper exports.
- `src/queue/` — bounded observation/checkpoint queue. `makeAdvisorReviewQueue` is the scoped construction door. Lifecycle constructs it directly under the captured application scope; there is no queue service or work `Queue`. One `FiberHandle` owns the checkpoint worker, while the bounded coalesced steering ingress remains a separate scoped resource.
- `src/status/` — Effect-owned spinner resource; a scoped `FiberHandle` captures the session runtime, replaces the active animation itself, and makes shutdown wait for interruption without a separate executor or fiber registry.
- `src/logging/` and `src/domain/` — redacted diagnostics and plain domain contracts. `domain/safe-data.ts` owns bounded descriptor snapshots and contains getters and proxies without interpreting protocol shape. Snapshotting produces safe mutable JSON; each observation or checkpoint owner still applies its final wire Schema.
- `tests/support/` — direct-import test fixtures (no barrel): Deferred-backed Promise deferred/tick (`async.ts`), resolved config, final-turn/pass checkpoints, the standalone test executor (`executor.ts`), raw Node builtins for harnesses that exercise or guard native platform APIs (`node-builtins.ts`), the controllable Effect-shaped `AdvisorRuntimeService` layer (`runtime-service.ts`), the Effect-shaped `AdvisorChildFactory` test layer (`child-factory.ts`), composable extension host doubles, and Effect-typed ConfigStore/FailureLogger test layers (`layers.ts`; production code carries no Promise-shaped test seams — `AdvisorExtensionDependencies` accepts Layer overrides only: `configStore`, `failureLogger`, and `runtimeService`). Semantically local seams (Effect deferreds, hostile accessors, spy harnesses) stay in their test files.

## State and resource boundaries

`AdvisorApplicationState` is immutable domain authority for configuration, visible session metrics, trajectory and recovery policy, counters, and reducer state. Pure session initialization, genuine-user-request admission, cancellation, and committed-config reducers each replace that authority once. Session initialization preserves generations advanced before its first yield. Request admission advances request and cancellation generations once while preserving finding lifecycle; cancellation preserves recovery rollback semantics; config commits preserve session, turn, and request IDs while invalidating work through `cancellationEpoch`. Queue, scopes, fibers, child sessions, timers, abort listeners, host contexts, instruction paths, and the last-candidate capability remain outside it. There is no controller projection. At command start, lifecycle reads application state once, combines it with queue activity, the checkpoint orchestrator's active count, and `lastCandidate`, then passes that fixed readonly snapshot through every settings modal. A cursor-restart checkpoint therefore remains visible and cancellable while no queue is installed. Session metrics retain only values shown by the dashboard or usage report: cards, corrections, cost, last action and duration, model responses, settled reviews, total duration, and total tokens.

Persistent recovery uses one identity-checked pure settlement reducer. Guidance keeps semantic dedupe, emission hashes, and the reserved intervention budget; it acknowledges finding IDs, records the receipt, arms interruption routing, and clears pending recovery. Card-only delivery keeps the same delivery state but leaves findings open and records no receipt. Total non-delivery rolls back semantic dedupe and the emission hash, restores the previous budget with `correctionUsed` forced true, and leaves findings open. The agent-settlement handler persists the ledger after every accepted outcome and records an intervention observation only for guidance. Immediate parent-abort boundary failure stays in its separate synchronous fallback transaction.

Child usage and diagnostic callbacks are accepted only while their captured runtime-start epoch is current. Dynamically forked work and review queues live under an application resource scope registered before the Layer finalizer. The finalizer therefore advances epoch before that scope, refs, or child resources close, so callbacks and checkpoint failures from replaced runtimes and replaced Layers cannot publish.

The queue has one private immutable `SynchronizedRef` state: disposal, the committed observation cursor, one running or cancelling entry, at most 16 FIFO queued entries, and the current wake `Deferred`. Entries use internal symbols for ownership. Repeated provider checkpoint IDs are correlation data, never queue identity. Admission captures the observation sequence and freezes that target once after the state commit. Pure state transitions return after-commit work; barriers and isolated callbacks run before worker wake or restart, and request `Deferred` completion runs last. Cancellation and disposal join runtime abort cleanup before settlement. Exact ID plus `processedThrough` correlation and successful or poison-drop evidence commits remain token-gated.

The synchronous queue properties `processedThrough`, `pendingCheckpoints`, and `hasActiveCheckpoint` use the pinned rc.111 `SynchronizedRef.getUnsafe` API; `backlog` reads the observation buffer authority. These are narrow host-facing reads, not a second mutable copy. Observation records remain package-private, and production paths exchange their bounded rendered strings. No external record reference requires a defensive freeze or copy.

The active branch is the authority for the latest open review card: each dashboard or Fix/Dismiss action scans backward, applying action tombstones before selecting a card. Advisor card, action, and ledger entries are excluded from parent-anchor selection. First-run setup is admitted only after session startup completes, so the modal never blocks observation forwarding. It captures the config path at admission, persists through the command commit path in the application scope, and reports a fixed redacted warning if the save fails.

## Safety invariants

- Exactly `read`, `grep`, `find`, and `ls`; no process or mutation capability.
- Findings are only `concern` or `blocker`. Evidence-free/low-confidence findings are suppressed; weak blockers downgrade to concern.
- Every useful accepted finding is surfaced locally, including idle-parent results.
- One ordinary visible automatic intervention per request plus one verified blocker escalation; progress perspectives consume the ordinary slot, while final suggestions are suppressed.
- Advisor may abort only after strong same-turn trajectory evidence, blocker verification, and active-tool safety checks.
- Checkpoint admission retains the request generation across a yielding cursor restart, then one captured owner generation gates provider success and rejection after every checkpoint yield. Stale settlement records one discarded review duration and has no delivery, failure-log, notification, unavailable-status, or authentication-stop effects.
- Stale results, cancellation, branch/config changes, timeouts, and provider failures fail open.
- Context candidates, message content, structured credential fields, and dynamic tool or extension headings use the same redaction policy before model composition.
- No progress checkpoint or wait exists on ordinary tool-calling turn boundaries.
