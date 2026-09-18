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
  It opts into measured parent timing beside that count. Child timing uses standalone visibility
  and formatting rules without a nested-only override. `boundary/host-child-timing.ts` records
  process-local clock tokens at decoded call start and projects live elapsed time on the shared
  shell's existing refresh cadence, without per-child timers. Execution revokes tokens on child
  settlement and every outer exit; serialization cannot recreate timing authority. Queued and
  historical running rows have no live elapsed time. Settled rows retain the runtime's measured
  admission-to-settlement duration, including queue wait. No child durations are inferred or summed.
  Its optional compact child tree projects retained call names, lifecycle and builtin targets,
  with exact totals for the shared shell's omitted-call marker. Duplicate calls remain distinct.
  `tools/compact-subject.ts` captures allowlisted paths, read ranges, commands and search targets
  at decoded call start using Code Previews' shared argument-only formatter. It redacts fields
  before clipping, caps subjects at 1024 code points and contains formatting failures. Replay
  validates subjects without resolving paths again; older rows remain names-only. New calls retain
  only this redacted heading, not a second argument-derived activity label. Historical activity is
  redacted before clipping during replay. Input objects,
  write/edit bodies, MCP argument payloads and returned output never enter these subjects.
  Producer-owned argument-only projections supply MCP and Background Tasks headings. Correlated
  receipts supply semantic child statuses; delivery failures override successful operation colors
  without changing the recorded operation outcome. `call-rows.ts` shares this receipt projection
  with `expanded-result.ts`. Expansion renders Program, Calls, and Result sections.
  `notices.ts` collects evidence for compact, detailed, and emergency views; each view controls
  visibility and affected-call ownership. Replay normalizes each row once, salvaging bounded valid
  notices separately when sibling fields invalidate its receipt.
  `sections.ts` owns real spacer rows and width-aware indentation. Calls reuse flat compact
  rows with plain hints beneath each row; the collapsed tree remains unchanged. Aggregate
  recovery has its own Notices section so it cannot appear to belong to the last visible call. `program-source.ts` formats source without rewriting tokens; `result-output.ts` pretty
  prints only complete successful structured output. The controller captures shell style with
  its definition-owned summary provider. Compact expansion owns one header/source; preview style
  keeps the call slot. Render failures retain bounded source and independent recovery text.
  Final host clamping publishes the truncation flag without changing model-visible content.
  The shared shell owns compact animation and expansion; nested dispatch remains direct.
  MCP compact outcomes use versioned, schema-validated execution evidence, not guest return
  values or Promise fulfillment. The bounded aggregate covers every admitted call independently
  of display history and preserves MCP certainty, error counts, and sanitized warning/recovery
  notices, including retained-read origin outcomes and output validation. New incomplete or
  overflowing evidence produces explicit attention in both compact and detailed views. Historical
  unsupported calls keep the original renderer. The shared child selector identifies notices
  rendered on visible children; hidden and evicted notices remain parent-owned.
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

## Discovery snapshots

The private runtime's `snapshot()` and `update(previous)` compare discovery metadata without
changing the callable tool tree. `runtime/src/catalog.ts` owns replacement/delta/no-op decisions.
Snapshots retain only budget-selected signatures, concise descriptions, namespace counts, and
complete instructions. Canonical callable paths preserve literal property segments. Search still
indexes every described tool and keeps round-robin catalog selection across namespaces.

Pi continues to register complete `code_mode` parameters and instructions at session activation.
Its guest catalog is fixed; it does not send catalog deltas, import arbitrary registered tools,
or treat MCP discovery as permission to add guest leaves. The runtime API allows other host
consumers to deliver discovery updates, but is not a provider-schema replacement or a Pi token
savings mechanism. Snapshot data carries no execution authority. Runtime `namespace.ts` owns
optional host-only descriptions; ancestor descriptions affect search, and bounded namespace
metadata participates in catalog replacement. `tool-schema.ts` owns constraint documentation,
not a JSON Schema validator. Pi's supplied tools continue to use Effect Schema decoding.

The runtime also owns assignment ordering and iterator-aware destructuring, a fixed synchronous
guest call-depth cap of 128 with semantic-await resets, and bounded owned bytes/UTF-8/base64/hex.
These add no extension setting or ambient authority. `runtime/src/stdlib/bytes.ts` and
`encoding.ts` implement the encoding subset; the runtime data boundary rejects bytes and
encoder/decoder objects even when nested. Programs must encode bytes to strings before invoking
tools or returning them. `subarray` may share owned storage, while `slice` copies.

## Tool execution and limits

The catalog contains seven core `tools.pi` leaves, conditional Windows PowerShell, the fixed
`tools.session.backgroundTask` and `tools.mcp.request` adapters, and runtime-owned search. Inputs pass Effect Schema before
dispatch. Read offsets and limits are positive safe integers, as are grep, find, and ls limits.
Grep context is a non-negative safe integer. Bash and PowerShell timeouts are positive finite
numbers and may be fractional. Invalid numeric input fails before a fresh Pi definition runs.

Fresh Pi definitions execute directly, so nested calls bypass Pi `tool_call` and `tool_result`
middleware, approvals, previews, registered overrides, and session-specific operations.
Background Tasks calls query one stable-session, token-checked Promise capability on each
invocation. They never dispatch the registered top-level definition. The execution Effect captures
one Clock-based deadline before starting the interpreter. After queue admission and provider
discovery, the Background Tasks adapter caps `wait` and explicit log long polls to the remaining
time minus a one-second settlement reserve, clamped at zero. Shorter requested waits and the
provider's configured maximum still apply; omitted log waits stay nonblocking. This is a
best-effort delivery margin, not a replacement for outer timeout or cancellation, and it never
changes the background process lifetime or the versioned provider protocol.

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
execution state. `tools/compact-evidence.ts` owns versioned, schema-validated per-call receipts
and an execution-wide attention ledger independent of both row caps. Lifecycle start binds the
current Effect fiber ID to its invocation ID. Adapters capture that invocation ID before host
dispatch; terminal hooks remove the binding, and outer settlement revokes all observation. No FIFO, name or
argument-equality correlation is used. Conflicts and missing evidence become explicit incompleteness.
Builtin results are projected before guest conversion discards details. Native writes always pass
unknown before-state and do no extra filesystem I/O. MCP validated replies and typed failures use
producer projections; Background Tasks v1 presentation callbacks preserve pre-projection log
truncation. Operation outcome is captured before cumulative-output admission. Delivery refusal
adds separate recovery evidence without rewriting known completion. A received, budget-admitted
native exception is not delivery loss. Guest conversion refusal, diagnostic clipping, output
admission refusal, defects, and interruption still preserve loss evidence. Adapter-returned output
remains provisional until the interpreter's terminal hook, which also covers later schema/data
copy rejection without changing the interpreter. Delivery recovery is retained on each affected
receipt and in aggregate attention; hidden calls and notice overflow retain conservative recovery.

The builtin producer supplies bounded `failureEvidence`, not arbitrary failure bodies. Known
complete errors such as native edit matching refusals do not imply incomplete presentation.
`tools/failure-evidence.ts` projects only recognized native outer diagnostics into bounded
semantic provenance. `ui/failure-presentation.ts` checks that saved provenance against the current
error text before folding ordinary source/stack details. It never identifies a culprit by call
order or counts. A matching visible child explanation can replace a redundant root explanation;
full outer text remains available expanded. Unrecognized errors and historical metadata retain
conservative recovery. Failed counts live in header metadata, with separate summaries for hidden
failures. Hidden failure counts use selected rows' original lifecycle identities, not semantic
display colors; an uncertain MCP row can still represent a received lifecycle failure.

Routine complete-line read hints retain their `expandedOnly` marker in per-call receipts and
replay. They stay outside the aggregate attention ledger and its warning budget. Both detailed
rendering paths show them only on expansion. The compact parent also retains these hints for
owned outer-failure rendering, which bypasses the detailed renderer. Their retention ends at
row eviction; warning and error notices remain attention even if incorrectly flagged.
MCP owns full outcome and recovery interpretation through `projectMcpPresentation` and
`projectMcpFailurePresentation`. Code Mode consumes that evidence, including retained origins,
validation, cleanup, discovery relevance, and retained-output access, rather than parsing MCP data.

Only bounded sanitized presentation fields survive. Failure bodies, nested output, diffs and raw
arguments do not. Exact admission, observation and attention counts survive row eviction. Snapshots
are detached and frozen, including failure retention; settlement revokes late callbacks. The older
`tools/mcp-evidence.ts` only decodes and renders historical MCP-specific ledgers. New executions
publish one generic attention ledger. Historical dual-ledger records still validate both because
older per-call receipts did not contain complete MCP recovery. Overflow or malformed evidence
never silently becomes success; fallback retains salvaged notices and explicit incompleteness.

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
