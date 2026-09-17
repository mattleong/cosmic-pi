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
  index.ts              # public barrel: CodeMode, Tool, ToolError/toolError
  codemode.ts           # public CodeMode namespace: make/execute, schemas, types
  failure.ts            # closed internal RuntimeFailure union
  tool.ts               # Tool.make and tool definition types
  tool-error.ts         # ToolError: safe model-visible tool refusal
  tool-runtime.ts       # tool tree walking, catalog/search/instructions, limits,
                        # data-boundary copying, diagnostics + lifecycle types (internal)
  tool-schema.ts        # Effect Schema / JSON Schema signature rendering (internal)
  values.ts             # sandbox value wrappers (Date, RegExp, Map, Set, URL, promises)
  runtime-values.ts     # owned runtime-type predicates used instead of host `typeof`
  interpreter/
    model.ts            # interpreter AST/diagnostic model (internal)
    guest-turns.ts      # LOCAL FIFO guest-continuation and promise-reaction scheduling
    group-by.ts         # LOCAL bounded live grouping with interpreter callbacks
    json.ts             # LOCAL JSON callbacks, projection, and exact output preflight
    runtime.ts          # Acorn-based tree-walk interpreter (internal, vendored large file)
    confinement.ts      # LOCAL (non-upstream) in-process confinement: regex guard +
                        # subject caps, amplification limits, wall-clock deadline
    regex-first-sets.ts # LOCAL (non-upstream) conservative alternation first-character
                        # analysis used by the confinement regex guard
  stdlib/               # confined standard-library surfaces (internal)
    collections.ts  console.ts  date.ts  epoch.ts  json.ts  math.ts
    number.ts  object.ts  promise.ts  regexp.ts  string.ts  url.ts  value.ts
tests/                  # ported upstream behavioral suites (Effect-backed Vitest)
```

## Public boundary

The only public entry is `src/index.ts` (`pi-code-mode-runtime` package export):

- `CodeMode` - `make`, `execute`, result/diagnostic schemas and types, plus optional
  queued/running/terminal tool-call lifecycle observation.
- `Tool` - `make`, `Definition`, `Options`, `SchemaType`, `JsonSchema`.
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

## Fixed runtime policy

- Tool-call concurrency is a fixed constant 8; data-boundary depth is a fixed
  constant 32. Neither is a public knob.
- `timeoutMs`, `maxToolCalls`, and `maxOutputBytes` have no defaults - execution
  budgets are host policy. The discovery catalog budget defaults to 2000
  estimated tokens.
- No Pi-specific limits (program source size, cumulative child output) live in
  this package; a Pi host applies those above this boundary.

`Array.from(source, mapper)` is a local compatibility addition in `interpreter/runtime.ts`.
Mappers use existing interpreter callback execution, not host JavaScript callbacks. Live
collection iteration and fixed-length array-like reads preserve source mutations. Source
preflight, per-entry collection checks before mapper execution, and cooperative deadline
checks bound self-extending iteration. Returned tool promises remain unawaited values.
Nonundefined `thisArg` remains unsupported. See `PROVENANCE.md` deviation 11.

## Guest functions and promises

Each function invocation has its own evaluator stack while captured binding maps remain
shared. Async functions return distinct promises after their synchronous prefix. One execution
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
custom iterators, `this` binding, and the Promise constructor remain unsupported.
See deviations 13 and 16.

Object helpers validate without replacing shallow references. `Object.assign`, `reverse`,
and `sort` mutate their targets; assignment and sort write-back retain cycle and growth
guards. Sparse literals preserve holes, with separator preflight charging holes in `join`.
Copying array variants stay nonmutating. See deviation 12 and the compatibility tests.

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
  Regex `split` and `matchAll` results are bounded post-checks, not preflights:
  the admitted subject cap bounds the match count (and the native `split` limit
  clamps materialization to the entry cap) before the entry cap is applied.
- **Deadline** - a shared `ExecutionDeadline` checked between interpreter steps
  and after the run normalizes a synchronous overrun to `TimeoutExceeded` without
  a multi-second event-loop block. It is cooperative - it cannot interrupt a
  native call that already started - which is why the two guards above bound
  every admitted native operation up front.

`boundOutput` reserves its truncation markers inside `maxOutputBytes` (value and
diagnostic message alike), so runtime model-facing content never exceeds the
byte budget. Covered by `tests/confinement.test.ts`.

## Vendored-code exception

`src/interpreter/runtime.ts` (~5k lines) and other vendored files
intentionally exceed the repository's soft file-size guidance and keep upstream
structure, naming, and style. Do not refactor them for local conventions:
upstream comparability is the safety property that keeps pinned manual resyncs
reviewable. Mechanical deviations, including the zero-suppression TypeScript
and Effect adaptation, and the deliberate confinement deviation are enumerated
in `PROVENANCE.md`. The confinement guards added into the vendored files are
single call-site lines that delegate to `confinement.ts`, so an upstream diff
stays readable.
