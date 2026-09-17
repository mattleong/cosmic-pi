# Provenance

This package vendors the OpenCode 2 Code Mode runtime so the `pi-code-mode`
extension is built on a host-neutral, independently reviewable core.

## Upstream origin

- Repository: <https://github.com/anomalyco/opencode> (`dev` branch)
- Pinned commit: `d4704347465c1ee63d0c213ed00e648e7f0231c5`
- Upstream package: `@opencode-ai/codemode` (workspace-private), version `1.18.16`
- Upstream path: `packages/codemode`
- License: MIT (Copyright (c) 2025 opencode). The full upstream notice is
  reproduced in `THIRD_PARTY_NOTICES.md`.

The upstream package's `interpreter/language-v1` wording and its `1.x` semver
refer to the Code Mode interpreter contract inside OpenCode 2; they are not the
legacy OpenCode product-v1 architecture.

## Included paths

Copied from upstream `packages/codemode`, preserving upstream file structure and
behavior for diffability:

- `src/index.ts` (OpenAPI export line removed; see exclusions)
- `src/codemode.ts`
- `src/tool.ts`
- `src/tool-error.ts`
- `src/tool-runtime.ts`
- `src/tool-schema.ts`
- `src/values.ts`
- `src/runtime-values.ts` (local type-narrowing support; see deviation 10)
- `src/failure.ts` (local closed Effect failure union; see deviation 6)
- `src/interpreter/model.ts`
- `src/interpreter/runtime.ts`
- `src/interpreter/guest-turns.ts` (local async scheduling; see deviation 13)
- `src/interpreter/group-by.ts` (local grouping callbacks; see deviation 14)
- `src/interpreter/set-operations.ts` (local Set operations; see deviation 17)
- `src/interpreter/json.ts` (local JSON callbacks and projection; see deviation 15)
- `src/stdlib/*.ts` (the twelve upstream modules plus local `epoch.ts`; see
  deviation 6)
- Behavioral portions of `test/codemode.test.ts`, plus `test/parity.test.ts`,
  `test/promise.test.ts`, and `test/stdlib.test.ts` (relocated to `tests/` per this
  repository's layout rules)

## Excluded paths

- `src/openapi/**` and `test/openapi.test.ts` (OpenAPI adapter is out of scope
  for the planned Pi integration; excluding it removes the HTTP client surface)
- `test/fixtures/**` (only used by the excluded OpenAPI suite)
- Catalog enumeration, signature-rendering, and public-contract-only cases from
  `test/codemode.test.ts`, `test/enumeration.test.ts`, and `test/signature.test.ts`
- Upstream `package.json`, `tsconfig.json`, `AGENTS.md`, `README.md`,
  `codemode.md`, `sst-env.d.ts` (replaced by workspace-native equivalents)
- All OpenCode host adapter/integration code outside `packages/codemode`

## Intentional local deviations

Deviations 1-7 and 10 are mechanical (behavioral semantics unchanged). Deviations 8-9
add confinement and observation. Deviations 11-17 add JavaScript compatibility and correct
mutation and async semantics; their behavior and remaining limits are documented below.

1. `src/index.ts` no longer exports `OpenAPI` (excluded subsystem).
2. Tests import from `@effect/vitest` instead of `bun:test` and live under
   `tests/` (repository rule) instead of `test/`; Node + Vitest replace Bun as
   the runner.
3. `effect` is consumed at the workspace-pinned `4.0.0-rc.112` instead of the
   upstream catalog `4.0.0-beta.83`; the RC migration renamed the local
   schema-backed `ToolError` base from `Schema.TaggedErrorClass` to
   `Schema.TaggedError`. The model-visible signature renderer also recognizes
   the RC's combined string enum for non-finite `Schema.Number` encodings while
   retaining compatibility with the earlier per-sentinel enum shape.
4. The workspace typechecks with `typescript@7.0.2`. Because TypeScript 7 does not expose the
   JavaScript compiler API, runtime transpilation imports the `typescript-compiler-api` alias pinned
   to TypeScript 6.0.3 instead of upstream's direct `typescript@5.8.2` dependency. This follows
   Microsoft's side-by-side guidance and keeps `transpileModule` behavior isolated from the
   workspace compiler. The alias exposes TypeScript 6's `tsc` binary, so the Code Mode package
   typecheck scripts call the root TypeScript 7 binary explicitly.
5. All files are formatted with the repository's `oxfmt` configuration
   (semicolons, wrapping); compare against upstream with a formatter-insensitive
   diff or by re-formatting the upstream files before diffing.
6. **Zero-suppression workspace adaptation (mechanical).** The runtime inherits
   the full workspace TypeScript and Effect language-service configuration. It
   has no disabled compiler checks, diagnostic overrides, lint exemptions, or
   source suppressions. The adaptation needed to meet that contract is
   formatter-insensitive and behavior-neutral:
   - Effect imports use package subpaths, local imports use `.js` specifiers,
     optional fields satisfy `exactOptionalPropertyTypes`, and unused
     parameters/locals and redundant spreads were removed.
   - TypeScript parameter properties became explicit fields and constructors so
     `erasableSyntaxOnly` remains enabled; the interpreter no longer aliases
     `this`.
   - `InterpreterRuntimeError` and `ToolRuntimeError` use `Data.TaggedError`,
     while `ProgramThrow` is a plain internal control carrier. `src/failure.ts`
     names the closed runtime failure union. Host effects are normalized through
     the existing safe `ToolError` boundary before entering that union. Guest
     `Error` objects, caught values, `instanceof`, interruption, and model-visible
     diagnostics keep their prior behavior.
   - Host lifecycle durations use the Effect `Clock`. Local
     `src/stdlib/epoch.ts` keeps guest `Date` wall-clock, `TimeClip`, host-zone,
     daylight-saving, and ISO behavior separate from host Effect timing,
     including native local-setter disambiguation for component-form dates.
   - Retained asynchronous Vitest cases use `@effect/vitest` with Effect-backed,
     non-`async` test bodies. Guest programs still exercise native JavaScript
     `async` and `Promise` semantics inside the interpreter.
7. Runtime public semantics and fixed constants are preserved: tool-call
   concurrency 8, data-boundary depth 32, no defaults for
   `timeoutMs`/`maxToolCalls`/`maxOutputBytes`, catalog budget default 2000.
   No Pi-specific source-size or cumulative-output limits were added.
8. **In-process confinement (deliberate, security-motivated).** Because this
   interpreter executes model-written programs in the host process, every
   synchronous native operation it delegates to must be bounded before it runs -
   a native call cannot be preempted by the Effect timeout once started, and the
   upstream `timeoutMs` alone therefore does not bound synchronous native work
   (catastrophic-backtracking regexes, unbounded string/collection growth, huge
   `JSON.stringify`/`console` output). The upstream runtime relied on the host
   process being disposable; a Pi extension shares the agent's event loop, so
   this is integration-blocking. The confinement is two new modules,
   `src/interpreter/confinement.ts` and `src/interpreter/regex-first-sets.ts`,
   plus call-site guards:
   - **Regex confinement.** A static pattern guard rejects unpreemptible
     constructions (backreferences, nested quantifiers, alternation inside a
     repeated group, ambiguous alternation whose branches can start on the same
     input character - the anchored `(a|aa)(a|aa)...b` family, screened by the
     conservative first-character analysis in `regex-first-sets.ts`, which also
     rejects empty branches and branches whose starting characters cannot be
     bounded, and charges every admitted alternation's branch count into the
     branch factor - inline flag-modifier groups (`(?i:...)`, `(?ims-ims:...)`),
     whose local flag semantics the flag-sensitive analysis does not model -
     quantified lookarounds, counted repeats over `{200}`, more
     than 8 optional quantifiers, a combined quantifier/alternation branch
     factor over 256, more than 3 unbounded quantifiers/lookarounds - the
     polynomial `/a*a*a*b/` family, whose members stall native matching for
     hundreds of milliseconds on subjects a few dozen characters long - the `v`
     flag, and patterns over 1000 chars). The scanner follows the engine's rule
     that the first `]` closes a character class (`[]` empty, `[^]` any), so
     class syntax cannot hide quantifiers from the analysis. Every admitted
     native match operation
     (`test`/`exec`/`match`/`matchAll`/`search`/`replace`/`replaceAll`/`split`)
     is additionally capped by subject length, scaled down by the pattern's
     residual backtracking degree (256K/2K/128/64; the admitted degree never
     exceeds the table) and divided by its combined branch factor, calibrated
     so the known hostile families' measured worst cases on current V8 stay in
     roughly the low tens of milliseconds - a calibration target, not a proven
     bound for every admissible pattern. This screen is deliberately
     conservative (it rejects some safe patterns) and does **not** claim
     mathematical preemption of native matching: the wall-clock deadline below
     remains cooperative, and an admitted native operation still runs to
     completion - the caps exist to keep that completion short.
   - **Amplification limits.** Fixed maxima for guest string length (4,194,304),
     collection entries (262,144), and captured log output (256 entries ×
     8,192 chars), enforced by preflight guards that project the output size and
     refuse the first overrun **before** the native allocation runs (an exact
     fit is admitted) wherever the projection is predictable:
     `repeat`/`padStart`/`padEnd`/`concat`/`+`/template literals/`join`/
     `replace` expansion/spread (string/Map/Set/URLSearchParams)/`push`/
     `unshift`/`splice`/`flatMap`/`flat` (counted projection)/`split` with a
     string separator (piece count)/array index assignment/`Array.from` (string
     length and array-like `length`, so a forged huge `length` is refused
     before allocation)/`Object.assign` and object-spread merge growth/`Map`/
     `Set`/`URLSearchParams` construction and every URLSearchParams
     materializing door (`entries`/`keys`/`values`/`getAll`/`forEach`/
     `toString`)/`Map.set`/`Set.add`/`URLSearchParams.append`+`set`/URL query
     pair counts (a conservative `&`-separator count over the query segment,
     fragment excluded, charged before `new URL`/`URL.parse`/`URL.canParse`,
     before `search`/`href` property writes, and as a backstop inside the
     SandboxURL wrapper before its eager `searchParams` access, so an over-cap
     query is refused before any native URLSearchParams materializes)/URI and
     URL percent-encoding expansion (`encodeURI(Component)`, URL construction
     and property writes, charged at a conservative 3x ASCII / 9x non-ASCII
     upper bound)/`JSON.stringify` estimate. Where a projection cannot be known
     without running the operation, the operation's materialization is itself
     linearly bounded by an already-capped input (`JSON.parse` over a capped
     string; regex `split` and `matchAll`, whose match counts are bounded by
     the admitted subject cap - regex `split` additionally clamps the native
     limit to the entry cap) and the result is re-checked against the entry cap
     and at the shared data checkpoint (`copyIn`) and string-coercion budget -
     a bounded post-check, not a preflight.
   - **Wall-clock deadline.** A shared `ExecutionDeadline` is checked between
     interpreter steps (statement/expression entry) and after the run, so an
     overrun inside synchronous native work is normalized to the same
     `TimeoutExceeded` diagnostic instead of racing the event-loop-starved timer.
     The deadline is **cooperative**: it cannot interrupt a native call that has
     already started, which is why every admitted native operation above is
     bounded up front.
   - **Final output bound.** `boundOutput` now reserves its truncation markers
     _inside_ `maxOutputBytes` for both the value and the diagnostic message (a
     hostile thrown string is bounded too), so the runtime's model-facing content
     never exceeds the byte budget.

   The retained upstream behavioral suites are unchanged and still pass (their patterns
   and sizes are within the confinement envelope); the new behavior is covered by
   `tests/confinement.test.ts` and updated `tests/codemode.test.ts` output-budget
   cases (both marked as local, non-upstream). A resync (below) must re-apply
   these guards.

9. **Additive tool lifecycle observation.** The optional `onToolCallLifecycle`
   callback reports each eagerly forked call as `queued`, `running`, then exactly
   one of `succeeded`, `failed`, or `cancelled`, with a stable execution-local id
   and bounded wall-clock durations. Queue admission is observed before the fixed
   concurrency-8 semaphore; interruption from timeout, host cancellation, or a
   losing `Promise.race` reports cancellation. Existing `onToolCallStart` and
   `onToolCallEnd` payloads and post-permit semantics remain unchanged when the
   new callback is absent. This powers live Pi UI status only and never changes a
   guest-visible result. Covered by local lifecycle tests in
   `tests/codemode.test.ts` and `tests/promise.test.ts`.
10. **Closed interpreter value domain (mechanical typing deviation).** The local
    source now models guest values with the explicit recursive `InterpreterValue`,
    `InterpreterObject`, and `InterpreterArray` domain, plus typed sandbox
    functions, promises, and tool references. AST nodes remain a separate recursive
    domain rather than being laundered through guest values. Null-prototype object
    creation is centralized, and evaluator/member mutation, `copyIn`/`copyOut`,
    sandbox containers, and standard-library argument paths carry the closed value
    types end to end. Primitive refinements import `effect/Predicate` directly;
    `src/runtime-values.ts` retains only the composite object-or-null check and exact
    type-name classifier. This replaces upstream-style open `unknown` dictionaries
    and assertions only; guest-visible values, wire formats, execution order, and
    interpreter behavior are unchanged. A resync must preserve the AST/value
    separation and reapply the closed-domain annotations after reviewing upstream
    model changes.

11. **Array.from mapper overload (additive compatibility).** `Array.from(source, mapper)`
    uses the interpreter's existing function, coercion, and URI callback execution paths.
    It passes exactly the value and zero-based index, retains returned interpreter promises
    and functions, and does not implicitly await returned tool promises. An omitted or
    explicitly undefined mapper keeps the existing unmapped conversion. Nonundefined
    `thisArg` is rejected because the interpreter does not implement `this` binding.
    Arrays, Map, Set, and URLSearchParams use live native iterators; strings use Unicode
    code points. Array-like inputs retain the existing numeric-length requirement, capture
    the normalized length once, and read original indexed values between callbacks.
    Existing source validation remains in place without substituting a copied source.
    Collection preflight runs before mapping; each produced entry is checked before its
    mapper can execute, and every iteration checks the cooperative deadline. This bounds
    self-extending iterators even when deletions keep the source collection small. Initial
    over-cap inputs are refused even if a mapper could shrink them. No native callback,
    custom guest iterator, dynamic `this`, or new tool authority is introduced. Covered by
    the local `tests/array-from.test.ts` suite.

12. **Collection and object compatibility.** `Object.assign` mutates and returns its
    original target. Sources are validated without replacing shallow references; guarded
    runtime writes reject cycles, blocked keys, invalid array properties, and over-cap growth
    before insertion. `Object.values`, `Object.entries`, and `Object.hasOwn` accept arrays,
    skip holes where enumerable entries are required, and preserve member identity.
    `reverse` and `sort` mutate and return the original array; copying variants do not.
    Sort retains the bounded interpreter merge sort, skips undefined comparator arguments,
    preserves holes and comparator-appended elements, and rechecks cycles before write-back.
    Array literals now preserve holes; `join` charges separators from array length before
    allocation, even for holes, and admits exact-fit output. `toSpliced` produces a dense,
    shallow copy with omission-aware argument normalization and projected growth checks.
    `split(undefined, limit)` uses the normalized unsigned limit. Existing data-only and
    numeric-argument restrictions remain. Covered by `tests/object-compat.test.ts` and
    `tests/javascript-compat.test.ts`; the unsupported-method parity fixture now uses an
    actually unsupported array method.

13. **Async functions and promise scheduling.** Function activations have isolated evaluator
    stacks with shared captured bindings. Async calls return distinct promises after their
    synchronous prefix, reject on throws, adopt returned promises, and reject direct
    self-resolution. Combinators return eager promises rather than blocking their caller.
    `interpreter/guest-turns.ts` provides bounded FIFO turns, including interruption-safe
    handoff: the Effect semaphore alone permits newly arriving jobs to overtake waiters.
    Promise reactions publish logical settlement within their turn, independently of fiber
    cleanup. Adoption registers its follow-up reaction before releasing its job's turn.
    Ordinary strict equality compares opaque interpreter values by identity without making
    them serializable. Async sort callbacks are not awaited; promise-valued string replacers
    stringify as `[object Promise]` without hiding unhandled rejections.

    One execution scope owns async and tool fibers; activation completion does not cancel
    fire-and-forget tools. The shared, admission-bounded ledger drops completed successes,
    drains continuations until quiescent, and reports failures still unobserved afterward.
    Tool concurrency and lifecycle identifiers remain shared across activations. Existing
    race-loser cancellation extends to descendants of completed activations, excludes
    activation ancestors and duplicate winners, and guards re-entrant cancellation to avoid
    mutual interruption waits. Timeout and host cancellation close the execution scope.
    Custom thenables/iterators and `this` binding remain unsupported. Chaining and `any`
    are added in deviation 16.
    Covered by local async-function and async-scheduling suites, including reaction-order,
    cancellation, and scope-isolation regressions. Earlier tests that expected awaited
    string replacers were corrected; Array.from async tests now explicitly consume their
    mapped promises.

14. **Grouping helpers.** `interpreter/group-by.ts` implements `Object.groupBy` and
    `Map.groupBy` over supported live iterables, with value/index callbacks and shallow
    identity preservation. Object groups use null-prototype records and reject blocked keys;
    Map groups retain SameValueZero keys, including opaque functions and promises. Callbacks
    are not implicitly awaited. Source, visited-entry, bucket-growth, and deadline checks
    bound self-extending iteration. Shared string coercion charges Date and object-tag text,
    plus exact array separator counts, before joining grouping keys. Covered by
    `tests/group-by.test.ts`.

15. **JSON replacers and revivers.** `interpreter/json.ts` replaces synchronous JSON
    evaluation; `stdlib/json.ts` retains synchronous native syntax/encoding primitives and the
    method allowlist. Stringify accepts property-name
    arrays and callable replacers. Parse invokes bottom-up revivers, preserving returned
    references and sparse deletions. Shared interpreter callable dispatch never invokes guest
    callbacks as host functions or implicitly awaits them. Built-in Date/URL conversion occurs
    before replacers; promises serialize as `{}` without observing rejection.

    Null-prototype, own-property-only projections prevent inherited host-property access.
    Blocked keys remain refused. Exact UTF-16 output preflight charges escaping and indentation,
    replacing the earlier conservative estimate. Depth/cycle checks and a bounded traversal
    count cover callback-produced graphs and property-list lookups, including empty opaque
    projections. Excluded branches are not materialized. Guest `this`, custom `toJSON`, and
    reviver source contexts remain unsupported. Covered by `tests/json-callbacks.test.ts` and
    updated confinement/promise tests.

16. **Promise chains and first fulfillment.** `then`, `catch`, and `finally` use execution-owned
    FIFO reactions, adoption jobs, and logical settlements. Returned chains track their own
    unhandled failures; passthrough handlers, cleanup overrides, and direct self-resolution
    follow native behavior. All existing callable references share ordinary call dispatch.
    `Promise.any` resolves on first fulfillment or rejects with an `AggregateError` containing
    original rejection values in input order. It does not cancel losers on fulfillment while
    guest execution continues; normal execution teardown still cancels pending observed work.
    `AggregateError` supports construction with or without `new`, Error branding, nonenumerable
    `errors`, and optional nonenumerable `cause`. Custom thenables/iterators and the Promise
    constructor are not added. Covered by `tests/promise-chaining.test.ts` and
    `tests/promise-any.test.ts`, including native scheduling comparisons, cancellation, and
    descendant cleanup.

17. **Callback consistency and Set operations.** Array callbacks, Array.from mappers,
    sort comparators, collection forEach, and string replacers share callable detection and
    interpreter dispatch with promise/grouping/JSON callbacks. This admits existing builtin,
    intrinsic, and tool references without invoking guest code as host functions. Callback
    arguments, nonawaited promise results, tool input checks, and mutation guards remain;
    callback loops check deadlines before dispatch. Fixed-arity Math methods ignore unused
    callback arguments, so `.map(Math.floor)` works; consumed arguments still require numbers.

    `interpreter/set-operations.ts` adds union, intersection, difference, symmetricDifference,
    and subset/superset/disjoint predicates over owned Set and Map wrappers. Map operands
    contribute keys, not entries. Exact output preflight admits overlapping full-size inputs;
    source checks bound copy/delete difference before allocation. Traversals check deadlines,
    preserve native ordering and SameValueZero member identity, and leave operands unchanged.
    Custom set-like objects are refused. Covered by `tests/callback-compat.test.ts` and
    `tests/set-operations.test.ts`.

## Resync policy

Upstream updates are pulled by pinned manual review only:

1. Pick a new upstream commit explicitly; never track a moving branch.
2. Diff upstream `packages/codemode` between the old and new pinned commits and
   review every hunk (security posture: this code interprets model-generated
   programs).
3. Re-apply the mechanical deviations above, **the deviation-8 confinement**
   (`confinement.ts` and its call-site guards), **the deviation-9 lifecycle
   hook**, **the deviation-10 closed interpreter value domain**, and **deviations 11-17
   for JavaScript compatibility and async execution**; do not adopt upstream OpenAPI or
   host-adapter code. Re-run the confinement, lifecycle, and compatibility tests.
4. Update the pinned commit here, then run the full package and workspace
   validation gates.
