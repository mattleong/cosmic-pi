# anti-slop provenance

Vendored from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`446268e5d15baa968eaec669ff65358d36ae6259` (2026-08-14).

The vendored production files retain upstream behavior except the documented local hardening.
`no-module-mocking` additionally resolves namespace imports, `@effect/vitest`, and immutable aliases
through lexical import identity; unrelated and shadowed APIs remain valid. Local type-only adjustments let the plugin
pass its own rules. Identical scope lookup, parameter annotation unwrapping, function node types,
and alias-name lookup mechanics are extracted into `shared/ast.ts`; rule policy stays local. The
unused upstream helper `isPopulatedObjectExpression` was dropped from `shared/dictionary-types.ts`.

Upstream files were also edited to satisfy workspace lint policy without changing behavior: all
comments were removed, functions above the complexity limit were split into helpers, and
`shared/lexical-type-parameters.ts` finds `infer` declarations through tokens instead of an untyped
visitor-key walk, so it needs no type assertion.

Upstream rules with a native Oxlint equivalent were removed in favor of the native rule:
`no-reflect-get` and `no-reflect-apply` became `eslint/no-restricted-properties` entries, and
Oxlint's `typescript/consistent-type-assertions` with `assertionStyle: "never"` bans every type
assertion except `as const`. That ban made `no-chained-type-assertions`, `no-widen-then-assert`,
and `require-safety-comment-for-type-assertion` unreachable, so they were removed too; `no-comments`
also bans the comment the last one required.

The upstream rule tests are retained, with local baseline coverage added for the upstream rules
that had no tests, so Oxlint and `@oxlint/plugins` upgrades can be verified against the vendored
behavior.

Upstream is MIT-licensed; see [LICENSE](./LICENSE).

## Local regression rules

Workspace-owned rules supplement the upstream rules where no native Oxlint rule can express the
policy. They run as errors in regular `pnpm lint` and
use Oxlint's AST and lexical scopes. Only `no-comments` offers an automatic fix; the others report
without fixes because each finding needs an author's decision:

- **`no-comments`** rejects every line, block, and JSDoc comment except a shebang. Names, types,
  and tests carry intent instead. Its fix removes empty comment lines while retaining token separators
  and embedded line terminators needed for parsing and automatic semicolon insertion.
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
- **`no-legacy-names`** rejects identifiers, including properties, type names, and private names,
  that contain `legacy`, `deprecated`, or a back/backward/backwards-compat word. The workspace keeps
  no backwards-compatibility paths: delete the old path or rename it for its current role. A bare
  `compat`, as in `model.compat`, remains valid.
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
  signal to Effect with `runPromise(effect, { signal })`, or use the shared adapter in
  `pi-cosmic-ui/src/boundary/host-abort-signal.ts`. The rule exempts that adapter and the
  pi-cosmic-core runtime files that implement signal forwarding; test fakes can wait with
  `Effect.runPromiseExit(Effect.never, { signal })`.
- **`no-raw-host-notify`** rejects `<expr>.ui.notify(...)` calls, including optional chains. Route
  notifications through `notifyAtHostBoundary` from pi-cosmic-core. The rule exempts the core
  `host-session.ts` and `usage-controller.ts` implementations; reading or replacing a
  `ui.notify` spy remains valid.
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

The local rules share import, alias, and function resolution from `shared/ast.ts`, and the
boundary rules match their exempt files through `shared/workspace-path.ts`; rule policy
stays in each rule. Each local rule has regression and false-positive fixtures alongside it. `pnpm test:anti-slop` and
`pnpm typecheck:anti-slop` cover both upstream and local rules; both also run through validation.
