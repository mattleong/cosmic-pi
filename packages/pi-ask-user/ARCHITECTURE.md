# Architecture

`pi-ask-user` is an Effect-managed Pi extension for structured user decisions.

## Source ownership

- `src/extension.ts` is the thin Pi registration entrypoint.
- `src/application.ts` owns the core session-runtime slot, trusted preview bootstrap, current-generation admission, deferred tool registration, `/ask-user`, and lifecycle/context handlers.
- `src/layer.ts` composes the current host callbacks into `AskUserService`. No host service or package-local runtime is added.
- `src/questionnaire/service.ts` validates and serializes blocking calls with one dialog semaphore. Its private `async-service.ts` controller shares that semaphore and owns async request state, opening/completion/cancellation Deferreds, waiter ownership, retention, and presenter/delivery fibers. `async-model.ts` holds the public snapshots; `format.ts` formats answer and control text.
- `src/questionnaire/schema.ts` owns Pi TypeBox schemas and request types. Semantic validation and the pure reducer retain their existing roles. Drafts contain selected values or custom text plus an optional note, not copied keys or labels. One finalizer combines the question and draft into a public answer. Cancellation never returns drafts.
- `src/boundary/host-dialogs.ts` adapts abort-aware RPC answer, note, and final review calls. `host-tui.ts` owns the custom overlay, mount acknowledgement, and synchronous cleanup. `host-ui.ts` retains only a token-checked resume capability and status, with no raw terminal listener.
- `src/boundary/host-delivery.ts` appends versioned branch receipts before calling the public custom-message sender, creates runtime generation IDs, reads active-branch receipt evidence, and checks bounded message metadata for context filtering.
- `src/boundary/host-prompt.ts` tracks Pi's coalesced public prompt lifecycle and this package's custom-call ownership. The application checks admission; the TUI boundary checks again immediately before mounting.
- `src/boundary/host-external-editor.ts` owns Pi settings, temporary files, and the inherited-terminal child process. Its named Promise boundary provides scoped file/process resources, requests termination on cancellation, removes owned files, and restarts the TUI. Trusted editor configuration and generated filenames are passed separately.
- `src/tools/` owns blocking and async definitions and Promise-shaped domain callbacks. All questionnaire tools, including async control, use the cooperative `pi-code-previews` shell.
- `src/ui/` owns synchronous presentation, input routing, previews, and pure layout. Embedded editors retain ordinary text input; navigation-only Vim aliases and `?` help come from Cosmic UI. `q` never cancels the dialog.
- `tests/` protects questionnaire semantics, serialization, lifecycle, ownership races, host boundaries, defensive replay rendering, and public dialog behavior.

## Async ownership and delivery

`AskUserService` constructs the async controller under its Layer scope. The controller forks a child scope for presenters and delivery work; a later parent finalizer revokes delivery before child shutdown. One immutable `Ref` array owns at most 16 request entries. New admission evicts only the oldest terminal entry without a waiter whose delivery is `sent` or `waiter`. Failed and undelivered results are not evicted. A full registry without an eligible entry rejects admission rather than growing. Entries retain bounded work descriptions and final outcomes, not completed question drafts or host callbacks.

Async admission validates first and reserves the shared dialog permit without waiting. Permit acquisition, registry insertion, and session-scope fork form a short uninterruptible commit. The presenter releases the permit in its finalizer. No admission lock is held while the user answers. Blocking calls keep their existing semaphore serialization and reject while an async request is pending; async calls reject while either kind of dialog holds the permit.

The opening tool waits only for the separate mount Deferred. Its caller signal never owns the presenter. If the opening call is interrupted after admission, `status` can recover the request ID. Opening failure settles a failed request, releases the permit, and fails the mount Deferred. Presenter cancellation races the host through an Effect-owned Deferred; tool await interruption does not cancel it.

Waiter claims are atomic `Ref.modify` transitions. A live await or unopposed cancel caller owns result delivery for that request. Cancel still signals the presenter when another caller owns delivery, then waits non-consumingly for cancellation to settle. Completion records the answer before waking the waiter or attempting automatic delivery. The waiter commits its delivery state before returning, and its finalizer releases ownership. An outer interruption handler also covers the uninterruptible commit and cleanup exits. If the caller rejects after committing delivery, it restores pending delivery and schedules automatic delivery in the session scope. Status is non-consuming; list status returns metadata only so it cannot multiply full answer output by the retention limit.

Without a waiter, the service claims automatic delivery. The host emits a custom `pi-ask-user-async-answer` message with `deliverAs: "steer"` and `triggerTurn: true`. This can continue an idle agent but cannot interrupt Pi's current tool batch. Request and delivery IDs remain stable across messages and control results. Results are retained after every delivery attempt. A synchronous host failure records `failed` and schedules at most two retries, one second apart, in the session scope. These sleeps do not hold the dialog permit. Recovery through await suppresses retries; scope closure cancels them. Exhausted failures remain retained for status/await recovery.

Pi's public sender returns `void`. `sent` therefore means only that the call returned. Later host errors and model consumption are not acknowledged, so this package promises neither exactly-once delivery nor reliable acceptance. Repeated delivery IDs must be treated as the same result. A status read can overlap an already claimed automatic message.

## TUI lifecycle and pinned host workaround

The TUI boundary lazily imports the dialog, then checks Effect interruption before reading settings or calling Pi. Async admission rejects while a public UI prompt is active. A second check immediately before `ui.custom` catches prompts that start during the import. Pi coalesces nested prompts, so the boundary does not treat events as per-dialog counters or clear public prompt activity when only its own dialog closes. Each custom call owns one callback AbortController, finish latch, bridge token, and overlay handle. Pinned Pi calls the component factory synchronously but mounts in a Promise continuation. `onHandle`, not factory execution, completes the opening Deferred. A finish requested before mounting is latched; a late mount immediately removes the revoked questionnaire without activating its bridge.

Pi 0.85's custom `done` implementation pops the global overlay stack rather than removing its own overlay. Hiding or focusing the questionnaire does not fix stack ownership. The isolated `finishOwnedOverlay` workaround uses only public APIs in one synchronous window:

1. remove the questionnaire through its owned handle;
2. mount an inert, noncapturing guard overlay;
3. call Pi's `done`, which pops that guard;
4. remove the guard idempotently in `finally`.

An unrelated overlay above a hidden questionnaire is left intact. There is no asynchronous yield, private stack access, or installed dependency patch. Remove this workaround when pinned Pi's `done` removes its own overlay by identity. Host tests exercise submission, interruption, another stacked overlay, and abort before mount. Cleanup detaches from nonsettling host Promises instead of delaying scope closure. Host callback authority and external editing are revoked even when the Promise never settles.

Pressing `b` uses the owned handle's `setHidden(true)` and preserves the mounted dialog's drafts. `/ask-user` restores it with `setHidden(false)`. The main editor is never replaced or rewritten. Pi's UI-prompt notifications still include hidden custom dialogs; they do not pause agent execution.

## Session lifecycle and history

The factory registers callbacks and `/ask-user` without acquiring resources. `session_start` captures the host, skips modes without UI, starts one core managed runtime, loads trusted preview settings, and only then registers tools from the current activation hook. TUI receives all three tools; RPC receives only the unchanged blocking tool. Pi's `ctx.signal` is turn-dynamic and is not attached to the session slot, including tree restarts. Per-tool calls receive their own signals; explicit slot disposal still interrupts preview bootstrap and session work.

Shutdown, reload, session replacement, and successful tree navigation revoke admission and delivery before disposal. Tree navigation replaces the runtime because Pi otherwise keeps it alive. Old registered tool callbacks reject during replacement. The slot's synchronous deactivation clears the bridge and current generation; no questionnaire is durably restored.

Immediately before each send, the host synchronously appends a version-1 `pi-ask-user-async-delivery` custom entry containing only generation and delivery ID to the originating branch. At session start and tree navigation, the application snapshots generation/delivery pairs from these receipts on the active branch before yielding into replacement. Answer messages never establish their own provenance. Context filtering admits this package's messages only if they belong to the current generation or have active-branch receipt evidence. Valid historical answers survive resume/navigation. A stale queued message persisted on a different branch stays rejected across repeated navigation and reload. Receipts do not restore pending work or confirm model consumption. Other messages and other extensions' queues are untouched. If the branch read is unavailable, old-generation messages fail closed. Filtering affects model context, not the visible transcript.

## Modes, security, and rendering

RPC retains native `select`/`input` answer, optional-note, and review/edit/submit/cancel behavior. Its calls receive Effect-owned abort signals. Multi-select input accepts only valid choice numbers rather than reinterpreting malformed syntax as custom text. JSON and print modes receive no questionnaire tools.

Prompts, previews, answers, notes, and work descriptions are ordinary session content. They never enter errors, logs, or telemetry attributes. Validation errors identify only question/choice positions. Guidance forbids collecting credentials. Every text consumption boundary strips terminal controls, including automatic messages and status output.

Blocking and async renderers decode unknown replay details using private service-free Effect Schema projections. They cap array cardinalities, return neutral content for malformed input, and sanitize fallback text parts independently. `src/ui/async-tool-render.ts` projects async tool cards and automatic answer messages into readable states, answers, and notes. Expanded views retain request/delivery metadata and full text, without implying model acknowledgement. Tool registration also installs the existing async custom-message type's renderer. Agent-facing content, details, and safety guidance are unchanged. Synchronous renderers never read the service or run Effects.
