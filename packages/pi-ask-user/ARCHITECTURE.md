# Architecture

`pi-ask-user` collects structured user decisions through blocking and asynchronous
questionnaires, and shows in a subagent's own session the questionnaires its root sends there. A
session owns pending work; submitted answers are ordinary session content, not durable
questionnaire state.

## Ownership and boundaries

- [Application](src/application.ts) owns the session-runtime slot, activation, tool registration,
  preview replay, and context filtering. [Layer composition](src/layer.ts) supplies the current
  host callbacks and the session's preview scheduler.
- [Questionnaire service](src/questionnaire/service.ts) validates and runs blocking calls. It
  shares a bounded [FIFO queue](src/questionnaire/queue.ts) with the
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
- [Tools](src/tools/) adapt the service to Pi. Both questionnaire tools advertise a flat question
  schema for provider compatibility. [Argument preparation](src/tools/arguments.ts) normalizes
  and enforces the shape each question's `mode` selects. [Structured-result projection](src/tools/contract.ts)
  derives results from domain facts separately from display text and persisted presentation details.

## Session lifecycle and history

Factory loading registers lifecycle hooks, the resume command, and service-free history/message
renderers. Service and capability modules load eagerly; session start captures historical
receipts in every mode, then admits UI sessions before constructing the session service Layer.
Trusted preview settings settle before tools register from the current activation; interrupted
startup cannot activate a retired session. TUI supports blocking and async tools; RPC supports
blocking interaction. Other headless modes create no questionnaire runtime and receive no
questionnaire tools, but retain receipt-based context filtering and historical rendering.

A subagent's session, which pi-subagents marks in its environment, gets no questionnaire tools:
whether a question is the user's to answer is the main agent's decision. Such a session with a
screen of its own, as a Rex-hosted one has, publishes the
[owned-call capability](src/boundary/host-owned-calls.ts), through which its root shows a
questionnaire there; one without a screen creates no runtime.

The local TUI/external-editor adapter loads only when an admitted local questionnaire needs it,
not during runtime startup or RPC dialogs. Dialog acquisition and prompt admission
remain inside the questionnaire scope, including the post-import admission check.

Replacement, shutdown, and successful tree navigation revoke admission, delivery, and child
capabilities before disposal. Old tool callbacks cannot use the replacement runtime. Pi's
turn-dynamic `ctx.signal` is not a session lifetime; individual tool calls carry their own signals.
Pending questionnaires are never restored from history, and replay never executes a tool.

Automatic delivery writes a branch receipt before sending an answer message. Context filtering
accepts current-generation answers or historical answers supported by receipts on the active
branch. An answer message cannot establish its own provenance. This preserves valid history
without admitting delayed messages from an abandoned branch.
Admitted answer messages reach the model inside core's [message-origin
marker](../../docs/architecture/pi-boundaries.md#model-visible-extension-messages): submitted
answers are labeled as the user's words relayed by the extension, never as automated text, while
a cancelled or failed result is labeled automated.

## Critical invariants

- All asks from one session share its FIFO. A blocking ask holds the same ticket from pane
  presentation through any fallback to the caller; interruption waits for pane withdrawal.
  Independent calls into a child's local surface still share the child's own FIFO.
- Async admission, mounting, answering, and delivery are separate outcomes. Interrupting an
  await does not cancel its presenter. A returned send call is not model acknowledgement;
  answers remain recoverable and delivery IDs support deduplication.
- An owned call is bound to its exact owner and the capability's generation. Its answer returns
  to the caller that asked, never into the session that showed it.
- A blocking questionnaire asked for another agent (`askedBy`) is still the caller's: the
  [asker boundary](src/boundary/host-askers.ts) asks whoever runs that agent for its name and for
  a screen it is on, shows the questions there, and opens them in the caller's session whenever
  that screen can't answer.
- Dialog settlement revokes callbacks and joins admitted editor cleanup before another dialog
  or session takes over the TUI. Hidden dialogs retain drafts while the host owns hide/resume.
- Decision strings remain lossless in native results. Display sanitization is separate, and
  prompts, answers, notes, and work descriptions never enter diagnostics or telemetry. Structured
  encoding failure preserves the action's receipt and does not replay an already-applied action.

The focused [lifecycle rationale](docs/lifecycle.md) explains queue/delivery races, editor cleanup,
and branch evidence. [Service tests](tests/async-service.test.ts), [host ownership tests](tests/tui-ownership.test.ts),
[application tests](tests/application.test.ts), and [capability tests](tests/session-capabilities.test.ts) protect those
invariants. Tool contracts, controls, and rendering behavior are in the [reference](docs/reference.md).
