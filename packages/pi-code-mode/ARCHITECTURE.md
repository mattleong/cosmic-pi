# Architecture

`pi-code-mode` owns one Effect-managed Pi extension. It provides trusted-project configuration,
the session lifecycle, `/code-mode-settings`, and one `code_mode` tool. A tool call runs one
confined JavaScript program over seven core Pi built-ins under `tools.pi`: `read`, `bash`, `edit`,
`write`, `grep`, `find`, and `ls`. Windows sessions also supply `tools.pi.powershell`. The reviewed
`tools.session.backgroundTask` leaf reaches the current `pi-background-task` runtime through its
versioned session protocol. The fixed `tools.mcp.request` leaf queries `pi-mcp` through its own
versioned session protocol. The private runtime supplies `tools.$codemode.search`.

The interpreter is the nested `pi-code-mode-runtime` workspace package under `runtime/`. Its TypeScript source ships in this package and loads through one computed relative import
in `src/boundary/codemode-runtime.ts`. The nested package name is never resolved at runtime, so a
packed install needs no private registry package and uses the extension's single Effect instance.
Only runtime source plus its README, legal, and provenance documents ship.

## Grouped ownership

- `src/extension.ts`, `application.ts`, and `layer.ts` own Pi registration, session replacement,
  the private runtime slot input, the synchronous state projection, and Layer composition.
- `src/config/` owns field schemas, defaults, bounds, tolerant scope resolution, provenance, and
  the only persistence door, `CodeModeConfigStore`.
- `src/settings/` owns command dispatch, completions, list behavior, custom integer flow, and
  notifications. `src/boundary/host-ui.ts` is the Promise and callback adapter for Pi dialogs.
- `src/tools/` owns the reviewed guest catalog, execution admission, UTF-8 limits, progress state,
  result formatting, failure-detail retention, tool registration, and active-list reconciliation.
  Its Background Tasks and MCP leaves import producer-owned v1 input/output codecs instead of
  declaring second protocol shapes. Neither adapter invokes a registered tool definition.
- `src/ui/` is pure presentation. `tool-render-details.ts` tolerantly normalizes current and
  legacy details, ignores malformed rows, and retains valid explicit totals. `tool-renderer.ts`
  renders calls and results with Cosmic UI's semantic tool header, activity, and disclosure vocabulary, while `result-output.ts` projects small structured results without
  changing model-visible text. `compact-summary.ts` opts only the outer tool into the shared
  compact shell. It requires consistent current details and explicit execution success evidence,
  retains failure recovery text, and warns on handled nested failures or output truncation.
  It pairs intent with one exact call count after settlement or a done/total count while running.
  Final host clamping publishes the truncation flag without changing model-visible content.
  The shared shell owns compact animation and expansion; nested dispatch remains direct.
  Nested MCP and Background Tasks payload outcomes are not part of the retained activity
  projection. Settled adapter calls and incomplete call history therefore retain the original
  renderer instead of turning Promise fulfillment into compact success.
- `src/boundary/` contains the runtime import, fresh Pi built-in adapters including conditional
  Windows PowerShell, explicit Background Tasks and MCP protocol clients, the guarded progress
  publisher, the hostile renderer-ticker adapter, Pi dialog adapters, and the process-memory
  deactivation handoff. Foreign Promise
  adapters use function-form `Effect.tryPromise`; they format `Cause.UnknownError.cause` through
  the hostile-safe rejection formatter before returning a model-visible tool failure.
- `tests/` covers configuration, atomic commits, lifecycle races, dialogs, adapters, limits,
  interpreter integration, progress, retention, and fail-soft rendering. `runtime/tests/` remains
  owned by the private runtime package.

## Trust and configuration

Global configuration is `<agent-dir>/extensions/pi-code-mode.json`. Project configuration is
`<cwd>/.pi/extensions/pi-code-mode.json`. Fields resolve project over global over default, one
field at a time. Malformed fields fall back independently. Writes preserve unknown fields.

An untrusted project performs no project-document I/O. The store calculates the project path for
its private persistence state but never stats, reads, or writes it. Availability is
`projectTrusted && config.enabled`.

The published `CodeModeState` contains the resolved config, scoped values, provenance, trust, and
availability. The store captures fixed scope paths at acquisition and projects only this state.
Startup uses the shared scoped resolver and seeding policy; existence metadata is not retained.
Startup and commits share the same pure values resolver.

`CodeModeConfigStore` serializes writes with one semaphore. Before commit it captures the other
scope's document. The committed document then resolves to the next state without post-commit I/O.
A Deferred carries publication from the JSON rename's narrow uninterruptible `afterCommit` region
back to the caller. The renamed document and authoritative frozen projection therefore advance as
one commit. A hostile publication callback becomes a typed `CodeModeConfigError`; the committed
file remains, the prior projection stays authoritative, and a later write re-derives from disk.

## Session lifecycle and publication

`session_start` captures cwd, trust, and an owned signal before replacing the prior runtime. A
capture failure shuts the old slot down. Each private slot input carries its own
`MutableRef<boolean>` publication owner, created immediately before `slot.start`. The Layer
publisher writes `stateRef` only while that owner is true.

`onDeactivated` first sets the owner false, then clears `stateRef` and deactivates `code_mode`.
This ordering blocks a prior session's uninterruptible commit from publishing after replacement
has begun. State remains unavailable until the replacement Layer publishes.

Startup acquires the store and, only when the live snapshot is available, runs preview settings
through `bestEffortHostBootstrap`. The bootstrap is interruptible, contains foreign failures, and
detaches a Promise that ignores cancellation. Startup returns `void`. `onActivated` first checks
both publication ownership and slot-token currency, then rereads the guarded live `stateRef`.
Definition construction, wrapping, registration, and activation retain currency checks before and
after host work. Preview settings always finish before `withCodePreviewShell` wraps the tool.

Replacement and shutdown revoke publication, interrupt startup and session fibers, dispose the
runtime, clear state, and deactivate only `code_mode`. Pi has no unregister operation, so every
old definition also checks its token and the current live availability before execution.

User deactivation survives module recreation through `host-deactivation-handoff.ts`. The old
instance publishes a true-only, TTL-bounded entry keyed only by Pi's stable session id. The next
instance consumes a matching entry. A different or missing id starts active; cwd is never an
identity fallback. Unrelated active-tool names and their order are preserved.

## Settings workflow

The bare TUI command submits one outer session Effect. It selects scope, opens the list, handles a
custom integer prompt, applies the value, and reopens from a fresh snapshot. Pi has one editor
slot, so `done(PromptInteger)` closes the list before `ctx.ui.input` opens.

Every list iteration records the Promises started by preset and `inherit` callbacks. Once the
custom list settles, the outer Effect joins all recorded writes before handling Closed or
PromptInteger, opening input, reading a new snapshot, or reopening. `applySetting` makes these
Promises nonrejecting. The join remains interruptible, so session disposal can end the outer
workflow even while a foreign callback settles late. A preset commit already inside the store's
uninterruptible commit region finishes publication before custom input continues.

All settings checks use one guarded `signalAborted` helper. It invokes the host getter through
`invokeHostCallback` and falls back to `true`. A throwing `aborted` getter therefore exits without
UI, persistence, or notification work. The same guard covers command admission, the active write
callback, list callbacks, input application, and reopen checks.

`host-ui.ts` adapts select, input, and custom dialogs. The custom adapter owns a callback
`AbortController` and exact-once latches. Its finalizer revokes callbacks and calls an available
`done(Closed)` once. A normal PromptInteger remains authoritative. A late factory receives an
inert component. Preset writes use the list signal, ignore stale callbacks, and restore the
persisted row after an active failure.

## Tool execution and limits

The catalog contains seven core `tools.pi` leaves, conditional Windows PowerShell, the fixed
`tools.session.backgroundTask` and `tools.mcp.request` adapters, and runtime-owned search. Inputs pass Effect Schema before
dispatch. Read offsets and limits are positive safe integers, as are grep, find, and ls limits.
Grep context is a non-negative safe integer. Bash and PowerShell timeouts are positive finite
numbers and may be fractional. Invalid numeric input fails before a fresh Pi definition runs.

Fresh Pi definitions execute directly, so nested calls bypass Pi `tool_call` and `tool_result`
middleware, approvals, previews, registered overrides, and session-specific operations.
Background Tasks calls query one stable-session, token-checked Promise capability on each
invocation. They never dispatch the registered top-level definition.

`boundary/host-mcp.ts` queries exactly one active stable-session provider per request through
`pi-mcp/code-mode`. That import loads codecs, not an extension or runtime. The provider owns
connections, authentication, policy, validation, and result retention. The guest can request
status, server instructions, bounded discovery, exact tool calls, resources/templates, prompts,
and retained result reads, but not explicit connection management, authentication, configuration
writes, or arbitrary protocol methods. `server.instructions` projects the producer's bounded,
connection-owned handshake snapshot without catalog discovery or an application RPC; it remains
untrusted data. The same MCP execution service enforces both gateway and nested-call policy.

MCP replies preserve `not-sent`, `completed`, and `unknown` certainty independently of `isError`.
The consumer validates bounded JSON, rejects binary payloads, and charges compact JSON or
catchable failures to the remaining child-output budget. Native images never cross the protocol.
A post-settlement projection failure retains known completion and does not authorize replay.
Resource/prompt content stays untrusted data; the adapter does not follow links, install commands,
or inject messages. MCP servers retain their own local-user or remote authority and are not
sandboxed by the interpreter. Nested MCP operations bypass Pi middleware and unrelated approvals,
just like the Background Tasks capability; only the outer Code Mode call uses that middleware.

Interpreter confinement limits JavaScript, not supplied-tool authority. Bash has full local-user
process, environment, network, and filesystem authority. Read, edit, and write accept relative,
absolute, and home-relative paths. Mutations happen immediately and cancellation cannot roll them
back. Pi built-in results carry text only; images are refused and built-in result details are
dropped. Background Tasks returns a copied structured result with bounded text and metadata.

Each execution applies source, time, call-count, result, cumulative child-output, and discovery
budgets. Success formatting uses compact JSON for non-string values and preserves returned
strings and log contents. The final `clampModelVisibleText` bounds all model-visible success,
failure, cancellation,
source-refusal, and unexpected-error text by exact UTF-8 bytes without splitting a code point.
Zero bytes yields empty text. Only the stale or missing-state refusal uses a fixed bounded message
because no current configuration exists. Successful nested text and catchable failure text share
one cumulative budget. Structured Background Tasks output is charged as compact JSON. The
provider owns and exports the exact v1 Effect codecs and shared structural bounds. It receives the
remaining allowance, capped at 16 MiB, and refuses an oversized projection before copying
snapshots. The
consumer schema-decodes every provider response with that output codec, repeats the aggregate
estimate, and performs exact atomic admission. An output-overrun refusal is itself admitted
through `admitFailure`, so repeated caught overruns cannot create free diagnostic text.

Progress starts immediately. Queued admission and decoded running labels publish synchronously;
status-only changes coalesce to a 16 ms host frame, and settlement flushes the latest snapshot.
One ordered Map retains up to 256 rows without evicting active calls; exact counts remain separate.
Rows never contain nested output. Selection prioritizes active, failed, cancelled, and recent rows
within 32 visible slots, while exact counts include hidden calls and drive the hidden-row marker.
New details retain `totalToolCalls` when rows are hidden so older renderers keep the marker; exact
counts carry current lifecycle totals. Tolerant render decoding still accepts historical details.
Selected rows and counts are copied before host publication, so a hostile `onUpdate` cannot alter
execution state.

The application composes `CodePreviewSchedulerService.layer` into its own session runtime and passes a token-checked scheduler to the compact shell. It does not depend on the previews extension's isolated module-local runtime; replacement and shutdown cancel remaining compact animations. The original renderer owns a weak 160 ms ticker. The host compact-summary callback releases that ticker when the shared shell hides its rows or the tool settles, even when the original result renderer is not called. Missing or hostile state, invalidation, keybindings, clock,
and ticker callbacks fall back without affecting execution. The controller captures sanitized
expand keys once when it builds the definition. Pure render code always returns a component, even
when hostile details force its emergency path.

Thrown executions retain copied final rows and counts in a bounded one-shot map. The `tool_result`
hook consumes another copy for the matching Code Mode call because Pi otherwise replaces details
with `{}`. Text and `isError` semantics are unchanged.

## Shipping and validation

The package runs from TypeScript source under Pi/Jiti. `package.json` ships `runtime/src/` and the
runtime's legal or provenance files, but not its workspace manifest or tests. Package gates include
typecheck, Effect diagnostics, lint, format, tests, and a dry pack. Workspace validation also
checks layout, versions, source loading, and packed runtime contents.

Completed efficiency experiments are archived in Git, not maintained as package code.
[Historical results](https://github.com/mattleong/cosmic-pi/blob/main/docs/code-mode-efficiency.md)
record the findings and archive reference. Production regression tests retain structured-output,
final-clamp, cancellation, and lifecycle coverage.
