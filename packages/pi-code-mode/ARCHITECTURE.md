# Architecture

`pi-code-mode` owns one Effect-managed Pi extension. It provides trusted-project configuration,
the session lifecycle, `/code-mode settings` (through core's `registerExtensionCommand` and Cosmic UI's settings shell), and one `code_mode` tool. A `{code,intent?}` call runs one
JavaScript program in a fresh Node.js process over seven core Pi built-ins under `tools.pi`: `read`, `bash`, `edit`,
`write`, `grep`, `find`, and `ls`. The tool registers only on macOS and Linux. The reviewed
`tools.session.backgroundTask` leaf reaches the current `pi-background-task` runtime through its
versioned session protocol. The fixed `tools.mcp.request` leaf queries `pi-mcp` through its own
versioned session protocol. `src/engine/` supplies `tools.$codemode.search`. A mutually
exclusive `{action:"status"}` call projects the current five execution limits without starting a
program or touching nested capabilities.

## Output retention and receipts

The same tool accepts `{action:"result.read",id,offset?,limit?}`. This branch checks session
availability and reads a retained text artifact without starting a program or building guest tools.
It rejects `code`, invalid offsets, split surrogate offsets and invalid limits. Paging uses UTF-16
offsets, preserves code points and checks the complete JSON envelope against `maxOutputBytes`.
A page that cannot fit metadata and one code point has no continuation cursor. Reads recheck
caller cancellation and publication authority after the session Promise settles. Reading output does not change its
original `succeeded`, `failed` or `cancelled` outcome. `results/read-presentation.ts` defines
producer-owned page metadata and fixed read-failure reasons. Projection returns that metadata
beside the unchanged model-visible text; publication revocation replaces both together.
`ui/result-read-summary.ts` validates saved metadata before showing page ranges and original
execution warnings. Page counters take priority over opaque retained IDs at narrow widths; routine
paging and read-recovery explanations are expanded-only detail. `ui/result-read-renderer.ts` owns the
read-specific status and raw page view, including unknown historical reads, and the plain
status/raw view that `ui/status.ts` reuses with its own status line.
It omits execution-only Program/Calls sections and renders issues with the shared issue lines.
Compact expansion supplies only page content; the common shell owns the heading and issues. Read views never parse guest page text or treat a successful read as execution success.

`src/results/service.ts` owns a scoped Effect Ref of settled artifacts. Limits are fixed at
8 MiB UTF-8 per artifact, 64 MiB conservatively charged session storage, and 32 entries. Charges
include UTF-16 text, UTF-8 projection and fixed metadata overhead. `prepare` validates and prices
an artifact without changing the store. Its single-use `commit` is the only transition that
assigns an ID, charges storage and evicts, so eviction follows publication order. Commit checks
its latch and the open store inside one `Ref.modify`; `put` is prepare plus commit. Eviction
removes the oldest published entries; reads do not refresh order. There is no persistence. Runtime replacement, successful
`session_tree`, and shutdown close the old store. Disabling also revokes the activation's execution
and result-access owner until reload. Late callbacks cannot advertise old artifacts.

`results/serialize.ts` captures only bounded text from execution's optional pre-bound `onResult`
hook, with at most 100,000 visits and depth 32. It uses own data descriptors, never guest getters
or `toJSON`, and retains no guest graph. Small successful responses without host loss or unknown
nested outcomes remain unchanged. A successful response that needs saved paging publishes valid JSON with the original `id`, `outcome`, `kind`,
`offset`, `next`, `total`, and `text`. A numeric `next` adds an exact `result.read` recovery object
whose offset starts after that page. All-present, non-error, completed and delivered allowlisted
read receipts may compact to `{total,completed}`; risky and failed operations retain full bounded
`ExecutionReceipts`. Details use `initialPreview` only for a valid page and mark `receiptMode` as
`none`, `read-only`, or `full`, never as `resultRead`. Tiny budgets, absent capture, and store refusal
use bounded prose without a fake cursor. Successful retained artifacts contain output only, never
execution receipts. Failure artifacts are marked `failure-receipt` and contain receipt text plus
the normalized diagnostic when captured.
Missing capture hooks, capture limits, interruption and store refusal are explicit unavailable
states, not claims that truncated output can be recovered.

`tools/execution-receipts.ts` keeps bounded operation facts, not UI outcome colors. It reuses the
existing fiber/invocation correlation and redacted target projection. Native dispatch is unknown
until settlement; MCP preserves producer certainty. Guest output delivery is separate. Counts
cover every admitted call while at most 256 receipt rows survive; active dispatch rows are not
evicted. Receipts contain IDs, names, bounded redacted targets, certainty, delivery and validated
provider recovery IDs, never argument objects, write bodies or raw errors. Settlement freezes
receipts and rejects late observations. Completed writes survive later throws, timeouts and output
refusal. An execution-local sticky host-loss flag survives row eviction and does not depend on UI
projection. Builtin, Background Tasks, MCP, catalog, and delivery failures record
loss before settlement closes the collector. Fully delivered native errors do not set this flag.
Background capability completion does not mean its process exited.

`tools/result-response.ts` separates retention from mandatory model-visible safety evidence.
Host loss or unknown nested outcomes publish operation totals and no-replay guidance even when the
guest catches an error and returns a short success. This does not create an artifact merely to retain
that short result. If safety framing displaces otherwise-fitting guest output, it requests the usual
bounded output retention instead. Saved guest output never claims to recover discarded child data. These paths
use prose rather than allowing a successful JSON page to replace the warning.
`tools/recovery-response.ts` reserves bytes for both the root diagnostic and safety/recovery block
before optional receipt rows. Risky rows take priority; omitted text or rows are explicit. Exact
aggregate counts do not depend on displayed rows. The final code-point-safe clamp remains
mandatory, including at tiny or zero budgets. Artifact contents and ordinary page contracts stay
unchanged.
Retention preparation runs in the session after the execution fiber settles; a response already
cancelled or revoked prepares nothing. The Promise continuation rechecks cancellation, session
currency and availability, suppressing revoked output, recovery IDs and failure-detail handoffs.
Only after that check, in the same synchronous turn, does `boundary/host-result-commit.ts` commit
the prepared artifact. Cancellation that wins while preparation settles drops an artifact that was
never stored, so earlier saved results and concurrent publications are untouched without rollback.
Settled execution outcomes and nested receipts remain separate from delivery cancellation. It
never replays an operation or rolls back a mutation.
`tools/execution-progress.ts` owns the unchanged progress/count transitions; display and operation
evidence remain separate.

## Grouped ownership

- `src/extension.ts`, `application.ts`, and `layer.ts` own Pi registration, session replacement,
  the private runtime slot input, the synchronous state projection, and Layer composition.
- `src/config/` owns field schemas, defaults, bounds, tolerant scope resolution, provenance, and
  the only persistence door, `CodeModeConfigStore`.
- `src/settings/` owns command dispatch, completions, list behavior, custom integer flow, and
  notifications. `src/boundary/host-ui.ts` is the Promise and callback adapter for Pi dialogs.
- `src/tools/` owns the reviewed guest catalog, execution admission, live status projection, UTF-8
  limits, progress state, result formatting, failure-detail retention, tool registration, and
  active-list reconciliation. `status.ts` copies five limits from a live state snapshot and chooses
  either complete compact JSON or a byte-bounded plain-text refusal.
  Its Background Tasks and MCP leaves import producer-owned v1 input/output codecs instead of
  declaring second protocol shapes. MCP catalog decoding retains those constraints but replaces
  raw parser diagnostics with producer-owned, action-specific not-sent repair guidance.
  Neither adapter invokes a registered tool definition.
- `src/ui/` is pure presentation. `tool-render-details.ts` normalizes details, ignores malformed
  rows, and decodes only the current v3 ledger; a malformed call receipt marks it incomplete.
  Older ledgers are not decoded, so replayed history falls back to the shell's generic row.
  `detail-counts.ts` reconciles exact counts with visible rows, or falls back to the visible rows
  alone. `compact-summary.ts` opts only the outer tool into the shared compact shell. It requires
  consistent current details and, for success, explicit execution evidence. `call-rows.ts`
  projects each retained call into a child row with its receipt's issues; calls still queued or
  running when the run ends say so on their own row, and delivery failure overrides a successful
  operation status. `program-issues.ts` owns the run's own issues and outcome: cancellation, the
  program failure, saved-output continuation (info), output truncation, and unrecorded call
  details. `tools/diagnostic-messages.ts` writes one human line per diagnostic kind from the
  engine's structured facts, never its wording (`No tool named pi.x`, `Timed out after 100 ms
  (line 1)`). Failed results keep `tools/failure-evidence.ts` evidence in their details: the kind,
  line, bounded redacted facts, and a span to the message's first line in the result text, which
  may hold tool output and is therefore never copied into details. Results without that evidence
  show their tidied first line. A call refused
  before its tool ran (unknown tool, invalid input, over the call limit, expired deadline) gets a
  `not-sent:<kind>` receipt from the diagnostic on its terminal lifecycle event (`Not sent:
unexpected field "file"`), even when the program catches it; past the limit only the first
  refused call is listed. An unhandled failure is explained on that call's own row (`Exited with
code 1; stopped the program`) when it is the only matching row and the collapsed tree shows it;
  otherwise the run names the call or just the tool. Expanded views split the returned text at the
  `notesOffset` detail into the program's output or diagnostic and the recovery text appended for
  the agent, shown as "Agent notes". Failed or warning calls the program handled make
  the run a warning; only unsettled calls make it uncertain. Counters show `done/total calls`
  while running and `total calls · N failed` after settlement; the parent opts into measured
  timing beside that count. Child timing uses standalone visibility and formatting rules without
  a nested-only override. `boundary/host-child-timing.ts` records process-local clock tokens at
  decoded call start and projects live elapsed time on the shared shell's existing refresh
  cadence, without per-child timers. Execution revokes tokens on child settlement and every outer
  exit; serialization cannot recreate timing authority. Settled rows retain the dispatcher's measured
  admission-to-settlement duration, including queue wait. No child durations are inferred or summed.
  `tools/compact-subject.ts` owns the built-in `pi.*` nested tool names that rows and ledgers
  classify. It captures allowlisted paths, read ranges, commands and search targets at decoded
  call start using Code Previews' shared argument-only formatter. It redacts fields before
  clipping, caps subjects at 1024 code points and contains formatting failures. Input objects,
  write/edit bodies, MCP argument payloads and returned output never enter these subjects.
  Producer-owned argument-only projections supply MCP and Background Tasks headings.
  `expanded-result.ts` renders the fixed expanded order: the run's issues, Program, Calls (each
  call's issues and details beneath it), then Output, Result, or Error. Calls remain visible when
  the program fails. The controller builds the original and content-only callbacks from one
  result-slot factory: in compact style the shared shell supplies the heading and the run's
  issues, the content call slot the Program section, and the content result slot Calls and
  output. In preview style `tool-renderer.ts` keeps a header-only call slot once execution starts
  (before that, an expanded call shows its program); its result slot shows the run's issues and
  the full retained call tree collapsed, and the complete expanded order when expanded. Problems
  on calls that are no longer retained are summarised as one run-level warning. `program-source.ts` formats source without rewriting tokens; `result-output.ts`
  pretty prints only complete successful structured output. `status.ts` independently
  schema-validates producer status details, never parses model-visible output, and reuses the
  plain status/output view. On renderer failure the result falls back to plain text rather than
  Pi's unframed JSON. Final host clamping publishes the truncation flag without changing
  model-visible content. The shared shell owns compact animation and expansion; nested dispatch
  remains direct. MCP and Background Tasks outcomes and issues come from their producers'
  versioned, schema-validated evidence, never guest return values or Promise fulfillment.
- `src/engine/` owns execution: tool definitions and schema rendering, the budgeted catalog and
  search, Pi-side dispatch, the process protocol, failure diagnostics and output bounding. See
  "Program execution" below.
- `src/boundary/` contains the program process adapter and its plain-ESM child runner and watchdog,
  fresh Pi built-in adapters, explicit Background Tasks and MCP protocol clients, the guarded progress
  publisher, the synchronous retained-output commit runner, the hostile renderer-ticker adapter,
  Pi dialog adapters, and the process-memory deactivation handoff. Foreign Promise
  adapters use function-form `Effect.tryPromise`; they format `Cause.UnknownError.cause` through
  the hostile-safe rejection formatter before returning a model-visible tool failure.
- `tests/` covers configuration, atomic commits, lifecycle races, dialogs, adapters, limits,
  real program processes, progress, retention, and fail-soft rendering. Execution suites share
  `tests/support/execute.ts` over the real `makeCodeModeToolExecute`, provider discovery goes
  through `tests/support/providers.ts`, and presentation suites render the registered definition
  through `pi-code-previews/testing`, never `pi-code-previews/src`; the shared shell view in
  `tests/support/presentation.ts` serves the shell conformance suites. Host casts, deferred
  promises and the plain theme come from `pi-cosmic-core/testing`; `tests/support/host.ts` keeps
  only the Code Mode state fixture, and behavior-specific fixtures stay in each suite.
  `tests/engine/` exercises the engine against real processes.

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

Each activation also owns `boundary/host-execution-owner.ts`, a native cancellation bridge into
the existing session runner. Effective unavailability and deactivation synchronously revoke it,
interrupting the program process and its nested calls without disposing the settings runtime.
Re-enabling settings cannot restore that owner; reload creates a new one. Per-run caller and
activation listeners are released on settlement. A pre-run Effect gate and lazy dispatch gates
refuse revoked work even before the pinned runner installs its abort listener. Cancellation cannot
undo dispatched mutations or stop a foreign Promise that ignores its signal; late settlement has
no guest continuation or publication authority.

`tools/execution.ts` owns mutually exclusive execution, status, and retained-read admission plus
retained-read publication. Status passes current-session, availability, and cancellation gates,
then rereads `stateRef` synchronously. It performs no config I/O, session-runner work, retained
artifact access, program execution, or budget admission. `execution-run.ts` assembles one program
run, its guest adapters, progress and settlement. `result-response.ts`
continues to own retention and receipts; these modules add no runtime or lifecycle authority.

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

`host-ui.ts` adapts select, input, and custom dialogs. The custom adapter opens Cosmic UI's shared
`inline` surface, which owns the exact-once latches and a guarded `done`; the adapter owns the
callback `AbortController`, aborted as closing begins. Closing calls an available `done(Closed)`
once, a normal PromptInteger remains authoritative, a stale factory receives an inert component,
and a failed opening maps to `Failed`. Preset writes use the list signal, ignore stale callbacks,
and restore the persisted row after an active failure.

## Program execution

`engine/execute.ts` runs each program in a fresh Node.js process started by
`boundary/host-program-process.ts` through core's duplex process in side-channel mode: stdin is
closed, stdout and stderr are retained together as the program's logs (256 KiB), fd 3 carries the
control protocol, and fd 4 is a lifetime lease. The process gets the activation's captured cwd, a
minimal environment (paths, locale, proxies and certificates, never `NODE_OPTIONS` or Pi's own
variables), a 1 GiB V8 heap and its own process group. It runs under Node's permission model: only
the runner's two files are readable and workers are allowed; file reads and writes, project
imports, child processes, addons, WASI and, on Node 25+, the network are refused, so that work
goes through recorded `tools.pi.*` calls. Node 22 and 24 cannot refuse the network, so the runner
replaces `fetch`, `WebSocket` and `EventSource` with refusals on every version. The allowlist uses the modules' real paths, because Node resolves the
entry's real path under the same permissions. `engine/failure.ts` turns Node's
`ERR_ACCESS_DENIED` into guidance naming the refused file or package, from the error's
`permission` and `resource`, and the tool to use instead. macOS and Linux only; other platforms
are refused before anything starts.

`boundary/code-mode-child.mjs` is plain ESM because Node does not strip types from packages under
`node_modules`. It compiles the program as an async function body with `vm.Script` in the main
context, so native semantics apply, and dynamic `import()` loads Node built-ins through the main
loader. A JavaScript syntax error retries once through Node's TypeScript type
stripping. `code-mode-watchdog.mjs` runs in a worker thread and SIGKILLs the process group when the
lease reaches EOF, even while the program is stuck in a loop; the program starts only after it is
ready. It reads the lease as a socket, because a thread-pool read would block the process's own
exit. While the program runs, the fd 3 channel holds the process open only while tool calls are
pending; every other runner handle is unreferenced. A program awaiting something nothing can
settle therefore empties Node's event loop, and `beforeExit` reports a stall at once instead of
the program waiting out its deadline. Timers, sockets and file operations keep it alive as usual.

`engine/protocol.ts` owns the frames: a 4-byte length and UTF-8 JSON, capped at 17 MiB from the
child before any body is buffered, and Effect Schema decoding of every child message. The child
sends `call` and one `result`; Pi sends `start`, `reply` and `finish`. `engine/dispatch.ts`
admits each call on its own fiber: resolve, decode input, reserve the call limit, wait for one of
eight permits, run, decode output, then deliver the reply before the terminal lifecycle event. A
reply that cannot be encoded or written is a delivery failure; the operation's own outcome is
unchanged. Pi holds at most 64 MiB of queued and running inputs.

When the program returns or throws, the child refuses new calls, waits for every started call's
reply, serializes the result, lets Node report unhandled rejections, flushes its output and sends
`result`. Pi never cancels started calls for that; `Promise.race` losers and `Promise.all`
siblings finish. After `result`, Pi sends `finish`, gives the process 250 ms to exit and close its
output, then sweeps the group. Only the deadline and interruption stop work early: the scope
interrupts in-flight calls and kills the process group. Unconfirmed cleanup adds a log line.

`engine/failure.ts` turns what the child reports into diagnostics. A tool failure that escaped
keeps the diagnostic Pi recorded for that request plus the call site's line; a `tools.x is not a
function` TypeError becomes `UnknownTool` with suggestions; other throws carry their name, message
and line. A failed result includes the output of calls that completed (at most 8 MiB kept), which
`tools/format.ts` renders after the logs. `engine/output.ts` bounds the value or diagnostic, logs,
and completed calls to `maxOutputBytes` in that priority.

## Discovery

`engine/instructions.ts` renders the catalog from the guest tool tree: every namespace with its
tool count, and full signatures inlined round-robin against the registration's `catalogBudget`.
`tools.$codemode.search` indexes every tool. Pi registers complete `code_mode` parameters and
instructions at session activation. The description generates package numeric defaults from
`DEFAULT_CODE_MODE_CONFIG`; the optional configuration snapshot is labeled as registration-time
data rather than live state. Live status is authoritative only for its invocation and omits the
registration-only catalog budget. The guest catalog is fixed: it does not import arbitrary
registered tools or treat MCP discovery as permission to add guest leaves. `engine/tool-schema.ts`
renders signatures and owns input/output decoding; guest inputs that the plain schema rejects get a
second chance through its JSON codec.

## Tool execution and limits

The catalog contains seven core `tools.pi` leaves, the fixed
`tools.session.backgroundTask` and `tools.mcp.request` adapters, and engine-owned search. Inputs pass Effect Schema before
dispatch. Built-in, read and Background Tasks guest inputs are closed: an unknown key at any depth
is a catchable input failure before native dispatch or provider discovery, never stripped. MCP
keeps its own closed request union. Read offsets and limits are positive safe integers, as are grep, find, and ls limits.
Native read returns at most 2,000 lines or 51,200 bytes. Its optional structured form reports
`complete`, `partial`, or conservative `unknown` completeness with bounded reason, truncation, and
continuation metadata. `requireComplete` rejects every explicit limit and offsets above 1; it does
not auto-page or perform extra I/O. Decoded text is not raw-byte or atomic-read evidence, and outer
saved paging cannot recover child data the read omitted. Grep context is a non-negative safe
integer. Bash timeouts are positive finite numbers and may be fractional. Invalid
numeric input fails before a fresh Pi definition runs.

Fresh Pi definitions execute directly, so nested calls bypass Pi `tool_call` and `tool_result`
middleware, approvals, previews, registered overrides, and session-specific operations.
Background Tasks calls query one stable-session, token-checked Promise capability on each
invocation. They never dispatch the registered top-level definition. The execution Effect captures
one Clock-based deadline before starting the program process. After queue admission and provider
discovery, the Background Tasks adapter caps `wait` and explicit log long polls to the remaining
time minus a one-second settlement reserve, clamped at zero. Shorter requested waits and the
provider's configured maximum still apply; omitted log waits stay nonblocking. This is a
best-effort delivery margin, not a replacement for outer timeout or cancellation, and it never
changes the background process lifetime or the versioned provider protocol.

`boundary/host-mcp.ts` queries exactly one active stable-session provider per request through
`pi-mcp/code-mode`. That import loads codecs, not an extension. The provider owns
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
sandboxed. Nested MCP operations bypass Pi middleware and unrelated approvals,
just like the Background Tasks capability; only the outer Code Mode call uses that middleware.

There is no sandbox. Bash has full local-user process, environment, network, and filesystem
authority. The program itself must read and change files, run commands and make network requests through
tools; on Node 22 and 24 it can still reach the network through `node:http` or `node:net`
unrecorded. Read, edit, and write accept relative,
absolute, and home-relative paths. Mutations happen immediately and cancellation cannot roll them
back. Pi built-in results default to text; opt-in structured reads add only validated completeness
metadata. Images are refused and arbitrary built-in details never enter the guest. Background Tasks
returns a copied structured result with bounded text and metadata.

Each execution applies source, time, call-count, result, cumulative child-output, and discovery
budgets. Status spends none of them, so it remains available at zero call or child-output budgets;
its complete response still passes the final output-byte bound. Success formatting uses compact
JSON for non-string values and preserves returned
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
New details still write `totalToolCalls` when rows are hidden, but rendering reads only exact counts.
Selected rows and counts are copied before host publication, so a hostile `onUpdate` cannot alter
execution state. `tools/compact-evidence.ts` owns version 3 per-call receipts and a small
execution-wide ledger of error, warning, cancelled, and uncertain counts plus an `incomplete`
flag, independent of both row caps. Lifecycle start binds the current Effect fiber ID to its
invocation ID. Adapters capture that invocation ID before host dispatch; terminal hooks remove the
binding, and outer settlement revokes all observation. No FIFO, name or argument-equality
correlation is used. Conflicts, missing observations, summaries without an outcome, and issue
overflow mark the ledger incomplete. Builtin results are projected before guest conversion
discards arbitrary details. Native writes explicitly mark their before-state as not captured and
do no extra filesystem I/O; that is an `info` issue, not a claim about whether the path was new.
MCP validated replies and typed failures use producer projections; Background Tasks v2
presentation callbacks preserve pre-projection log truncation. Operation outcome is captured
before cumulative-output admission. Delivery refusal adds a "result did not reach the program"
issue and marks the receipt without rewriting known completion. A received, budget-admitted native
exception is not delivery loss. Unencodable output, a reply the exited program never read,
diagnostic clipping, output admission refusal, defects, and interruption still preserve loss
evidence. Adapter-returned output remains provisional until the dispatcher's terminal lifecycle
event, which follows output-schema decoding and delivery.

Receipts retain only bounded sanitized presentation fields: subject, action, counters, metadata,
outcome, and at most 16 issues (messages clipped to 240 and details to 1024 UTF-16 units after
redaction by `tools/issue-evidence.ts`). Nested output, diffs and raw arguments never survive.
Exact lifecycle and ledger counts survive row eviction. Snapshots are detached and frozen,
including failure retention; settlement revokes late callbacks. MCP owns full outcome and
recovery interpretation through `projectMcpPresentation` and `projectMcpFailurePresentation`;
Code Mode consumes that evidence rather than parsing MCP data. Retained reads keep their
`result.read` action and ID in argument-only headings.

The application composes `CodePreviewSchedulerService.layer` into its own session runtime and passes a token-checked scheduler to the compact shell. It does not depend on the previews extension's isolated module-local runtime; replacement and shutdown cancel remaining compact animations. The original renderer owns a weak 160 ms ticker. The host compact-summary callback releases that ticker when the shared shell hides its rows or the tool settles, even when the original result renderer is not called. Missing or hostile state, invalidation, keybindings, clock,
and ticker callbacks fall back without affecting execution. The controller captures sanitized
expand keys once when it builds the definition. Pure render code always returns a component, even
when hostile details force its emergency path.

Thrown executions retain copied final rows and counts in a bounded one-shot map. The `tool_result`
hook consumes another copy for the matching Code Mode call because Pi otherwise replaces details
with `{}`. Text and `isError` semantics are unchanged.

## Shipping and validation

The package runs from TypeScript source under Pi/Jiti; the child runner and watchdog are plain ESM
under `src/boundary/`. `THIRD_PARTY_NOTICES.md` carries the MIT notice for engine code derived from
OpenCode's Code Mode. Package gates include typecheck, Effect diagnostics, lint, format, tests, and
a dry pack. Workspace validation also checks layout, versions and source loading, and the packed
install runs a real program process.

Completed efficiency experiments are archived in Git, not maintained as package code.
[Historical results](https://github.com/mattleong/cosmic-pi/blob/main/docs/code-mode-efficiency.md)
record the findings and archive reference. Production regression tests retain structured-output,
final-clamp, cancellation, and lifecycle coverage.
