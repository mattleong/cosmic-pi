# anti-slop provenance

Vendored from [`dmmulroy/anti-slop`](https://github.com/dmmulroy/anti-slop) at commit
`446268e5d15baa968eaec669ff65358d36ae6259` (2026-08-14).

The vendored production files retain upstream behavior. Local type-only adjustments let the plugin
pass its own rules. Identical scope lookup, parameter annotation unwrapping, function node types,
and alias-name lookup mechanics are extracted into `shared/ast.ts`; rule policy stays local. The
unused upstream helper `isPopulatedObjectExpression` was dropped from `shared/dictionary-types.ts`.

The 12 upstream rule tests are retained, with local baseline coverage added for the three upstream
rules that had no tests, so Oxlint and `@oxlint/plugins` upgrades can be verified against the
vendored behavior.

Upstream is MIT-licensed; see [LICENSE](./LICENSE).

## Local regression rules

Four workspace-owned rules supplement the unchanged upstream rules. They run as errors in regular
`pnpm lint`, use Oxlint's AST and lexical scopes, and deliberately offer no automatic fixes:

- **`no-eager-effect-finalizer-condition`** catches a conditional/logical `Effect.ensuring`
  decision that reads a binding mutated by a callback in its wrapped Effect pipeline. Defer the
  decision with `Effect.suspend`. Immutable decisions and reads inside lazy callbacks are valid.
  Analysis follows known Effect compositions, not arbitrary helpers or object-property mutations.
- **`no-escaping-render-context`** catches whole `renderCall`/`renderResult` contexts retained by
  known deferred/component helpers or returned component methods. Capture needed fields first.
  Closures share their scope, so a capture by an immediate callback also counts when an escaping
  closure is created in the same function. It follows immutable aliases, known builders, and the
  whole context passed to same-file helpers, not imported helpers, classes, or wrappers. Its
  helper table lists exact callback positions; linting each definition verifies them, and the
  rule test fails when a definition moves.
- **`no-lossy-expanded-arguments`** catches imported `stripTerminalControls` applied to serialized
  renderer arguments reaching a rendering sink. It follows immutable text aliases, one local
  argument helper, and `invokeHostCallback`. Prefer `expandedArguments` or visible control escaping;
  ordinary output/log sanitization remains valid.
- **`no-runtime-type-only-tests`** rejects Vitest type assertions, imported from `vitest` or
  `@effect/vitest`, inside runtime test callbacks, and direct import/declaration-spelling
  assertions against statically identified production source reads. Top-level type assertions,
  Vitest `*.test-d.ts` typecheck files, parser/compiler behavior, packaging execution, and runtime
  file-content assertions remain valid. This is not a general test-quality classifier or
  source-architecture scanner.

The local rules share import, alias, and function resolution from `shared/ast.ts`; rule policy
stays in each rule. Each local rule has regression and false-positive fixtures alongside it. `pnpm test:anti-slop` and
`pnpm typecheck:anti-slop` cover both upstream and local rules; both also run through validation.
