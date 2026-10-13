# Questionnaire lifecycle

This note records the ownership decisions behind the [architecture](../ARCHITECTURE.md).
The [tool reference](reference.md) describes the public operations and result shapes.

## Admission and result ownership

[The queue](../src/questionnaire/queue.ts) bounds pending presenters separately from retained
async results. A cancelled queued caller settles promptly, but its ticket remains ordered behind
its predecessor until a session-owned drain releases it. Releasing that slot immediately would
let successors skip an active dialog and make cancellation churn bypass the queue bound.
Overlay and external-editor cleanup finish before a ticket advances; automatic delivery does
not hold a dialog ticket.

[The async controller](../src/questionnaire/async-service.ts) commits ticket acquisition, registry
insertion, and presenter ownership together. It does not hold admission while the user answers.
An immediate opener waits for mounting; a queued opener reports admission before mounting.
Once admitted, the presenter belongs to the session rather than to the opening tool's signal.
An interrupted opening can therefore require recovery through status rather than another start.

Completion records an outcome before waking a waiter or claiming automatic delivery. An await
or unopposed cancel owns a delivery claim; status never consumes results. Cancel still signals
the presenter if another caller owns delivery, then waits without taking that claim.

Waiter acknowledgement and claim release are one owner-checked, interruptible state transition.
An earlier tentative acknowledgement would lose recoverability if interruption occurred before
the caller finished. Interruption before the transition releases only that caller's claim and
offers automatic delivery; cancellation afterward cannot revoke the acknowledgement or touch a
successor's claim. Failed openings become evictable only after acknowledgement. Undelivered
answers and unacknowledged failures are retained, so a full registry rejects new admission.

Automatic delivery uses session-scoped bounded retries. An await suppresses pending retries;
closure revokes delivery before interrupting its children. A successful public `sendMessage`
returns no acceptance receipt, so `sent` means only that the call returned. Results survive
delivery attempts, and repeated delivery IDs identify the same result.

[Async service tests](../tests/async-service.test.ts) force these races, including interruption
immediately before acknowledgement, queue cancellation, retention exhaustion, and retry shutdown.

## TUI and external-editor handoff

[Prompt admission](../src/boundary/host-prompt.ts) tracks Pi's coalesced prompt lifecycle rather
than treating events as per-dialog counters. [The TUI adapter](../src/boundary/host-tui.ts) checks
admission again after lazy loading, synchronously with opening the owned surface. A queued
presenter retries when an unrelated prompt wins that race.

Pi creates the component before acknowledging its mount. Only the mount callback acknowledges
an opening; a late mount after revocation must immediately close without activating the dialog.
Cosmic UI's [owned surface](../../pi-cosmic-ui/src/boundary/host-surface.ts) also isolates Pi's
global-stack `done` behavior: it removes the owned overlay and closes through an inert guard so
an unrelated overlay above it is preserved. A failed removal or guard acquisition must not fall
back to an unguarded `done`.

Closing revokes callback and editor-admission authority before finishing the surface. It then
joins every admitted [external editor](../src/boundary/host-external-editor.ts), including process
termination, temporary-file cleanup, and TUI restoration. This join is necessary: activating the
replacement first could stop its TUI before the previous editor restarts it. Late editor results
cannot modify a revoked dialog.

On macOS and Linux, editor commands run through `/bin/sh`, with `nano` as the default. The
temporary answer path is passed as a positional argument, preserving its literal filename.
Cancellation sends `SIGTERM` and escalates to `SIGKILL` if needed before the TUI is restored.

Cleanup waits for owned settlement, not a possibly nonsettling Pi custom-UI Promise. A failed
host close can still leave an overlay or public prompt span behind. The gate waits for a real
prompt-end event or session replacement instead of inventing a reset that could steal foreign
input. [Host UI tests](../tests/host-ui.test.ts), [TUI ownership tests](../tests/tui-ownership.test.ts),
and [application tests](../tests/application.test.ts) exercise stacked overlays, late mounts,
close faults, and replacement during editor cleanup.

## Branch and child authority

[The delivery boundary](../src/boundary/host-delivery.ts) appends generation/delivery receipts to
the originating branch before sending. The application snapshots active-branch receipts before
yielding into replacement. Historical messages need that independent evidence; trusting message
metadata itself would let a stale queued answer become valid after navigation or reload. If
branch evidence cannot be read, old-generation messages are excluded from model context. Receipts
neither restore pending work nor prove model consumption.

[Owned-call capabilities](../src/boundary/host-owned-calls.ts) bind child requests to exact owner
tuples and a root generation. Launch markers require relay but do not authenticate ownership.
Revocation aborts calls before disposal; cancellation acknowledges only after the captured call's
runtime Promise and finalizers settle. Old cancellation handles can join only their own generation.
[Delivery tests](../tests/async-delivery.test.ts) and [proxy tests](../tests/proxy.test.ts) protect
these authority boundaries.
