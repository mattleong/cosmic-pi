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
