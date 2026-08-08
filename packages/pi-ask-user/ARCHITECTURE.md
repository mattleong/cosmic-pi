# Architecture

`pi-ask-user` is an Effect-managed Pi extension for structured user decisions.

## Source map

- `src/extension.ts` — thin Pi registration entrypoint.
- `src/layer.ts` — session Layer composition.
- `src/application.ts` — session lifecycle, deferred tool registration, and `/ask-user` wiring.
- `src/boundary/host-dialogs.ts` — TUI and RPC dialog boundary with abort-aware Promise adaptation.
- `src/boundary/host-external-editor.ts` — narrow Pi settings, temporary-file, inherited-terminal process, and cleanup boundary.
- `src/boundary/host-ui.ts` — synchronous active-dialog/status bridge used to resume a hidden overlay without a raw terminal listener.
- `src/boundary/host-commands.ts` — `/ask-user` host command registration.
- `src/questionnaire/` — immutable answer/state contracts, semantic validation, pure reducer, typed errors, and serialized Effect service.
- `src/tools/` — TypeBox schema, LLM-facing response projection, and `ask_user` registration through the `pi-code-previews` cooperative shell.
- `src/ui/` — synchronous dialog presentation, responsive layout, input routing, markdown preview projection, a `?` contextual help toggle, and navigation-only Vim aliases from `pi-cosmic-ui/manager/keybindings`; embedded editors retain ordinary text input, and `q` never cancels the dialog.
- `tests/` — lifecycle, host-boundary, reducer, schema, tool, bridge, and width-safety coverage.

## Ownership

`AskUserService` serializes questionnaire admission and delegates to the session's `HostDialogs` adapter. The Pi host owns the actual TUI or RPC dialog; interruption is forwarded through the Effect-owned signal. A TUI abort calls Pi's `done` callback so the overlay cannot outlive the tool execution. Session runtime disposal interrupts pending dialog work and clears the synchronous bridge.

The dialog component owns only in-progress presentation state. Its reducer is pure. Submitted answers become ordinary tool-result details; cancellation deliberately returns no drafts.

The active-dialog bridge exposes only resume behavior and a status projection. Pressing `b` temporarily hides and unfocuses the mounted overlay. `/ask-user` restores and focuses the same component. The extension never registers a hidden raw terminal listener, so it cannot steal keys from unrelated overlays.

The external-editor adapter is the sole Node process/filesystem boundary. It passes the temporary filename separately from the trusted configured shell command, inherits the terminal, reacts to cancellation, removes the temporary directory, and restarts the TUI in a finalizer.

## Lifecycle and modes

The extension factory registers callbacks and `/ask-user` but acquires no resources. `session_start`:

1. captures the Pi session host;
2. skips the runtime and tool when `ctx.hasUI` is false;
3. loads trusted code-preview settings;
4. starts one managed session runtime;
5. wraps and registers `ask_user`.

A preparation generation prevents an obsolete settings load from registering against a replaced session. `session_shutdown` invalidates preparation, clears the bridge, and disposes the runtime idempotently.

- TUI uses the full custom overlay.
- RPC walks native `select` and `input` dialogs sequentially.
- JSON and print modes never receive the tool.

## Security and privacy

Question prompts, previews, answers, and notes are session content. They are never logged, placed in errors, or added to telemetry attributes. Prompt guidance explicitly forbids collecting credentials. All text rendered into the terminal is stripped of terminal control sequences, and all schema/output sizes are bounded.
