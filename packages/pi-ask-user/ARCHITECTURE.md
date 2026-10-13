# Architecture

`pi-ask-user` collects structured user decisions through blocking questionnaires, asynchronous
questionnaires, and authenticated child requests. A session owns pending work; submitted answers
are ordinary session content, not durable questionnaire state.

## Ownership and boundaries

- [Application](src/application.ts) owns the session-runtime slot, activation, tool registration,
  preview replay, and context filtering. [Layer composition](src/layer.ts) supplies the current
  host callbacks and the session's preview scheduler.
- [Questionnaire service](src/questionnaire/service.ts) validates and runs blocking and owned
  calls. It shares a bounded [FIFO queue](src/questionnaire/queue.ts) with the
  [async controller](src/questionnaire/async-service.ts), which owns retained results, waiter
  claims, cancellation, presenters, and automatic delivery.
- [Questionnaire model](src/questionnaire/model.ts), [reducer](src/questionnaire/reducer.ts), and
  [validation](src/questionnaire/validation.ts) define decisions and draft transitions independently
  of the UI. Cancellation never returns unfinished drafts.
- [Host adapters](src/boundary/) own RPC dialogs, TUI admission, external-editor resources,
  delivery receipts, Activity integration, and child capabilities. The
  [TUI adapter](src/boundary/host-tui.ts) uses Cosmic UI's owned dock surface; the shared surface
  owns overlay handles and close mechanics.
- [Dialog](src/ui/dialog.ts) owns local synchronous interaction state, including drafts, focus,
  editor buffers, and viewport state. Tool and message renderers consume validated projections
  without reading services or owning session resources.
- [Tools](src/tools/) adapt the service to Pi. [Structured-result projection](src/tools/contract.ts)
  derives results from domain facts separately from display text and persisted presentation details.

## Session lifecycle and history

Factory loading registers lifecycle hooks, the resume command, and service-free history/message
renderers. Session start captures the host, creates the runtime, loads trusted preview settings,
then registers tools from the current activation. TUI supports blocking and async tools; RPC
supports blocking interaction. Marked Pi children use the authenticated root relay. Other
headless modes do not receive questionnaire tools.

Replacement, shutdown, and successful tree navigation revoke admission, delivery, and child
capabilities before disposal. Old tool callbacks cannot use the replacement runtime. Pi's
turn-dynamic `ctx.signal` is not a session lifetime; individual tool calls carry their own signals.
Pending questionnaires are never restored from history, and replay never executes a tool.

Automatic delivery writes a branch receipt before sending an answer message. Context filtering
accepts current-generation answers or historical answers supported by receipts on the active
branch. An answer message cannot establish its own provenance. This preserves valid history
without admitting delayed messages from an abandoned branch.

## Critical invariants

- Blocking, child, and async requests share dialog admission. Cancellation cannot let a queued
  successor bypass an earlier presenter or its cleanup.
- Async admission, mounting, answering, and delivery are separate outcomes. Interrupting an
  await does not cancel its presenter. A returned send call is not model acknowledgement;
  answers remain recoverable and delivery IDs support deduplication.
- Child ownership is authenticated by the coordinator's capabilities, not launch markers alone.
  Owned answers return to their caller instead of automatically steering the root agent.
- Dialog settlement revokes callbacks and joins admitted editor cleanup before another dialog
  or session takes over the TUI. Hidden dialogs retain drafts while the host owns hide/resume.
- Decision strings remain lossless in native results. Display sanitization is separate, and
  prompts, answers, notes, and work descriptions never enter diagnostics or telemetry. Structured
  encoding failure preserves the action's receipt and does not replay an already-applied action.

The focused [lifecycle rationale](docs/lifecycle.md) explains queue/delivery races, editor cleanup,
and branch evidence. [Service tests](tests/async-service.test.ts), [host ownership tests](tests/tui-ownership.test.ts),
[application tests](tests/application.test.ts), and [proxy tests](tests/proxy.test.ts) protect those
invariants. Tool contracts, controls, and rendering behavior are in the [reference](docs/reference.md).
