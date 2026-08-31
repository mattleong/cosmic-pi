# Architecture

`pi-ask-user` is an Effect-managed Pi extension for structured user decisions.

## Source map

- `src/extension.ts` is the thin Pi registration entrypoint.
- `src/layer.ts` composes the session Layer from only the current `ExtensionContext` and dialog bridge.
- `src/application.ts` owns the wider runtime-slot input, session lifecycle, deferred tool registration, and inline `/ask-user` command registration.
- `src/boundary/host-dialogs.ts` adapts RPC and TUI dialogs and exports one plain session host callback factory. RPC walks interruption-linked native answer, optional-note, and final review dialogs; review can submit, replace one answer, or cancel without returning drafts. The TUI path uses an interruptible `Effect.tryPromise` with synchronous `Effect.ensuring` cleanup.
- `src/boundary/host-external-editor.ts` owns Pi settings, scoped temporary files, and the inherited-terminal child process. Each call runs one named `Effect.runPromiseExit` boundary that locally provides a fresh file/process Layer, closes its resources before the exit is observed, and sanitizes edited text before returning it to Pi's editor.
- `src/boundary/host-ui.ts` is the synchronous active-dialog and status bridge. It stores one resume callback and no raw terminal listener.
- `src/questionnaire/` owns the TypeBox request schema and cross-module request types, immutable answer and state contracts, semantic validation, the pure reducer, typed errors, and the serialized Effect service. Choice and question schema values stay private to `schema.ts`.
- `src/tools/ask-user.ts` owns LLM response formatting and `ask_user` registration through the `pi-code-previews` cooperative shell. The tool receives a domain callback instead of an Effect service or runner.
- `src/ui/` owns input routing, synchronous dialog rendering, markdown previews, and pure layout helpers. `layout.ts` contains only width and column helpers. The dialog keeps the `?` help toggle and navigation-only Vim aliases from `pi-cosmic-ui/manager/keymap`; embedded editors retain ordinary text input, and `q` never cancels the dialog.
- `tests/` protects lifecycle admission and cleanup, questionnaire semantics, host boundaries, defensive rendering, bridge ownership, and public dialog and layout behavior.

## Ownership

The runtime slot and activation token admit calls only to the current session. The session Layer constructs one plain host callback and injects it into `AskUserService`; there is no one-consumer host Context service. One service semaphore serializes admitted questionnaires, while semantic validation runs before permit acquisition. The Pi host owns the actual TUI or RPC dialog, and interruption is forwarded through the Effect-owned signal. A TUI abort calls Pi's `done` callback so the overlay cannot outlive the tool execution. Session runtime disposal interrupts pending dialog work and clears the synchronous bridge.

The application builds `AskUserService.use(service => service.ask(request))`, checks the current activation token, and runs that Effect through the session slot. The tool module sees only `(request, signal) => Promise<AskUserOutcome>`. This keeps Effect services and runtime admission out of synchronous tool rendering.

The TUI dialog component owns only its in-progress presentation state, and its reducer is pure. Internal answer drafts contain selected values or custom text plus an optional note. They do not copy question keys or choice labels. One pure finalizer combines a question with a draft, removes repeated values after their first occurrence, and builds the public answer. The TUI reducer stores values in authored choice order. RPC retains first-entered value order through review. Cancellation in either mode returns no drafts.

The active-dialog bridge exposes only resume behavior and a status projection. Pressing `b` uses Pi's `setHidden(true)`, which transfers focus away from the mounted overlay. `/ask-user`, registered directly by `application.ts`, restores it with `setHidden(false)`, which restores overlay focus. The extension never registers a hidden raw terminal listener, so it cannot steal keys from unrelated overlays.

The external-editor adapter is the sole Node process/filesystem boundary. It passes the temporary filename separately from the trusted configured shell command, inherits the terminal, reacts to cancellation through Effect interruption, removes the scoped temporary directory, and restarts the TUI in a finalizer. Edited output loses terminal controls before it reaches Pi's `Editor`; Markdown, ordinary text, newlines, and tabs remain intact.

Synchronous call and result renderers decode unknown replay data through private, service-free Effect Schema projections. They use `Schema.decodeUnknownOption` and do not run an Effect. Projections keep only titles, answer keys, labels, custom text, and outcome tags. Question, answer, and label arrays are capped at the public tool cardinalities. They do not duplicate TypeBox string limits because the two schema libraries count Unicode text differently. Invalid call arguments render a neutral call. Invalid details use sanitized text content, with each unknown content part decoded separately so one malformed part cannot hide valid text.

## Lifecycle and modes

The extension factory registers callbacks and `/ask-user` but acquires no resources. `session_start`:

1. captures the Pi session host;
2. skips the runtime and tool when `ctx.hasUI` is false;
3. starts one managed session runtime whose Effect startup workflow loads trusted code-preview settings;
4. activates only after that interruptible prerequisite settles;
5. wraps and registers `ask_user` from the slot's current-session activation hook.

The runtime slot and activation token are the session admission authority; the service semaphore serializes calls after admission. Replacing or shutting down a session forwards cancellation to a pending settings bootstrap, detaches loaders that ignore it, and disposes the runtime idempotently. The slot's synchronous deactivation hook is the sole owner of bridge clearing and context reset. The previously registered tool rejects while replacement startup is pending, so it cannot enter a runtime before activation.

After the lazy TUI import settles, the dialog boundary checks interruption before reading editor settings or mutating Pi UI. Pinned Pi invokes the custom factory once, synchronously, before `custom` returns its Promise. The custom call therefore owns one callback `AbortController`, an at-most-once settlement latch, and only the bridge token returned by that factory invocation. The controller signal is the authority for dialog callbacks and external-editor work. Its synchronous `ensuring` finalizer aborts that authority, closes through the captured `done`, and clears only the owned token without joining the host Promise. Interruption completes even when the custom Promise never settles. A submitted result remains authoritative when cleanup runs. Duplicate or late factory handling and inert fallback components are outside the pinned host contract.

Lifecycle tests protect deferred registration through preview-settings startup, stale-session rejection during replacement, activation after a rejected loader, and contained command-notification failures; generic slot replacement and cancellation behavior remains delegated to `pi-cosmic-core`. Service and host-boundary tests cover validation and serialization, answer ordering, interruption and cleanup, and bridge-token ownership. Production has no test-only importer seam, so tests do not pause inside module resolution itself.

- TUI uses the full custom overlay.
- RPC uses native `select` and `input` dialogs only. Single-select keeps the inline custom-answer action. Multi-select first separates listed choices from custom text, and invalid listed-choice syntax is re-prompted rather than reinterpreted. Each answer can receive a note bounded by `MAX_NOTE_LENGTH`; the final review can submit, revisit one question while retaining its note, or cancel.
- JSON and print modes never receive the tool.

## Security and privacy

Question prompts, previews, answers, and notes are session content. They are never logged, placed in errors, or added to telemetry attributes. Semantic validation errors identify only one-based question and choice positions, never request content. Prompt guidance explicitly forbids collecting credentials. Host dialogs, including RPC note and review summaries, tool responses, tool renderers, dialog renderers, previews, and external-editor output each strip terminal controls at their own consumption boundary. Tests cover defensive replay decoding and sanitization at these boundaries.
