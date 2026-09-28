# Code Mode on native Node

Status: implemented on `main`.

Replace the vendored JavaScript interpreter with one fresh Node process per `code_mode` call.
Code Mode's purpose stays the same: many tool calls per agent turn, with logic between them.

## Evidence

From 1,139 `code_mode` programs in local Pi sessions (2026-08-12 to 2026-09-27):

- 4.1 tool calls per program on average; 28% had dependent sequential steps, 8% awaited inside
  loops.
- No `Promise.race`, `Promise.any`, AbortSignal, timers, `new Promise` or TypeScript syntax.
  Time limits came from bash's own `timeout:` argument (15% of programs).
- 98 programs failed (8.6%); 17 failed only because of the interpreter subset (regex guard,
  `.then`/`.catch`, tagged templates, labels, `delete`, regex budget).
- 46 calls were cancelled when a `Promise.all` sibling failed; three batches of edits ended with
  unknown outcomes. Those calls had run 4–125 ms. No successful program left calls running.
- Call durations: read p99 0.3 s, edit p99 0.9 s, bash p99 3.6 s (max 18 s), background task
  max 29 s.
- 42 programs returned nothing and relied on `console.log` output.

## Decisions

- One fresh Node process per call, from `process.execPath`, with the captured cwd and a minimal
  environment. macOS and Linux only; other platforms are refused before anything starts.
- Tools stay in Pi: same `tools.*` names, discovery, schema validation, budgets (32 calls, eight
  at once), progress rows and receipts. Settings keep their names, defaults and bounds.
- No sandbox, but file and process work is routed through tools: the program runs under Node's
  permission model with only the runner's own files readable and workers allowed. File reads and
  writes, project imports, child processes, addons and WASI are refused, so that work goes through
  recorded `tools.pi.*` calls. Node is for computation, built-in modules and the network. Node 25+
  denies the network under `--permission`, so Pi passes `--allow-net` where Node knows the flag;
  direct network use is allowed on every version and is not recorded (bash can `curl` anyway).
- Source is JavaScript, or TypeScript through Node's type stripping (enums unsupported). The
  TypeScript compiler and Acorn are removed.
- The result is the explicit `return` value (none gives `null`) plus captured stdout and stderr,
  returned as "Logs:" as before.

## Completion and cancellation

- When the program returns or throws, new tool calls are refused, calls already started finish
  within the deadline, and the result reports every call's real outcome.
- `Promise.race` losers and `Promise.all` siblings are never cancelled.
- Only the deadline and user cancellation stop work early: they kill the process group and
  interrupt in-flight calls. Those are the only source of "unknown" call outcomes.
- No `{ signal }` option or race helper. Tools keep their own timeouts. Revisit if races appear.
- An unhandled rejection or uncaught exception fails the run; caught failures keep a successful
  result.
- A failed run includes the output of calls that completed, within the output limit, so the
  model redoes only the failed work.

## Process and protocol

- Spawn `node <flags> src/boundary/code-mode-child.mjs` detached in its own process group with
  stdio `ignore, pipe, pipe, pipe, pipe`: stdout and stderr are captured together as logs,
  fd 3 is the control channel and fd 4 is a lifetime lease.
- The child is a small dependency-free ES module. It compiles the program with `vm.Script` as an
  async function body in the main context, using the main loader for dynamic `import()` of Node
  built-ins. A JavaScript syntax error retries
  once through `module.stripTypeScriptTypes`.
- A worker thread watches fd 4. EOF means Pi is gone, so it SIGKILLs the child's process group,
  even while the main thread is stuck in a loop. The program starts only after the worker is up.
- Frames are a 4-byte big-endian length followed by UTF-8 JSON, capped per direction before
  allocation. Messages: `start` (source and tool paths), `call`, `reply`, `result`, `finish`.
- No per-reply acknowledgement. The child sends `result` only after every reply has settled, so
  `result` confirms delivery. If the child dies first, completed calls stay completed and their
  delivery is reported as lost.
- The child flushes stdout and stderr before `result`. After `finish` it exits; Pi then sweeps the
  process group (TERM, then KILL within two seconds). Unconfirmed cleanup is reported as a
  warning; there is no process-wide quarantine.
- Tool failures keep Pi's own diagnostic. The child reports only the request sequence of the
  error that escaped, plus its call-site location from the stub's stack.

## Limits

| Guard                            | Value                                      |
| -------------------------------- | ------------------------------------------ |
| Child frame (call input, result) | 17 MiB, checked before allocation          |
| Captured stdout and stderr       | 256 KiB retained, then drained and dropped |
| V8 old space                     | 1024 MiB                                   |
| Log tail wait after `finish`     | 250 ms                                     |
| Cleanup                          | 2 s total, 500 ms TERM grace               |

## Phases

1. Move tool definitions, discovery/search, schema rendering and result types out of `runtime/`
   into `src/engine/`.
2. Core: side-channel mode for the duplex process owner (fd 3 channel, fd 4 lease, retained
   stdout and stderr, Linux support).
3. Child runner, protocol and parent dispatch in `src/execution/`.
4. Wire into the session; rewrite the model instructions for native Node.
5. Delete `runtime/`, Acorn, the TypeScript compiler and workspace entries; move MIT notices;
   replace the packed-install runtime checks with a real child execution.
6. Partial results on failure.

Until the switch-over the interpreter gets essential fixes only.

## Implementation notes

- The program is compiled with `vm.Script` inside a fixed child module rather than piped in as a
  stdin entry, so syntax errors are caught with their location and no source is spliced into a
  generated file.
- The watchdog reads fd 4 as a socket. A thread-pool `fs` read blocked the process's own exit.
- The permission allowlist names the runner's real paths. A symlinked path fails, because Node
  resolves the entry's real path under the same permissions.
- Acorn stays: the UI's program-source formatter uses it, with a raw fallback for TypeScript.
- Unknown tools now fail inside the program (`tools.x is not a function`) and are reported as
  `UnknownTool` with suggestions. They no longer produce a refused-call row.
- Thrown errors now carry their line, which the UI shows (`boom (line 1)`).
- The Windows-only `tools.pi.powershell` wiring remains but is unreachable while Code Mode refuses
  Windows.
- `queueDurationMs` was dropped from lifecycle events; nothing read it.

## Reviewing usage

`pnpm code-mode:usage [--since YYYY-MM-DD]` summarizes local Pi sessions: programs, nested calls,
failures by kind, refused direct Node access and whether the next program recovered, and
concurrency patterns. It prints aggregates only, never program source or tool output.
