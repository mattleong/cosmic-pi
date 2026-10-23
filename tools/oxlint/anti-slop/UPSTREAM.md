# anti-slop provenance

Vendored from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`13909c9e07590f5a85d93c62712259fe14a883f7` (2026-10-13). Upstream `src/rules` and `src/shared` live in
`rules/` and `shared/`; upstream `src/effect` lives in `effect/` and is registered as the separate
`anti-slop-effect` plugin, enabled for `packages/**` and `scripts/**` (the lint plugin itself does
not use Effect). Files are formatted with the workspace oxfmt settings.

The vendored production files retain upstream behavior except the documented local hardening.
`no-module-mocking` additionally resolves namespace imports, `@effect/vitest`, and immutable aliases
through lexical import identity; unrelated and shadowed APIs remain valid. Local type-only
adjustments let the plugin pass its own rules (`no-runtime-typeof`, `no-param-reassign`,
`prefer-optional-chain`, `no-underscore-dangle`).
`no-manual-tagged-construction` also allows the object passed as the first argument to Effect's
`PlatformError.systemError(...)` and `new PlatformError.SystemError(...)`, whose public API takes the
system error tag as an argument field.

Local policy changes to vendored rules:

- `no-array-filter-map` recommends one `effect/Array` pass (`Array.filterMap`, `Array.partition`,
  `Array.getSomes`) instead of iterator helpers, which the workspace `ES2023` library lacks.
- `no-runtime-typeof` recommends Effect `Predicate` guards or Schema decoding.
- `no-manual-tag-comparison` also reports optional chains such as `value?._tag === "A"`, and no
  longer exempts broad `Effect.catch` handlers.
- `no-unknown-parameters` allows an `unknown` parameter whose first read passes it straight to
  `Schema.decodeUnknown*(schema)` or `Schema.is(schema)`, directly or through a `const` alias.

Upstream walks visitor-key properties through an untyped record to collect type bindings and
`infer` declarations. Locally, `shared/type-alias-resolution.ts` and
`shared/lexical-type-parameters.ts` find those declarations through tokens and
`getNodeByRangeIndex` instead, so they need no type assertion; both take the `SourceCode` rather
than its visitor keys. `shared/scope.ts` owns the lexical `resolveVariable` walk for upstream and
local rules alike; `shared/ast.ts` holds the remaining helpers used by local rules.

Upstream rules with a native Oxlint equivalent were removed in favor of the native rule:
`no-reflect-get` and `no-reflect-apply` became `eslint/no-restricted-properties` entries, and
Oxlint's `typescript/consistent-type-assertions` with `assertionStyle: "never"` bans every type
assertion except `as const`. That ban made `no-chained-type-assertions`, `no-widen-then-assert`,
and `require-safety-comment-for-type-assertion` unreachable, so they were removed too.
`no-manual-effect-error-tag` was replaced by the type-aware `@effect/tsgo` diagnostics
`catchAllTagDispatchToCatchTag`, `catchIfTagToCatchTag`, and `catchTagToCatchReason`.
`no-conditional-empty-object-spread` was removed because it only exchanged one conditional-spread
spelling for another.

Oxlint's `promise/valid-params` is off: it matches Promise method names on any receiver, so
Effect's data-first `Effect.catch(effect, handler)` reads as `Promise.catch()` with two arguments.
TypeScript already checks Effect and Promise signatures. `promise/catch-or-return` stays on; it
misreads only a discarded expression statement such as `Effect.catch(...).pipe(...);`, which is
already a floating Effect.

Upstream presentation rules are not vendored because they constrain presentation rather than
protecting correctness: `no-shape-in-symbol-names` (identifier spelling) and
`require-readable-spacing` (blank-line layout, with its vendored eslint-stylistic dependency).
oxfmt owns formatting.

Tests for the retained upstream rules remain, with local baseline coverage added where upstream
had none, so Oxlint and `@oxlint/plugins` upgrades can be verified against the vendored behavior.

Upstream is MIT-licensed; see [LICENSE](./LICENSE).

## Local regression rules

Workspace-owned rules supplement the upstream rules where no native Oxlint rule can express the
policy. They run as errors in regular `pnpm lint` and
use Oxlint's AST and lexical scopes. They report without fixes because each finding needs an author's decision:

- **`no-callable-type-predicate`** (package `src/` only, not `src/testing`) reports a type predicate,
  or a `Schema.declare<T>` guard, whose only evidence for a claimed callable is a callability check:
  `Predicate.isFunction`, `typeof x === "function"`, `instanceof Function`, or
  `Function.prototype.isPrototypeOf`. The check may target the subject or a static member path of it;
  the claimed type at that path counts as callable when it is a function or constructor type, has a
  call signature or method, or is opaque (a type parameter, imported or nested type, or computed
  type). Same-file top-level aliases and interfaces are resolved; the subject's own type parameter
  in `V & T`, `Function`, and members the claim does not declare remain valid. Admit callbacks
  with pi-cosmic-core's `ForeignCallable` and decode the result; its implementation file is
  exempt through an exact-file override. Because opaque types count as callable, a duck-typed
  check of a host class instance, such as a callability check of its methods, is reported;
  verify it with `instanceof` or `Schema.instanceOf` instead.
- **`no-eager-effect-finalizer-condition`** catches a conditional/logical `Effect.ensuring`
  decision that reads a binding mutated by a callback in its wrapped Effect pipeline. Defer the
  decision with `Effect.suspend`. Immutable decisions and reads inside lazy callbacks are valid.
  Analysis follows bounded immutable finalizer aliases and known Effect compositions, including
  `try`/`tryPromise`, `forEach`, and literal/aliased `all` collections with statically known property
  overrides. Alias traversal follows lexical read references, not property names. Callback positions live in
  `shared/finalizer-operations.ts`; arbitrary helpers and object-property mutations are not analyzed.
- **`no-escaping-render-context`** catches whole `renderCall`/`renderResult` contexts retained by
  known deferred/component helpers or returned component methods. Capture needed fields first.
  Closures share their scope, so a capture by an immediate callback also counts when an escaping
  closure is created in the same function. It follows immutable aliases, known builders, and the
  whole context passed to same-file helpers, not imported helpers, classes, or wrappers. Its
  helper table lists exact callback positions; linting each definition verifies them, and the
  rule test fails when a definition moves.
- **`no-lossy-expanded-arguments`** catches lossy or unescaped text in expanded tool output.
  Imported `stripTerminalControls` or `stripAnsi` output is reported when it reaches
  `theme.fg("toolOutput", ...)` anywhere, `theme.fg("error", ...)` inside a `renderCall` or
  `renderResult`, or, for serialized `renderCall` arguments, a pi-tui `Text` or the renderer's
  return. Raw `JSON.stringify(args)` of renderer arguments reaching those sinks is also reported,
  because it keeps C1 controls. Text flows through immutable `const` aliases, conditional branches,
  templates, concatenation, and theme styling, not through other calls. Arguments resolve through
  one same-file helper and `invokeHostCallback`; a renderer is a `renderCall`/`renderResult`
  property or a function bound to one. Prefer `expandedArguments` or `escapeControlChars`. Collapsed
  summaries, issues, notifications, logs, other colors, and test fakes under `tests/` remain valid.
- **`no-manual-abort-listener`** rejects `addEventListener("abort", ...)` member calls. Pass the
  signal to Effect with `runPromise(effect, { signal })`, or forward it with pi-cosmic-core's
  `forwardAbortSignal`. The rule exempts the pi-cosmic-core runtime files that implement signal
  forwarding; test fakes can wait with `Effect.runPromiseExit(Effect.never, { signal })`.
- **`no-raw-host-notify`** rejects `<expr>.ui.notify(...)` calls, including optional chains. Route
  notifications through `notifyAtHostBoundary` from pi-cosmic-core. The rule exempts the core
  `host-session.ts` implementation; reading or replacing a `ui.notify` spy remains valid.
- **`no-runtime-type-only-tests`** rejects Vitest type assertions, imported from `vitest` or
  `@effect/vitest`, inside runtime test callbacks, and direct import/declaration-spelling
  assertions against statically identified production source reads. Top-level type assertions,
  Vitest `*.test-d.ts` typecheck files, parser/compiler behavior, packaging execution, and runtime
  file-content assertions remain valid. This is not a general test-quality classifier or
  source-architecture scanner.
- **`require-code-preview-shell`** requires every `<host>.registerTool(definition)` call to receive
  a definition produced by `withCodePreviewShell` from `pi-code-previews` or by the `shell` of
  `registerCodePreviewReplay`. It accepts direct calls, `const` aliases, a parameter that defaults
  to or is typed as `typeof withCodePreviewShell`, a same-file helper that returns a wrapped
  definition, and an object that spreads one when no later spread or renderer field overrides it.
  Bounded registration aliases include destructuring and `bind`, preserving pre-bound definitions.
  `shared/shell-mutations.ts` tracks direct renderer writes/deletes and global `Object.assign`
  mutations through immutable object aliases and mutated assignment sources until their propagation
  settles; execution-only changes and unrelated objects remain valid. Mutation analysis is file-local
  and conservative, not flow-sensitive.
  Code Previews' write hook in `src/tools/renderers/registration.ts` and files under `tests/` are
  exempt.
- **`anti-slop-effect/prefer-effect-fn`** (package `src/` only) reports a named function whose
  body is exactly `Effect.gen(function* ...)`, optionally followed by `.pipe(...)` calls: a
  function declaration, or a function bound to a variable, object-literal member, or class field.
  `gen` resolves through its `effect/Effect` import, including renamed namespace and named
  imports. Define it with `Effect.fn("Owner.name")`, or `Effect.fnUntraced` on hot paths, passing
  pipe steps as further arguments; `Effect.fn` preserves generic signatures. Inline callbacks
  passed positionally, async and generator functions, bodies with eager statements before
  `Effect.gen`, overloaded declarations (including inside namespaces and `export default`),
  accessors and class methods, and `Effect.gen({ self: this }, ...)` remain valid.
- **`anti-slop-effect/no-effect-runner-imports`** (package `src/` only) rejects named imports and
  re-exports of `run*` runners from `effect/Effect`, closing the gap in the `run*` property ban.
  `eslint/no-restricted-imports` cannot express it: with `importNames` or `importNamePattern` it
  also rejects every `import * as Effect` namespace import. Type-only imports remain valid, and
  the property ban's boundary files are exempt.

The local rules share import, alias, and function resolution from `shared/ast.ts`, and the
boundary rules match their exempt files through `shared/workspace-path.ts`; rule policy
stays in each rule. Each local rule has regression and false-positive fixtures alongside it. `pnpm test:anti-slop` and
`pnpm typecheck:anti-slop` cover both upstream and local rules; both also run through validation.
