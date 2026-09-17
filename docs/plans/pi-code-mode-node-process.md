# Code Mode: native Node process implementation plan

Status: implementation-ready proposal. No runtime changes are part of this document.

Confirmed user decisions:

- Launch on macOS/Linux first; defer Windows.
- Give the Node child a minimal environment; parent-hosted tools retain their existing environment.
- After the program returns, close new-call admission and drain already-started tool calls within
  the original deadline rather than cancelling them.

## 1. Decision and scope

Replace the vendored JavaScript interpreter with one fresh Node process per `code_mode`
invocation. Keep tool execution and all Pi integration in the parent. Use native JavaScript
semantics, not a VM sandbox or a second interpreter.

The user selected **macOS and Linux first**. The replacement must explicitly refuse execution
on Windows before spawning or dispatching anything. Windows support is deferred, not silently
implemented with weaker cleanup claims. Do not keep the old interpreter as a Windows fallback.

Goals:

- Delete ownership of JavaScript parsing, language evaluation, standard-library methods,
  Promise scheduling, and interpreter confinement.
- Keep guest CPU loops and synchronous native operations off Pi's event loop.
- Preserve tool adapters, validation, budgets, progress, operation evidence, and session ownership.
- Run directly from shipped source, including in an installed tarball. No generated `dist/`,
  runtime build, private registry package, or global loader dependency.

Non-goals:

- OS sandboxing, filesystem/network permissions, or protection against deliberately hostile
  local-user code. Native Node has shell-level authority and can bypass the adapter APIs.
- Persistent execution contexts, process pooling, resumable programs, automatic retries,
  TypeScript guest syntax, or support for static imports inside an async function body.
- Reproducing interpreter quirks, especially automatic cancellation of Promise race losers.
- Guaranteed removal of deliberately detached processes. Owned POSIX process-group cleanup
  does not establish that no process escaped that group.

## 2. Architecture and ownership

```text
Pi session Effect runtime
  CodeModeExecution service
    captured cwd/config/deadline and execution admission
    catalog + schema-validated adapter dispatch, concurrency eight
    lifecycle IDs, progress, evidence and output admission
    scoped process owner, control reader/writer, stdout/stderr readers
                         |
                  bounded byte protocol
                         |
Fresh Node process, separate POSIX process group
  native ESM entry module from stdin
  fixed package launcher -> typed child service
  native async guest function + tools.* stubs
  response correlation, native Promise error observation, completion barrier
  independent parent-lease watchdog worker
```

Parent ownership:

- `src/tools/execution.ts` keeps Pi admission, progress, final formatting, details retention,
  and stale-publication checks. Delegate process execution to a feature service.
- `src/execution/service.ts` owns each invocation's process, transport, dispatch fibers,
  request state, deadline, and finalization. Compose its Layer in `src/layer.ts`.
- Existing `host-builtin-tools.ts`, `host-background-task.ts`, and `host-mcp.ts` remain in Pi.
  Do not instantiate Pi definitions or producer runtimes in the child.
- `pi-cosmic-core` owns reusable process, byte-channel, and cleanup mechanisms. Code Mode owns
  the application protocol, catalog, completion rules, and diagnostics.
- All asynchronous resources belong to scopes. Keep Effect runners at the Pi boundary and the
  standalone child entry boundary; never create a detached runtime per RPC request.

Child ownership:

- The guest runs as an ordinary native async function. The child never imports the Pi extension
  entrypoint or receives an ExtensionContext, event bus, Effect closure, or tool definition.
- Tool stubs produce ordinary native Promises. No Promise subclass, patched Promise methods,
  custom reaction queue, AST instrumentation, or async-hooks-based language emulator.
- The child may describe its own error or acknowledge receipt, but cannot supply authoritative
  operation outcomes, UI receipts, timing authority, or host invocation IDs.

## 3. Native execution contract

### Source and modules

Launch the selected Node executable with `--input-type=module` and a generated stdin entry:

```js
import { run } from "file:///absolute/installed/package/launcher.mjs";
await run(
  async function (tools) {
    // Original guest source, unchanged, between separate wrapper lines.
  } /* bounded bootstrap metadata */,
);
```

- Use `process.execPath` only after verifying that the host is supported Node. Do not silently
  substitute Bun or an arbitrary `node` from PATH.
- Preserve the package engine range: `^22.22.2 || ^24.15.0 || >=26.0.0`.
- Capture `ctx.cwd` once. Spawn with that cwd. Node's stdin ESM entry gives relative and bare
  dynamic imports the project as their resolution origin, rather than the extension directory.
- Native `await import(...)`, built-ins, installed project packages, `import.meta`, classes,
  generators, timers, fetch, and Node APIs work without an allowlist.
- Static `import`/`export` are invalid in the function-body API. `require` is not injected as an
  ESM global; users may use Node's `createRequire` normally. Do not add a custom module resolver.
- JavaScript only. Remove transpilation rather than secretly retaining a TypeScript compiler.
  An explicit `return` selects the result; unlike the interpreter, the last expression is not
  an implicit result. An ordinary fallthrough returns `undefined`, normalized to `null`.
- Before guest execution, remove only the bootstrap `--input-type=module` entry from the child's
  `process.execArgv`. Otherwise ordinary file-based Workers and `child_process.fork` inherit an
  invalid flag. Fixed helper Workers also use an explicit empty `execArgv`; do not inherit Pi
  loader flags. Test native Worker and fork use from the guest.
- No guest source, arguments, or credentials on the command line. Stdin is bootstrap source,
  not the RPC stream, and closes after the bounded bootstrap write.
- Node parses before the runner starts. A syntax error can therefore be a pre-ready exit.
  Report its bounded native diagnostic; do not require a structured child error for that case.
- Record the wrapper line offset and virtual source identity. Correct user locations only for
  verified matching frames; otherwise retain bounded native stack text without guessing.

A local Node 24.15.0 probe confirmed that this stdin-module form resolves a relative import
from the chosen project cwd without experimental loader hooks. Node 22 and Linux remain
acceptance-test requirements, not claims established by that probe.

### Authority and environment

Use an explicit minimal environment, not `...process.env`:

- Preserve PATH, HOME, USER, LOGNAME, SHELL, TMPDIR/TMP/TEMP, TZ, LANG/LANGUAGE/LC\_\*, and XDG
  directory variables when present.
- Preserve named proxy and CA configuration variables needed by ordinary networking:
  HTTP_PROXY/HTTPS_PROXY/ALL_PROXY/NO_PROXY and lowercase equivalents, NODE_EXTRA_CA_CERTS,
  NODE_USE_ENV_PROXY, SSL_CERT_FILE, and SSL_CERT_DIR.
- Do not inherit NODE_OPTIONS, NODE_PATH, inspector/preload flags, Pi session internals, or
  arbitrary provider credential variables. The parent-hosted adapters retain their environment.
- This reduces accidental inheritance. It does not protect secrets from code that can read
  local files or call unrestricted Bash. Document that distinction.

Direct filesystem, network, or subprocess operations do not appear as tool rows and are not
limited by `maxToolCalls` or the cumulative adapter-output budget. Recommend `tools.*` for
observable, budgeted orchestration without pretending to enforce that preference.

### Tool and Promise behavior

- Preserve `tools.pi.*`, `tools.session.backgroundTask`, `tools.mcp.request`, and
  `tools.$codemode.search`, including discoverability and the catalog budget.
- Tool calls start eagerly when their serialized requests are admitted. Re-awaiting one
  Promise never dispatches it again. Parent dispatch concurrency remains **eight**.
- Native `Promise.race` never cancels losers. Native `Promise.all` rejection never cancels
  siblings. Do not add implicit per-call cancellation or a cancellation API in this migration.
- Whole-execution cancellation still aborts all execution-owned parent adapter fibers.
- `tools.session.backgroundTask` start creates session-owned work. Terminating the evaluator
  must not silently stop an independently admitted background task.

### Completion and unawaited work

Use an explicit boundary rather than trying to infer whether user code awaited a Promise:

1. Execute the guest function and await its returned value with native Promise assimilation.
2. When the body settles, synchronously close child admission for new adapter calls and send
   `seal`. The parent closes admission when it reads that ordered message.
3. Drain every adapter request already admitted, including ignored requests and race losers,
   within the original deadline. Body failure does not silently cancel these requests.
4. Normalize/serialize the selected value once after drainage. This can run guest getters or
   `toJSON`, so it must happen before the rejection checkpoint.
5. Allow a native event-loop checkpoint to observe unhandled rejections, including ones created
   by serialization. Freeze the selected outcome afterward. Build the final candidate from
   already-normalized plain data and captured bounded diagnostic primitives; never rerun guest
   serialization/getters after this checkpoint.
6. Send one final candidate and wait for parent acceptance. No success is published before
   process cleanup. Detached work that runs after this freeze cannot revise the candidate.

A tool call attempted after sealing returns a rejected `ExecutionClosed` Promise and sends no
request. Detached async continuations that need more tools must be awaited by the body. Timers,
servers, direct native I/O, and arbitrary open handles do not extend successful execution.
Long-lived work belongs in Background Tasks. Document this intentional change from the old
interpreter's continuation-draining behavior.

Track internal RPC settlement separately from the Promise returned to guest code. Internal
drainage must not attach a rejection handler to the public Promise and accidentally hide an
unhandled failure. Use native `unhandledRejection` and `rejectionHandled` observation until the
post-serialization completion checkpoint. Caught failures preserve a successful body result and failed-call
receipts; genuinely unhandled failures fail the invocation. Bound retained rejection records.
Do not implement another rejection scheduler.

An uncaught exception fails the invocation. Timeout, cancellation, protocol failure, or child
loss interrupt remaining dispatches rather than waiting indefinitely. `process.exit(0)` without
the completion protocol is not a successful return. No failure authorizes automatic replay.

## 4. Data and diagnostic contracts

Use native JSON projection at RPC and final-result boundaries:

- Tool inputs serialize in the child before host dispatch. Getters and `toJSON` run in the child,
  never on Pi's thread. Parent schema decoding remains authoritative.
- Final top-level strings remain text. Other values use native compact JSON projection.
  Top-level `undefined` becomes `null`.
- Dates/URLs follow native `toJSON`; Maps/Sets become `{}` unless explicitly converted.
  Non-finite numbers become `null`; unsupported object properties are omitted and unsupported
  array entries become `null` under native JSON rules.
- Cycles and BigInt fail serialization with a bounded diagnostic. No implicit custom encoding.
- Preserve UTF-8 accounting: built-in text is charged as text, structured companion output as
  compact JSON, and catchable failures consume the same cumulative budget as successes.
- Oversized final output becomes a bounded text preview with truncation evidence, as today.
  The parent repeats final model-visible clamping, including the zero-byte case.
- Bound wire structure depth to 64 and check it before recursive schema processing. This is an
  RPC data limit, not a restriction on values used inside the Node program.

Keep an owned result/diagnostic type consumed by `format.ts`. Distinguish source/startup failure,
body failure, result serialization, timeout, cancellation, early exit, protocol failure, and
unconfirmed cleanup. Include bounded native stderr for pre-ready failures.

Preserve owned tool-failure attribution without trusting a guest-written stack or string:
associate proxy-created Error objects with their request sequence privately in the child;
the parent checks the matching recorded failure before assigning `ToolFailure` provenance.
Unrecognized or reconstructed errors remain ordinary program failures. Update both
`failure-evidence.ts` and its producer if the current envelope changes.

## 5. Protocol v1

### Byte framing

Use the inherited POSIX fd 3 as a full-duplex control socket. Guest stdout/stderr are separate
pipes. No Node object IPC, JSONL on stdout, HTTP server, TCP listener, or reconnect logic.

One frame is a one-byte message tag, four-byte unsigned big-endian payload length, then UTF-8
JSON. The tag selects the applicable length ceiling before allocation. The JSON payload includes
`version: 1` and the execution ID. Reject unknown tags, wrong versions/IDs, invalid UTF-8,
malformed JSON, excessive nesting, and truncated frames at EOF.

The decoder uses a fixed header buffer, checks length before allocating payload storage, and
consumes transport chunks incrementally. The writer serializes frames through one bounded queue
and writes large frames in at most 64 KiB slices, awaiting backpressure. Never construct an
unbounded array of frames. Native stream chunking is not an application chunk/reassembly protocol.

### Message schemas

Define Effect Schemas once in `src/execution/protocol.ts`; both processes load those definitions.
Payload fields below are in addition to `version` and `executionId`.

| Tag/message | Direction      | Payload and rule                                                                                                              |
| ----------- | -------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `ready`     | child → parent | Node version, control readiness, and confirmed watchdog lease observation. No guest body execution yet.                       |
| `start`     | parent → child | Tool namespace descriptors and bounded execution limits. One per execution.                                                   |
| `call`      | child → parent | `requestSeq`, exact catalog `tool`, JSON `input`. Sequence assigned after successful input serialization.                     |
| `reply`     | parent → child | `requestSeq`, tagged JSON success or bounded typed error. Exactly one per accepted call.                                      |
| `replyAck`  | child → parent | `requestSeq`. Sent after decoding the complete reply and settling the corresponding native Promise.                           |
| `seal`      | child → parent | Body outcome marker. Closes new-call admission; existing requests continue.                                                   |
| `result`    | child → parent | Owned success/failure candidate, normalized JSON value or diagnostic, truncation flag. Exactly one after drainage/checkpoint. |
| `finishAck` | parent → child | Candidate accepted for shutdown. Not a claim that process cleanup is complete.                                                |
| `shutdown`  | parent → child | Complete/cancel/timeout/protocol reason. Cooperative notification only; termination never relies on guest cooperation.        |

Child request sequences correlate replies, not authority. Parent admission allocates the actual
invocation ID and keeps the sequence-to-invocation map. Require unique increasing wire sequences;
local serialization failures consume no sequence and dispatch nothing. Reject duplicate, stale,
unknown, or illegal-state messages without replaying work.

The child receives namespace descriptors, not host schemas, callbacks, capabilities, or operation
receipts. The parent resolves exact tool names through an owned registry, not arbitrary property
traversal. Namespace objects are enumerable so existing `Object.keys(tools)` patterns work.

### Request state and delivery evidence

```text
received -> admitted/queued -> running -> operation-settled
         -> response-prepared -> sending -> delivery-acknowledged
```

Validation refusal, cancellation, and transport loss are terminal branches. Count an admitted
attempt even if input validation later fails; never dispatch beyond `maxToolCalls`. Discovery
is an ordinary admitted call and consumes the same budget. Unknown names and invalid requests
must not create an unlimited free response loop.

- Run input decoding, adapter dispatch, and hooks on one dedicated parent Effect fiber per call.
  Bind the authoritative invocation ID there so existing `compact.identity` consumers still work.
- Capture operation evidence before output validation/admission and transmission.
- Successful serialization or a pipe write is not proof of guest delivery.
- ACK means acceptance by the child runtime, not that user code awaited or understood the value.
- An ACK can arrive before the writer's completion callback. Handle this race explicitly; do not
  reject a valid ACK solely because local write settlement is late. Known acceptance must not
  become delivery loss because a later channel error occurs.
- Missing ACK after known operation completion preserves completion plus delivery-loss evidence.
  A delivered adapter exception is a received failure, not delivery loss.
- `result` is accepted only after sealing, all admitted calls have settled, and every response
  has been acknowledged. The ordered writer must enqueue ACKs before the final candidate.
- The protocol reader never waits for adapter completion or an execution semaphore. It validates
  and admits bounded work, then forks dispatch. ACKs and control traffic must keep flowing while
  all eight adapters are stalled.
- Parent-owned receipts remain the only source of operation outcome and recovery advice.

## 6. Limits and resource ownership

Keep existing user configuration names, defaults, bounds, persistence, and settings unchanged:

| Limit                           |       Existing default |
| ------------------------------- | ---------------------: |
| `timeoutMs`                     |              30,000 ms |
| `maxToolCalls`                  |                     32 |
| `maxOutputBytes`                |           51,200 bytes |
| `maxSourceBytes`                |           32,768 bytes |
| `maxCumulativeChildOutputBytes` |        2,097,152 bytes |
| `catalogBudget`                 | 2,000 estimated tokens |

Initial implementation constants, documented rather than new settings:

| Guard                                                         | Initial value/policy                                                                                        |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Adapter concurrency                                           | 8 per execution, unchanged                                                                                  |
| Active evaluator children                                     | 2 per owning Pi runtime; immediate busy refusal before spawn when full                                      |
| Startup/ready deadline                                        | `min(10 seconds, remaining execution time)`                                                                 |
| V8 old-space ceiling                                          | 512 MiB, fixed launch flag                                                                                  |
| Pending child requests                                        | At most configured `maxToolCalls`, maximum 10,000                                                           |
| `ready`, `replyAck`, `seal`, `finishAck`, `shutdown` payloads | 64 KiB each, including their complete JSON envelope                                                         |
| `call` payload                                                | 16 MiB including envelope and encoded input, checked before frame allocation                                |
| Aggregate retained call payloads                              | 64 MiB per execution across receiving, queued and running calls                                             |
| `reply` payload                                               | Derived from the particular result allowance plus JSON escaping/envelope overhead; absolute ceiling 128 MiB |
| Aggregate encoded reply reservations                          | 128 MiB per execution; reserve before encoding, not only when queued for writing                            |
| `result` payload                                              | At most `6 * maxOutputBytes + 64 KiB`, including envelope                                                   |
| `start` payload                                               | 1 MiB including catalog/envelope; fail catalog construction rather than drop tools silently                 |
| Transport read/write queue                                    | 1 MiB each; incremental draining and backpressure                                                           |
| Combined retained stdout/stderr                               | 256 KiB and 256 rendered records; keep draining after truncation                                            |
| Diagnostic text                                               | 64 KiB before the final configured clamp                                                                    |
| Pending native rejection records                              | 1,024; overflow fails execution rather than dropping failures silently                                      |
| Wire nesting                                                  | 64 levels                                                                                                   |
| Cleanup                                                       | 2 seconds total, including up to 500 ms TERM grace and subsequent KILL/confirmation                         |

Reserve each call's declared payload bytes before allocation and retain the charge through
validation, queueing, and operation execution. Release it only when this execution has discarded
its owned input references. A frame rejected by the aggregate limit fails the invocation as a
resource-limit error before that request dispatches. Do not pause the whole decoder waiting for
budget to return, which could prevent ACK processing. Already received acknowledgements and
operation outcomes remain authoritative during failure cleanup. Test a flood of large calls
while adapters stall. A count cap alone is insufficient for 10,000 potentially large inputs.

Reply encoding uses an owned plain-JSON size estimate to reserve bounded encoded capacity before
creating an encoded buffer. Output retained before encoding remains charged to the existing
cumulative-output budget and bounded dispatch concurrency. Waiters must not each hold another
encoded reply outside the writer's accounting. One response frame can use the whole reservation;
other dispatches wait interruptibly within the original deadline.

Transport ceilings include JSON escaping. Do not reuse the subagents' 4 MiB JSONL ceiling or
assume a 16 MiB logical value fits in a 16 MiB encoded envelope. Responses are serialized and
written under bounded admission; a small write queue must not hide an unbounded backlog of
already-serialized response buffers. Only one frame is assembled per direction at a time.

The V8 flag is not an RSS, external-buffer, descendant-memory, or OS memory limit. Native code
can still exhaust machine resources. Parent framing and capture bounds protect normal protocol
handling, not against arbitrary same-user attacks on Pi.

The execution deadline starts at host admission, before spawning, and covers startup, body,
drainage, serialization, and protocol acknowledgements. Cleanup has its separate bounded budget
and may extend the observed tool duration. Background Tasks polling uses the same original
execution deadline and retains its one-second delivery reserve.

## 7. Process lifecycle and cleanup

### State machine

```text
admitted -> spawning -> ready -> running -> draining -> candidate -> closing -> closed
                  \________ failure / cancel / timeout ___________/
```

- Pre-aborted, stale, disabled, untrusted, Windows, oversized-source, or busy requests spawn
  nothing and dispatch nothing.
- Spawn with `shell: false`, fixed argv, captured cwd/environment, and `detached: true` on
  macOS/Linux, establishing an owned process group.
- fd 0 carries bounded bootstrap source; fd 1/2 carry captured output; fd 3 is control;
  fd 4 is a parent-lifetime lease. Register cleanup ownership before the first interruptible wait.
- Keep independently owned stdout, stderr, control readers, and a serialized control writer.
  Closing stdin after bootstrap must not close the control writer.
- A fixed watchdog worker in the child watches lease EOF independently of the guest event loop.
  It must acknowledge that fd 4 observation is installed before the child sends `ready`; watchdog
  startup/error/early exit prevents guest execution. Start it with explicit `execArgv: []`.
- Lease EOF, unexpected lease closure, or a lease read error triggers an immediate SIGKILL to
  the validated owned process group. The lease reader stays flowing without retaining data.
  Do not send TERM
  and try to escalate later from a worker that TERM may already have killed. This covers a looping
  main thread and TERM-resistant owned grandchildren when Pi dies. It is not proof against every
  simultaneous crash or deliberate descriptor/process-group escape.
- A local macOS/Node 24.15.0 probe verified fd 3 communication and lease-triggered SIGKILL while
  the main child thread loops. Linux and Node 22 remain required real-process test gates.

Every finalization path, including normal return:

1. Revoke new request admission and stale publication authority.
2. On abnormal termination, interrupt the parent-owned dispatch fibers. These include Pi Bash
   subprocesses, which are not children of the evaluator and need their own AbortSignal cleanup.
3. Notify the child when possible; do not wait on an unresponsive control writer indefinitely.
4. Stop owned writes, send TERM to the owned process group, then KILL within the cleanup budget.
5. Confirm root exit, absence of the owned process group, and native pipe closure. An EPERM probe,
   destroyed stream, or absent leader alone is not confirmation. Sweep descendants after normal
   leader exit too.
6. Settle every pending request once, retain known outcomes, close readers/watchers/lease, and
   release the execution admission permit only after ownership is resolved.

Cache/idempotently share cleanup so abort, timeout, protocol failure, and session shutdown cannot
start competing finalizations. Bounded foreign callback cancellation must not wait forever on a
Promise that ignores AbortSignal. Preserve uncertainty when an external effect may continue.

Unconfirmed owned-process cleanup produces an explicit failure, never ordinary success. Block
new Code Mode child admission in the owning Pi process until restart. Use a sticky, versioned
process-global quarantine latch owned by core's host boundary, keyed by
`Symbol.for("cosmic-pi.code-mode.process-quarantine.v1")` on the parent `globalThis`. Store only a
bounded blocked flag/reason, no sessions, fibers, callbacks, or process registry. It may transition
from clear to blocked but has no runtime reset API. Invalid preexisting state fails closed.
A module-local Map is insufficient: fresh Jiti/module instances after `/reload` must observe the
same latch. Test module recreation as well as session replacement. This is an explicit small
process-lifetime boundary exception to session-owned Effect state, not a background recovery
service or a second process manager.

POSIX process-group absence covers the owned group only. A deliberately detached daemon may
survive. Native side effects and completed remote operations cannot be rolled back.

## 8. Concrete file plan

Proposed module names are implementation targets. Split implementation files before they become
large orchestration monoliths; preserve one owner for each state machine.

### Add in `packages/pi-code-mode`

| File                                       | Responsibility                                                               |
| ------------------------------------------ | ---------------------------------------------------------------------------- |
| `src/execution/service.ts`                 | Execution service and Layer, admission, phase transitions, owned scopes.     |
| `src/execution/state.ts`                   | Pure execution/request transitions and legal-state checks.                   |
| `src/execution/protocol.ts`                | Versioned message Schemas, message tags and protocol types.                  |
| `src/execution/framing.ts`                 | Incremental bounded encoder/decoder, UTF-8 and depth checks.                 |
| `src/execution/dispatch.ts`                | Parent per-call fiber, concurrency eight, hooks, response/ACK state.         |
| `src/execution/result.ts`                  | Owned result/diagnostic types, serialization projection and failure mapping. |
| `src/execution/limits.ts`                  | Fixed operational limits and derived wire ceilings.                          |
| `src/execution/child/controller.ts`        | Standalone scoped child service and native body completion barrier.          |
| `src/execution/child/tools.ts`             | Enumerable tool stubs, native public Promises, internal request registry.    |
| `src/execution/child/rejections.ts`        | Bounded native unhandled/rejection-handled observation.                      |
| `src/boundary/host-node-execution.ts`      | Shared process adapter, environment/argv/cwd snapshot and bootstrap source.  |
| `src/boundary/node-execution-launcher.mjs` | Fixed native ESM export using package-owned Jiti to load typed child code.   |
| `src/boundary/host-child-channel.ts`       | Child Node socket/stdio/event adapters; named native/Effect boundary.        |
| `src/tools/definitions.ts`                 | Owned schema/description/run descriptor replacing interpreter `Tool.make`.   |
| `src/tools/discovery.ts`                   | Catalog signature generation, budgeted instructions, search/pagination.      |

`src/execution/child/controller.ts` must not import parent dispatch, the extension entrypoint,
UI, or Pi APIs. The tiny `.mjs` launcher is maintained source, not generated output. Add an exact
Jiti runtime dependency, using the existing source-helper precedent. Do not rely on the consumer
having Jiti as a dev dependency.

### Change existing Code Mode files

- `src/tools/catalog.ts`: use owned definitions and discovery; keep producer codecs and atomic
  output admission. Avoid copying the entire vendored runtime into a renamed directory.
- `src/tools/execution.ts`: call the execution service, pass captured cwd and the original deadline,
  preserve progress/details/final clamping, and use authoritative RPC invocation IDs.
- `src/layer.ts`, `src/application.ts`: compose process capability and execution service into the
  existing session runtime. Keep trust and publication-owner ordering unchanged.
- `src/tools/controller.ts`: replace interpreter instructions with native Node, JSON boundary,
  authority, completion, and platform instructions.
- `src/tools/format.ts`, `src/tools/failure-evidence.ts`, affected UI type imports: depend on owned
  result types rather than the vendored boundary; preserve historical result decoding.
- `src/boundary/codemode-runtime.ts`: keep as a temporary migration adapter only, then delete.
- `src/boundary/host-builtin-tools.ts`, `host-background-task.ts`, `host-mcp.ts`: retain behavior;
  change imports/types only where needed. Do not move dispatch into the child.
- `package.json`, `vitest.config.ts`, README and ARCHITECTURE: update dependency/shipping entries,
  remove nested-runtime assumptions, and document intentional compatibility changes.

Do not change settings persistence, project trust policy, direct-dispatch semantics, MCP policy,
background task lifetime, historical UI decoders, or the retained failure-details protocol.

### Shared core changes

- Extend `src/platform/duplex-process.ts` with an opt-in side-channel mode and independent stdin
  end, leaving the existing stdin/stdout mode as the default for MCP callers.
- Extend `duplex-process-io.ts` for bounded control I/O and independent output capture; extend
  `duplex-process-close.ts` to account for every native pipe and the lifetime lease.
- Add `src/platform/process-side-channel.ts` for side-channel acquisition/normalization if needed
  to keep the existing owner small. Do not create a second process owner in Code Mode.
- Add `src/platform/process-parent-watchdog.mjs` and its typed host adapter for the fixed
  parent-lease worker. Its only termination target is its validated owned child group.
- Extend `src/platform/node-builtins.ts` for required socket/worker native adapters.
- Generalize the explicit platform check to tested macOS/Linux support. Other platforms return
  the typed unsupported-platform error.
- Add `src/platform/process-quarantine.ts` with the sticky process-global host-boundary latch
  specified above. Do not rely on `process-coordinator.ts`'s module-local Map for reload survival.
  Existing public exports stay compatible; new capabilities are opt-in through `index.ts`.
- Update core ARCHITECTURE and its process tests. Existing MCP stdio behavior must remain intact.

### Remove at cutover

- `packages/pi-code-mode/runtime/`, after retained behavior tests and any useful discovery code
  have moved to their new owners.
- `acorn` and `typescript-compiler-api` from Code Mode. Remove catalog entries only if no other
  package uses them. Replace the package's special compiler binary override only when its reason
  no longer exists.
- The nested runtime entry in `pnpm-workspace.yaml` and
  `scripts/workspace-manifest-paths.mjs`; update `pnpm-lock.yaml` from a root install.
- Interpreter-only language/confinement tests and negative lifecycle-ID compatibility code for
  old runtime module caches. Do not remove persisted-session UI compatibility.
- Runtime-path assertions in `scripts/verify-packed-core.mjs`, replacing them with real child
  execution rather than symbol-existence checks.

Preserve MIT attribution for any retained/copied upstream search, schema-description, or test
code. Move required notices to the owning package before removing the old provenance directory.
Update root `AGENTS.md`, `docs/architecture/effect-v4.md`, `pi-boundaries.md`, and relevant package
README/architecture text that currently mandates the private runtime path. Check lint/layout
allowlists for obsolete paths rather than weakening the guards.

## 9. Implementation sequence and acceptance gates

### Phase 1: lock the contract and isolate the catalog

- Add owned definitions/results/discovery, adapt the current catalog, and preserve current
  adapter/evidence tests while the old engine is still the production caller.
- Write tests for the new completion, serialization, platform-refusal, and request-state contract.
- This temporary internal compatibility step is not a public backend selector.

Gate: catalog/search behavior, schema decoding, tool names, configuration, and host adapters
remain covered without requiring interpreter objects outside the temporary boundary.

### Phase 2: process transport and lifecycle

- Implement opt-in fd 3 control transport, stdin bootstrap closure, output capture, fd 4 lease,
  watchdog, Linux group cleanup, and uncertain-cleanup admission blocking in core.
- Add typed process/framing failure paths and real-process fixtures before executing guest code.

Gate: macOS and Linux round trips work on supported Node versions; normal exit, startup abort,
blocked main thread, parent death, inherited pipes, TERM refusal, and surviving owned grandchildren
have tested cleanup outcomes. Existing MCP stdio tests still pass. Windows refuses before spawn.

### Phase 3: native runner and RPC

- Add the fixed launcher and typed child service, native stdin function wrapper, tool stubs,
  bounded protocol, JSON projection, native error observation, and seal/drain/final handshake.
- Add parent dispatch with call budgets and concurrency eight. Preserve fiber-bound observation
  identity and separate operation/delivery state.

Gate: the two-tool read/list example runs through actual RPC with correct progress; parallel
identical calls correlate; a lost reply after a mutation never permits replay; native race losers
finish admitted work; timeout and cancellation kill an infinite guest loop without blocking Pi.

### Phase 4: integrate session and presentation

- Wire the service through the existing session Layer and execution controller.
- Preserve exact counts, bounded rows, live timing, redacted subjects, evidence, failure retention,
  final UTF-8 clamping, and stale callback rejection.
- Update tool instructions and compatibility documentation before enabling the new caller.

Gate: existing adapter, lifecycle, delivery-evidence, settings, UI, and replay suites pass against
the new service. Session replacement cannot publish old rows or clear cleanup quarantine.

### Phase 5: packed execution, cutover, and deletion

- Extend the clean-consumer smoke to launch the installed child, call a fixture host tool, return
  structured data, and cancel a looping program. Assert confirmed cleanup.
- Verify relative and package imports from a disposable project, not from the repository root.
- Delete the interpreter and migration adapter, prune dependencies/workspace registration, and
  move required notices. Ship no dual backend or silent fallback.

Gate: no production import references `runtime/`, Acorn, the guest transpiler, or interpreter
state. The installed package runs without workspace symlinks, build output, or private packages.

Never automatically fall back or retry after any guest execution or tool admission. A rollback
means reverting the release, not replaying an invocation with the old engine.

## 10. Verification matrix

Add focused tests under package-root `tests/execution/` and core process tests. Existing tests
remain authoritative for host behavior; relocate only useful interpreter tests.

| Area               | Required observable cases                                                                                                                                                                                                                                                                                                               |
| ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Native semantics   | Async/await, chaining, Array.from mapper, mutation/identity, classes/generators, dynamic imports, ordinary file-based Worker/fork without inherited bootstrap flags, explicit return versus fallthrough. Keep a small representative integration suite, not a JavaScript conformance project.                                           |
| Fresh execution    | Globals/module caches do not persist between calls; captured cwd and environment are correct.                                                                                                                                                                                                                                           |
| Completion         | Ignored successful calls drain; ignored rejected public Promises fail; caught errors retain evidence; post-seal calls never dispatch; result serializes after admitted replies.                                                                                                                                                         |
| Native combinators | Race losers and all siblings are not cancelled on ordinary settlement; pending losers consume the original deadline.                                                                                                                                                                                                                    |
| Protocol           | Split/coalesced headers, exact frame limit, invalid UTF-8/depth/JSON, truncated EOF, duplicate/unknown sequences, stale IDs, illegal phases, ACK before local write callback, late ACK, no ACK.                                                                                                                                         |
| Resource bounds    | Aggregate queued/running input bytes while adapters stall, ACK processing under that load, encoded-reply reservations, request flood, write backpressure, stdout/stderr flood, envelope/escaping boundary cases, oversized source/result/error, multibyte truncation, zero-byte final output, child heap exhaustion as process failure. |
| Dispatch           | Eight concurrent adapters, budget charged before effects, invalid input causes no effect, repeated await does not duplicate dispatch, discovery consumes budget.                                                                                                                                                                        |
| Delivery certainty | Completed write/MCP call followed by response failure, child death, decode failure, or missing ACK preserves completion and recovery advice.                                                                                                                                                                                            |
| Lifecycle          | Abort before spawn, during spawn/handshake, while queued/running, during drain and cleanup; session replacement; stale callbacks; unconfirmed cleanup blocks later admission across reload.                                                                                                                                             |
| OS cleanup         | Infinite synchronous loop, unresolved Promise, ignored TERM, inherited pipe/grandchild, normal leader exit with remaining group members, watchdog-ready gating, immediate parent death as guest starts, parent SIGKILL while guest and a TERM-resistant grandchild are running.                                                         |
| Native authority   | Filesystem/network imports run in the child; stdout cannot corrupt RPC; direct I/O creates no fabricated adapter rows.                                                                                                                                                                                                                  |
| Serialization      | Undefined, strings, NaN/Infinity, Date/URL/Map/Set, BigInt, cycles, getters/toJSON exceptions and serialization-created ignored rejections, no second serialization after the checkpoint, depth limit, oversized output previews.                                                                                                       |
| Companion APIs     | MCP policy/certainty/retained-result recovery; Background Tasks survive evaluator exit; wait/log deadlines retain the one-second reserve.                                                                                                                                                                                               |
| UI/replay          | Counts independent of 256 rows, no active-row eviction, bounded source/error fallback, historical receipts and one-shot retained details unchanged.                                                                                                                                                                                     |
| Packaging/platform | Real tarball child execution on Node 22/24/current supported line, macOS/Linux, project paths with spaces, no repository cwd assumptions, Windows pre-spawn refusal.                                                                                                                                                                    |

Run native-process tests with real time and an outer test-process watchdog so a broken shutdown
cannot hang the suite. Mock owned boundaries for protocol/state tests, not external provider
protocols. Do not assert exact wire field ordering, UI copy, or internal callback counts.

Validation order:

```sh
pnpm --filter pi-cosmic-core test
pnpm --filter pi-code-mode test
pnpm --filter pi-cosmic-core check
pnpm --filter pi-code-mode check
pnpm --filter pi-cosmic-core effect:diagnostics
pnpm --filter pi-code-mode effect:diagnostics
pnpm --filter pi-mcp test
pnpm pack:smoke
pnpm validate
```

Run the real process and packed-execution cases on Linux as well as macOS before cutover. Record
cold startup, two-call orchestration, parallel RPC throughput, cancellation latency, and parent
memory under output flood. Do not add pooling to hide a packaging/startup failure.

## 11. Definition of done

- Node owns JavaScript semantics; no interpreter or custom Promise scheduler remains.
- All accepted tool requests have one authoritative identity, bounded transport, and honest
  operation/delivery evidence.
- Every exit owns process and parent-adapter cleanup, with uncertainty reported rather than hidden.
- macOS/Linux and supported Node versions pass real-process and packed-install tests; Windows is
  explicitly unavailable until a separately planned implementation exists.
- Native authority, completion sealing, JSON boundaries, and memory/descendant limitations are
  documented in the tool instructions and package documentation.
- Existing UI, config, companion API, and replay contracts remain covered.
- Full workspace validation passes. No release, tag, push, staging, or commit is implied by this plan.
