# Architecture

`pi-ask-user` is an Effect-managed Pi extension for structured user decisions.

## Source map

- `src/extension.ts` is the thin Pi registration entrypoint.
- `src/layer.ts` composes the session Layer.
- `src/application.ts` owns session lifecycle, deferred tool registration, and inline `/ask-user` command registration.
- `src/boundary/host-dialogs.ts` adapts RPC and TUI dialogs. RPC calls receive interruption-linked signals. The TUI callback has no-throw, token-owned settlement.
- `src/boundary/host-external-editor.ts` owns Pi settings, scoped temporary files, and the inherited-terminal child process. Each call runs one named `Effect.runPromiseExit` boundary that builds the file/process Layer in a fresh scope, provides its context, closes the scope before the exit is observed, and sanitizes edited text before returning it to Pi's editor.
- `src/boundary/host-ui.ts` is the synchronous active-dialog and status bridge. It stores one resume callback and no raw terminal listener.
- `src/questionnaire/` owns the TypeBox request schema and cross-module request types, immutable answer and state contracts, semantic validation, the pure reducer, typed errors, and the serialized Effect service. Choice and question schema values stay private to `schema.ts`.
- `src/tools/` owns LLM response formatting and `ask_user` registration through the `pi-code-previews` cooperative shell. The tool receives a domain callback instead of an Effect service or runner.
- `src/ui/` owns input routing, synchronous dialog rendering, markdown previews, and pure layout helpers. `layout.ts` contains only width and column helpers. The dialog keeps the `?` help toggle and navigation-only Vim aliases from `pi-cosmic-ui/manager/keymap`; embedded editors retain ordinary text input, and `q` never cancels the dialog.
- `tests/` covers lifecycle, service serialization and interruption, host boundaries, reducer and schema policy, defensive tool rendering, bridge ownership, and public dialog behavior. Dialog width tests exercise stacked and side-by-side preview layouts.

## Ownership

The runtime slot and activation token admit calls only to the current session. `AskUserService` then uses one semaphore permit to serialize admitted questionnaires before delegating to the session's `HostDialogs` adapter. The Pi host owns the actual TUI or RPC dialog; interruption is forwarded through the Effect-owned signal. A TUI abort calls Pi's `done` callback so the overlay cannot outlive the tool execution. Session runtime disposal interrupts pending dialog work and clears the synchronous bridge.

The application builds `AskUserService.use(service => service.ask(request))`, checks the current activation token, and runs that Effect through the session slot. The tool module sees only `(request, signal) => Promise<AskUserOutcome>`. This keeps Effect services and runtime admission out of synchronous tool rendering.

The dialog component owns only in-progress presentation state. Its reducer is pure. Submitted answers become ordinary tool-result details; cancellation deliberately returns no drafts.

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

After the lazy TUI import settles, the dialog boundary checks interruption before reading editor settings or mutating Pi UI. It installs the abort listener, and the overlay factory checks interruption again before activating the bridge. Cleanup clears the bridge only when that overlay received an activation token, so a never-activated or stale operation cannot clear another owner. Dialog, abort, and post-factory cancellation share a no-throw settlement wrapper. If Pi's `done` callback throws synchronously, the wrapper clears and resets only that overlay's bridge token.

Lifecycle tests assert tool registration timing through the preview-settings Promise, stale replacement rejection, best-effort activation past a rejected loader, and contained command notification; generic slot replacement and cancellation behavior is delegated to `pi-cosmic-core`. Service and host-boundary tests cover semaphore serialization, interrupted queue removal, the observable immediate-abort path around the native lazy import, and rejection before bridge activation. Production has no test-only importer seam, so tests do not pause inside module resolution itself.

- TUI uses the full custom overlay.
- RPC walks native `select` and `input` dialogs sequentially.
- JSON and print modes never receive the tool.

## Security and privacy

Question prompts, previews, answers, and notes are session content. They are never logged, placed in errors, or added to telemetry attributes. Semantic validation errors identify only one-based question and choice positions, never request content. Prompt guidance explicitly forbids collecting credentials. Host dialogs, tool responses, tool renderers, dialog renderers, previews, and external-editor output each strip terminal controls at their own consumption boundary. Tests cover mixed malformed render content, array over-cardinality, control stripping, and Unicode titles alongside lifecycle, cancellation, serialization, and bridge-token ownership.
