# pi-code-mode-runtime architecture

Host-neutral confined code execution over explicit, schema-described tools,
vendored from OpenCode 2 Code Mode (see `PROVENANCE.md` for origin, license, and
resync policy). A model-written JavaScript program is TypeScript-transpiled,
Acorn-parsed, and tree-walk interpreted; generated code is never passed to
`eval`, `Function`, `node:vm`, or a child JavaScript runtime. Programs can only
call the tools the host supplies.

This package is workspace-private and host-neutral: it has no Pi imports and no
Pi-specific policy. It is nested inside the public `pi-code-mode` package
directory so its built `dist/` output (tsdown: `dist/index.js` +
`dist/index.d.ts`) ships inside the `pi-code-mode` tarball; `pi-code-mode`
consumes it exclusively through the relative-path boundary door
`src/boundary/codemode-runtime.ts`. The `pi-code-mode` extension owns every
Pi-facing concern above this boundary: the outer `code_mode` agent tool, the
`tools.pi.read/grep/find/ls` adapters, and the Pi host limits (program source
size, cumulative nested output).

## Source map

```text
src/
  index.ts              # public barrel: CodeMode, Tool, ToolError/toolError
  codemode.ts           # public CodeMode namespace: make/execute, schemas, types
  tool.ts               # Tool.make and tool definition types
  tool-error.ts         # ToolError: safe model-visible tool refusal
  tool-runtime.ts       # tool tree walking, catalog/search/instructions, limits,
                        # data-boundary copying, diagnostics (internal)
  tool-schema.ts        # Effect Schema / JSON Schema signature rendering (internal)
  values.ts             # sandbox value wrappers (Date, RegExp, Map, Set, URL, promises)
  interpreter/
    model.ts            # interpreter AST/diagnostic model (internal)
    runtime.ts          # Acorn-based tree-walk interpreter (internal, vendored large file)
    confinement.ts      # LOCAL (non-upstream) in-process confinement: regex guard +
                        # subject caps, amplification limits, wall-clock deadline
    regex-first-sets.ts # LOCAL (non-upstream) conservative alternation first-character
                        # analysis used by the confinement regex guard
  stdlib/               # confined standard-library surfaces (internal)
    collections.ts  console.ts  date.ts  json.ts  math.ts  number.ts
    object.ts  promise.ts  regexp.ts  string.ts  url.ts  value.ts
tests/                  # ported upstream behavioral suites (Vitest)
```

## Public boundary

The only public entry is `src/index.ts` (`pi-code-mode-runtime` package export):

- `CodeMode` - `make`, `execute`, result/diagnostic schemas and types.
- `Tool` - `make`, `Definition`, `Options`, `SchemaType`, `JsonSchema`.
- `ToolError` / `toolError` - the explicit safe-message failure channel.

Everything else (`tool-runtime.ts`, `tool-schema.ts`, `values.ts`,
`interpreter/`, `stdlib/`) is internal; tests may reach into internals exactly
where the upstream suites do (`ToolRuntime.copyOut`).

## Fixed runtime policy

- Tool-call concurrency is a fixed constant 8; data-boundary depth is a fixed
  constant 32. Neither is a public knob.
- `timeoutMs`, `maxToolCalls`, and `maxOutputBytes` have no defaults - execution
  budgets are host policy. The discovery catalog budget defaults to 2000
  estimated tokens.
- No Pi-specific limits (program source size, cumulative child output) live in
  this package; a Pi host applies those above this boundary.

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

`src/interpreter/runtime.ts` (~3.9k lines) and other vendored files
intentionally exceed the repository's soft file-size guidance and keep upstream
structure, naming, and style. Do not refactor them for local conventions:
upstream comparability is the safety property that keeps pinned manual resyncs
reviewable. Mechanical deviations, and the deliberate confinement deviation, are
enumerated in `PROVENANCE.md`. The confinement guards added into the vendored
files are single call-site lines that delegate to `confinement.ts`, so an
upstream diff stays readable.
