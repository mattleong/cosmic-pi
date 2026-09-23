# pi-code-mode-runtime architecture

Host-neutral confined code execution over explicit, schema-described tools,
vendored from OpenCode 2 Code Mode (see `PROVENANCE.md` for origin, license, and
resync policy). A model-written JavaScript program is TypeScript-transpiled,
Acorn-parsed, and tree-walk interpreted; generated code is never passed to
`eval`, `Function`, `node:vm`, or a child JavaScript runtime. Programs can only
call the tools the host supplies.

This package is workspace-private and host-neutral: it has no Pi imports and no
Pi-specific policy. It is nested inside the public `pi-code-mode` package
directory so its TypeScript `src/` tree ships inside the `pi-code-mode` tarball
and loads directly through Pi/Jiti; `pi-code-mode` consumes it exclusively
through the relative-path boundary door `src/boundary/codemode-runtime.ts`.
The `pi-code-mode` extension owns every
Pi-facing concern above this boundary: the outer `code_mode` agent tool, adapters for seven core
`tools.pi` built-ins and Windows PowerShell, the explicit Background Tasks session adapter, their
[authority policies](../ARCHITECTURE.md), and the Pi host limits (program source size, cumulative
nested output).

## Source map

```text
src/
  index.ts              # public barrel: CodeMode, Namespace, Tool, ToolError/toolError
  codemode.ts           # public CodeMode namespace: make/execute, schemas, types
  catalog.ts            # semantic discovery snapshots and host-only delta decisions
  namespace.ts          # host-only optional namespace descriptions
  failure.ts            # closed internal RuntimeFailure union
  tool.ts               # Tool.make and tool definition types
  tool-error.ts         # ToolError: safe model-visible tool refusal
  tool-runtime.ts       # tool tree walking, catalog/search/instructions, limits + lifecycle
  tool-runtime-data.ts  # bounded data projection, expanded-cost preflight and copying
  tool-runtime-error.ts # shared tagged runtime error leaf
  tool-schema.ts        # Effect Schema / JSON Schema signature rendering (internal)
  values.ts             # sandbox value wrappers (Date, RegExp, Map, Set, URL, promises)
  runtime-values.ts     # owned runtime-type predicates used instead of host `typeof`
  interpreter/
    model.ts            # interpreter AST/diagnostic model (internal)
    guest-turns.ts      # LOCAL FIFO guest-continuation and promise-reaction scheduling
    group-by.ts         # LOCAL bounded live grouping with interpreter callbacks
    set-operations.ts   # LOCAL Set algebra, membership predicates, and allocation preflight
    json.ts             # LOCAL JSON callbacks, projection, and exact output preflight
    runtime.ts          # interpreter composition and shared evaluator state
    execution.ts        # execution setup, scope-owned work and completion
    host-execution.ts   # public Effect execution boundary and limits
    diagnostics.ts      # parsing, transpilation and safe diagnostics
    references.ts       # opaque runtime-reference classification
    generators.ts       # suspended generator activations and request queues
    iterator-protocol.ts # iterator acquisition, stepping, closing and materialization
    scope.ts            # binding lookup, initialization and scope stack
    bindings.ts         # iterator-aware binding/assignment patterns and computed keys
    assignment.ts       # reference resolution, evaluation order and assignment writes
    recursion.ts        # fixed guest call-depth budget; internal test injection only
    statements.ts       # control flow and statement evaluation
    expressions.ts      # expression evaluation
    callable.ts         # guest activation and callable dispatch
    promises.ts         # promise reactions and combinators
    iteration.ts        # collection traversal and callback helpers
    members.ts          # guarded member access and mutation
    builtins.ts         # array builtin dispatch and callbacks
    globals.ts          # allowlisted global static operations
    constructors.ts     # bounded construction and coercion
    string-operations.ts # bounded string and regexp operations
    console.ts          # bounded guest log projection
    confinement.ts      # LOCAL (non-upstream) in-process confinement: regex guard +
                        # subject caps, amplification limits, wall-clock deadline
    regex-first-sets.ts # LOCAL (non-upstream) conservative alternation first-character
                        # analysis used by the confinement regex guard
  stdlib/               # confined standard-library surfaces (internal)
    bytes.ts  encoding.ts # owned byte operations, UTF-8, strict base64 and hex
    collections.ts  console.ts  date.ts  epoch.ts  json.ts  math.ts
    number.ts  object.ts  promise.ts  regexp.ts  string.ts  url.ts  value.ts
tests/                  # upstream and local behavioral suites (Effect-backed Vitest)
  test262.test.ts       # mandatory pinned selection, no network prerequisite
  test262/              # local runner, checksum manifest and unchanged fixtures
```

## Public boundary

The only public entry is `src/index.ts` (`pi-code-mode-runtime` package export):

- `CodeMode` - `make`, `execute`, result/diagnostic schemas and types, plus optional
  queued/running/terminal tool-call lifecycle observation.
- `Tool` - `make`, `Definition`, `Options`, `SchemaType`, `JsonSchema`.
- `Namespace` - `make({ tools, description })`, optional host-only discovery metadata.
- `ToolError` / `toolError` - the explicit safe-message failure channel.

Everything else (`failure.ts`, `tool-runtime.ts`, `tool-schema.ts`, `values.ts`,
`interpreter/`, `stdlib/`) is internal; tests may reach into internals exactly
where the upstream suites do (`ToolRuntime.copyOut`).

## Effect and JavaScript boundaries

The runtime inherits every workspace TypeScript, Effect language-service, and
lint check without a package-specific relaxation. `RuntimeFailure` closes the
interpreter's Effect error channel over owned tagged errors and internal program
throws. `Tool.make` accepts host effects with any typed error, then normalizes
them to the safe `ToolError` channel. Interruption remains interruption. Other
host failures and defects become the fixed `Tool execution failed` refusal
before interpreter code can observe them.

Host lifecycle durations read the Effect `Clock`. Guest `Date` behavior stays
JavaScript wall-clock behavior through `stdlib/epoch.ts`; it is not replaced
with the Effect test clock. Guest `async` and `Promise` behavior likewise remains
interpreter behavior. The Vitest suites use Effect-backed, non-`async` host test
bodies so host scheduling and guest language semantics stay separate.

## Result observation

`ExecuteOptions.onResult` is an optional synchronous host callback in `host-execution.ts`.
It receives the full final plain-data copy or normalized failure, not the truncated output.
Success observation follows final projection and deadline checks. It sees no opaque
interpreter object. Hosts must use a bounded traversal and must
not retain or mutate the supplied graph. A thrown callback is ignored, never converted into
a program failure. Host interruption remains interruption and need not produce a callback.
Without the hook, returned results and execution limits are unchanged. Storage, quotas,
retrieval and lifecycle revocation belong to the host, not this runtime.

## Fixed runtime policy

- Tool-call concurrency is a fixed constant 8; data-boundary depth is a fixed
  constant 32. Neither is a public knob.
- `timeoutMs`, `maxToolCalls`, and `maxOutputBytes` have no defaults - execution
  budgets are host policy. The discovery catalog budget defaults to 2000
  estimated tokens.
- No Pi-specific limits (program source size, cumulative child output) live in
  this package; a Pi host applies those above this boundary.

`Array.from(source, mapper)` is a local compatibility addition in the interpreter.
Mappers use existing interpreter callback execution, not host JavaScript callbacks. Live
collection iteration and fixed-length array-like reads preserve source mutations. Source
preflight, per-entry collection checks before mapper execution, and cooperative deadline
checks bound self-extending iteration. Returned tool promises remain unawaited values.
Nonundefined `thisArg` remains unsupported. See `PROVENANCE.md` deviation 11.

## Assignment, bytes and discovery ownership

`assignment.ts` resolves assignment references once and preserves compound/logical evaluation
order. `bindings.ts` shares iterator-aware pattern traversal between declarations and assignments,
including computed keys, defaults and rest. Writes still use the guarded member/binding doors.

`values.ts` owns opaque `SandboxBytes`, `SandboxTextEncoder` and `SandboxTextDecoder` values.
`stdlib/bytes.ts` and `encoding.ts` own bounded byte operations and pure encodings; interpreter
constructor, member, iterator and callable dispatch admit only their explicit methods.
`subarray` may share owned storage; `slice` copies. `tool-runtime-data.ts` rejects these values at
nested data boundaries with an encode-first hint. No host buffer or ambient I/O is exposed.

`namespace.ts` keeps descriptions outside the guest tool tree. `tool-runtime.ts` indexes ancestor
descriptions and selects clipped catalog metadata within the existing budget; `catalog.ts`
compares discovery projections. `tool-schema.ts` renders constraint annotations without adding
raw JSON Schema validation. Effect Schema validation remains the execution boundary.

## Guest functions and promises

Each function invocation has its own evaluator stack while captured binding maps remain
shared. `recursion.ts` owns a fixed synchronous guest call-depth cap of 128. Ordinary calls,
async prefixes, callbacks and generator resumes share the policy; a semantic await starts a
fresh depth segment. The conservative cap accounts for immediate Effect activation forks without
changing FIFO scheduling. It is not a total invocation quota, and async pagination may exceed
128 calls across awaits. Only internal tests inject smaller budgets; no host or user setting
changes the production cap. Async functions return distinct promises after their synchronous prefix. One execution
owns their scope, deadline, logs, tool permits, lifecycle ids, and bounded promise tracking.
`guest-turns.ts` serializes guest continuations and promise reactions in FIFO order; Effect
scheduler yields cannot split a synchronous guest turn. Promise settlement is separate from
fiber cleanup so cleanup latency cannot reorder race winners.

Execution-owned fibers keep fire-and-forget tools alive after an async function returns.
Completion drains newly admitted work until quiescent before reporting unhandled failures.
Timeout and host cancellation close the execution scope. Losing races cancel descendants,
including those of completed activations, but never their own activation ancestors;
re-entrant cancellation is guarded against mutual interruption waits. `then`, `catch`, and
`finally` share FIFO reactions and callable dispatch with ordinary calls. Each returned chain
tracks its own rejection. `Promise.any` retains losing work while execution continues; execution
teardown still cancels pending observed work. `AggregateError` preserves original rejection
values in nonenumerable `errors`, with optional nonenumerable `cause`. Custom thenables,
`this` binding, and the Promise constructor remain unsupported. Custom iterators and
generators use execution-owned suspended activations and bounded iterator dispatch; see
`SUPPORT.md`.
See deviations 13 and 16 for the original promise implementation.

Object helpers validate without replacing shallow references. `Object.assign`, `reverse`,
and `sort` mutate their targets; assignment and sort write-back retain cycle and growth
guards. Sparse literals preserve holes, with separator preflight charging holes in `join`.
Copying array variants stay nonmutating. See deviation 12 and the compatibility tests.

## Collection callbacks and Set operations

Array helpers, Array.from, sorting, collection forEach, and string replacement share callable
detection and ordinary interpreter call dispatch. Callback arguments and nonawaited promises
retain their existing behavior; builtin and tool input validation still applies. Callback loops
check the execution deadline before dispatch.

`set-operations.ts` implements Set algebra and membership predicates over owned Set/Map
wrappers only. It preserves key identity, SameValueZero, and native result ordering. Exact
result-size preflight permits overlapping full-size inputs without allowing oversized results;
copy/delete difference checks its bounded source before allocation. Every traversal checks the
deadline. Neither operand is mutated, and custom set-like objects are refused. See deviation 17.

## Grouping and JSON callbacks

`group-by.ts` owns live `Object.groupBy`/`Map.groupBy` iteration, preserving entry and key
identity without awaiting callback results. Source, visited-entry, group-size, key-coercion,
and deadline checks bound growth and delete/reinsert loops. Object groups use null-prototype
records and reject blocked keys.

`json.ts` owns JSON evaluation; `stdlib/json.ts` holds synchronous native syntax/encoding
primitives and the method allowlist. Replacers visit
original values before projection; revivers run bottom-up and delete properties on undefined.
Neither awaits callbacks. Own-property-only, null-prototype projections prevent property lists
from reaching host prototypes. Exact UTF-16 accounting covers escapes and indentation before
native serialization. Traversal accounting includes property-list lookups on opaque `{}`
projections. Returned reviver graphs are validated without replacing references. Guest `this`,
custom `toJSON`, and reviver source contexts are not provided. See deviations 14–15.

## In-process confinement (local deviation)

`src/interpreter/confinement.ts` and its helper `src/interpreter/regex-first-sets.ts`
are local additions (not vendored; see `PROVENANCE.md` deviation 8). Because the
interpreter runs model-written programs in the host process, the `timeoutMs`
Effect timeout cannot preempt a synchronous native operation once it starts.
Confinement bounds every such operation up front:

- **Regex** - a static guard rejects unpreemptible constructions
  (backreferences, nested quantifiers, alternation inside a repeated group,
  ambiguous alternation whose branches can start on the same input character -
  the anchored `(a|aa)(a|aa)...b` family, screened by the conservative
  first-character analysis in `regex-first-sets.ts` - inline flag-modifier
  groups (`(?i:...)`, `(?ims-ims:...)`), whose local flag semantics the
  flag-sensitive analysis does not model - quantified lookarounds,
  oversized counted repeats, too many optional quantifiers, a combined
  quantifier/alternation branch factor over 256, more than 3 unbounded
  quantifiers/lookarounds - the polynomial `/a*a*a*b/` family - and the `v`
  flag), and each admitted native match operation is capped by subject length
  scaled to the pattern's residual backtracking degree and divided by its
  combined branch factor. The screen is deliberately conservative (some safe
  patterns are rejected) and is not a claim of mathematical preemption of
  native matching: admitted operations still run to completion. The caps are
  calibrated so the known hostile families' measured worst cases stay around
  the low tens of milliseconds on current V8 - a calibration target, not a
  proven bound for every admissible pattern.
- **Amplification** - fixed maxima for string length, collection entries, and
  captured log output, enforced by preflight guards that project the output and
  refuse the first overrun before the native allocation runs (forged array-like
  lengths, `flat` projections, merged `Object.assign`/spread growth,
  URLSearchParams doors, URL query pair counts before URL construction and
  `search`/`href` writes, and percent-encoding expansion included), with the
  shared `copyIn` data checkpoint re-checking everything that crosses it.
  `tool-runtime-data.ts` memoizes inert normalized data by identity and depth, charging
  repeated references by expanded visit/container/serialization costs before
  tree expansion. Accessors invalidate prior memo entries and prevent caching their
  active ancestors, preserving occurrence-based host getter evaluation. Tool arguments
  share one budget. A separate bounded expansion preserves independent ordinary branches
  without rereading host getters. Reference reachability retains visited identities rather
  than expanding DAGs. Thrown-data projection refusal produces a bounded diagnostic,
  not another coercion attempt or an escaped defect that skips failure observation.
  Fixed aggregate budgets admit full-size primitive pair collections and strings;
  they are independent of public output and retention policy. Deviation 8 records
  their values and supported getter semantics.
  Regex `split` and `matchAll` results are bounded post-checks, not preflights:
  the admitted subject cap bounds the match count (and the native `split` limit
  clamps materialization to the entry cap) before the entry cap is applied.
- **Deadline** - a shared `ExecutionDeadline` checked between interpreter steps,
  after the run, after final copying and after serialization before success
  observation normalizes a synchronous overrun to `TimeoutExceeded` without
  a multi-second event-loop block. It is cooperative - it cannot interrupt a
  native call that already started - which is why the two guards above bound
  every admitted native operation up front.

`boundOutput` charges top-level strings by the UTF-8 bytes in their verbatim host
representation and non-string values by compact JSON. It reserves truncation markers
inside `maxOutputBytes` for values and diagnostic messages, so runtime model-facing
content never exceeds the byte budget. Diagnostic and log accounting and pre-truncation
result observation stay separate from this representation choice. Covered by the output-budget
cases in `tests/codemode.test.ts` and the host integration test
`../tests/string-output-budget.test.ts`.

## Vendored-code exception

The original large interpreter is now extracted by responsibility. `PROVENANCE.md`
maps the local modules back to the original runtime rather than claiming the new
layout is an upstream copy. Keep source changes traceable through that map and
record later semantic adaptations separately. Existing TypeScript, Effect and
confinement deviations still apply across every extracted call site.

`SUPPORT.md` records the selective v2 semantics and their regression coverage,
without claiming a complete ECMAScript implementation.
Test262 assertions exist only in `tests/test262/runner.ts`; no test harness global,
host callback authority or host guest-code evaluator is installed in production.
