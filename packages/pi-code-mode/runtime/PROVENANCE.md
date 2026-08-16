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
- `src/interpreter/model.ts`
- `src/interpreter/runtime.ts`
- `src/stdlib/*.ts` (all twelve modules)
- `test/codemode.test.ts`, `test/enumeration.test.ts`, `test/parity.test.ts`,
  `test/promise.test.ts`, `test/signature.test.ts`, `test/stdlib.test.ts`
  (relocated to `tests/` per this repository's layout rules)

## Excluded paths

- `src/openapi/**` and `test/openapi.test.ts` (OpenAPI adapter is out of scope
  for the planned Pi integration; excluding it removes the HTTP client surface)
- `test/fixtures/**` (only used by the excluded OpenAPI suite)
- Upstream `package.json`, `tsconfig.json`, `AGENTS.md`, `README.md`,
  `codemode.md`, `sst-env.d.ts` (replaced by workspace-native equivalents)
- All OpenCode host adapter/integration code outside `packages/codemode`

## Intentional local deviations

Deviations 1-7 and 10 are mechanical (behavioral semantics unchanged). Deviations 8-9
are deliberate local behavior layered on top of the vendored interpreter; they are
confined to the additions listed there and do not alter upstream execution results.

1. `src/index.ts` no longer exports `OpenAPI` (excluded subsystem).
2. Tests import from `vitest` instead of `bun:test` and live under `tests/`
   (repository rule) instead of `test/`; Node + Vitest replace Bun as the runner.
3. `effect` is consumed at the workspace-pinned `4.0.0-rc.108` instead of the
   upstream catalog `4.0.0-beta.83`; the RC migration renamed the local
   schema-backed `ToolError` base from `Schema.TaggedErrorClass` to
   `Schema.TaggedError`. The model-visible signature renderer also recognizes
   the RC's combined string enum for non-finite `Schema.Number` encodings while
   retaining compatibility with the earlier per-sentinel enum shape.
4. `typescript` is consumed at the workspace-pinned `6.0.3` instead of the
   upstream catalog `5.8.2`; no source changes were required.
5. All files are formatted with the repository's `oxfmt` configuration
   (semicolons, wrapping); compare against upstream with a formatter-insensitive
   diff or by re-formatting the upstream files before diffing.
6. `tsconfig.json` relaxes `erasableSyntaxOnly`, `exactOptionalPropertyTypes`,
   `noUnusedLocals`, and `noUnusedParameters` and disables five Effect
   language-service diagnostics (`anyUnknownInErrorContext`, `asyncFunction`,
   `extendsNativeError`, `globalDate`, `importFromBarrel`) for this package
   only, so upstream sources typecheck verbatim. `.oxlintrc.json` likewise
   disables four stylistic lint rules that the vendored style trips.
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

   The upstream behavioral suites are unchanged and still pass (their patterns
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

## Resync policy

Upstream updates are pulled by pinned manual review only:

1. Pick a new upstream commit explicitly; never track a moving branch.
2. Diff upstream `packages/codemode` between the old and new pinned commits and
   review every hunk (security posture: this code interprets model-generated
   programs).
3. Re-apply the mechanical deviations above, **the deviation-8 confinement**
   (`confinement.ts` and its call-site guards), **the deviation-9 lifecycle
   hook**, and **the deviation-10 closed interpreter value domain**; do not adopt
   upstream OpenAPI or host-adapter code. Re-run the confinement and lifecycle
   tests.
4. Update the pinned commit here and in `docs/adr/0003-code-mode-runtime.md`,
   then run the full package and workspace validation gates.
