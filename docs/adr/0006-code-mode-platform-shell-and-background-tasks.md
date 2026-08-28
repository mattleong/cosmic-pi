# ADR 0006: Code Mode platform shell parity and Background Tasks adapter

- Status: Accepted
- Date: 2026-08-26
- Expands: ADR 0004

## Context

ADR 0004 fixed Code Mode's Pi catalog at seven fresh built-in definitions. Pi now also provides a
native PowerShell definition for Windows. Code Mode otherwise exposes Bash on every platform and
cannot use Pi's native Windows shell tool.

Code Mode can start a detached process through Bash, but that process has no session-owned task id,
bounded log cursor, wait barrier, status, or guaranteed shutdown cleanup. `pi-background-task`
already owns those behaviors in one session runtime. Recreating its service inside Code Mode would
split process ownership. Invoking the registered `background_task` definition would also require an
unsupported generic nested-tool dispatcher and would bypass or misrepresent Pi's normal pipeline.

## Decision

### Windows PowerShell

Code Mode adds `tools.pi.powershell` only when `process.platform` is `win32`. The definition comes
from Pi's `createPowerShellToolDefinition` factory and uses the same direct dispatch path as the
seven core definitions. It receives the current Code Mode interruption signal. On other platforms
the leaf is absent from both execution and the discovery catalog.

The workspace Pi packages move together to version 0.84.3, the first pinned version used here that
exports the PowerShell definition factory.

### Explicit Background Tasks adapter

Code Mode always describes one reviewed extension capability at:

```text
tools.session.backgroundTask
```

This is not a Pi builtin and is not registered-tool dispatch. The `session` namespace distinguishes
it from the fresh definitions under `tools.pi`.

`pi-background-task/code-mode` exports a versioned plain-data protocol. The Background Tasks
extension registers a synchronous `pi.events` query listener during extension setup. It publishes
only a checked Promise capability bound to:

- one stable Pi session id;
- one current Background Tasks slot token;
- the existing session runtime and service;
- the current activation of the top-level `background_task` tool.

Code Mode queries the protocol when the nested leaf runs, not during `session_start`. This avoids
extension load-order dependence. Missing session identity, an inactive or missing provider, a
session mismatch, malformed output, or multiple valid providers fails closed as a catchable nested
tool failure.

The capability runs the same extracted background action Effect as the top-level tool. No service,
Layer, runtime, Ref, or scope crosses the event protocol. Input is schema-decoded on both sides of
the cross-extension boundary. Output is copied into a bounded plain structured result. Log text
keeps the Background Tasks truncation and cursor metadata.

The Code Mode timeout, outer cancellation, and session replacement interrupt active adapter waits
through the concrete Promise signal. A successfully started task belongs to Background Tasks and
may outlive the outer Code Mode call. Background Tasks remains responsible for process-tree cleanup
at Pi session shutdown.

Structured adapter results are charged to `maxCumulativeChildOutputBytes` as compact JSON. Before
copying snapshots, the provider receives the current remaining allowance, capped at 16 MiB, and
uses a conservative streaming JSON byte estimate to refuse an oversized projection. The consumer
then applies bounded field and array schemas, repeats the aggregate estimate for the foreign
response, and performs exact atomic budget admission. Failure text
shares the existing cumulative budget. Admission happens after an action settles and cannot undo a
process start, stop, or other side effect.

### No generic tool expansion

Code Mode still does not inspect `pi.getAllTools()` or execute registered tool definitions. MCP,
interactive tools, subagent orchestration, image tools, and arbitrary extension tools remain
outside the catalog. Adding another extension capability requires another explicit reviewed
adapter and protocol.

## Consequences

- Windows programs can use Pi's native PowerShell tool without advertising it elsewhere.
- Code Mode programs can start, inspect, wait for, read, stop, and clear the same task registry used
  by the top-level `background_task` tool.
- Deactivating `background_task` also makes the nested adapter unavailable, even though its fixed
  schema remains discoverable in Code Mode.
- Nested Background Tasks calls do not emit Pi `tool_call` or `tool_result` middleware events and
  do not get a nested preview row. The outer Code Mode row reports their lifecycle.
- Installing `pi-code-mode` installs the Background Tasks protocol package, but the adapter remains
  unavailable unless the Background Tasks extension is loaded and active.

## Primary references

- `packages/pi-code-mode/src/boundary/host-builtin-tools.ts`
- `packages/pi-code-mode/src/boundary/host-background-task.ts`
- `packages/pi-code-mode/src/tools/catalog.ts`
- `packages/pi-background-task/src/boundary/host-code-mode.ts`
- `packages/pi-background-task/src/code-mode/protocol.ts`
- ADR 0004: Code Mode exposes all Pi built-ins
