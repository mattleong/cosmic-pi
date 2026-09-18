# pi-code-mode-runtime

Host-neutral confined code execution over explicit, schema-described tools,
vendored from OpenCode 2 Code Mode (`@opencode-ai/codemode`) at a pinned
upstream commit. A model-written JavaScript program is TypeScript-transpiled,
Acorn-parsed, and tree-walk interpreted - never `eval`'d - and can only call the
tools the host supplies.

## Status

- **Private, nested, and shipped by value.** This package is workspace-internal
  (`"private": true`) and is never published on its own. It lives _inside_ the
  public `pi-code-mode` package directory (`packages/pi-code-mode/runtime/`) so
  that its TypeScript `src/` tree ships inside the `pi-code-mode` tarball and
  loads directly through Pi/Jiti without a build step.
  `pi-code-mode` imports it only by relative path through its single boundary
  door (`src/boundary/codemode-runtime.ts`) — never by package name — which
  keeps consumers on one shared `effect` instance and avoids a registry
  dependency that could never resolve. This `package.json` is repository-only
  and stays out of the tarball; `pi-code-mode` declares the runtime's external
  dependencies (`acorn`, `effect`, and the TypeScript 6 `typescript-compiler-api` alias) itself.
- **Host-neutral.** It registers no Pi extension and imports nothing from Pi.
  The `pi-code-mode` extension owns the Pi-facing integration: the `code_mode`
  agent tool, adapters for seven core `tools.pi` built-ins and Windows PowerShell, the
  explicit Background Tasks session adapter, their supplied-tool authority policy, and the
  Pi-specific host limits are layered above this boundary.
- **Observable.** An optional additive lifecycle callback reports queued, running, succeeded,
  failed, and cancelled tool calls with stable execution-local ids and durations. Existing
  start/end hooks and guest-visible execution semantics remain compatible.

## Documentation

- `SUPPORT.md` - compatibility matrix, deliberate restrictions and Test262 coverage.
- `ARCHITECTURE.md` - source map and public/private boundaries.
- `PROVENANCE.md` - upstream origin, pinned commit, deviations, resync policy.
- `THIRD_PARTY_NOTICES.md` - upstream MIT license notice.

The selective v2 upgrade retains the original vendored base and local confinement.
Its compatibility matrix records supported behavior and regression coverage;
this package does not claim broad ECMAScript conformance.

## Verification

Ordinary tests include six pinned, checksummed Test262 fixtures. No network fetch or
external checkout is needed, and missing or changed fixtures fail the test run. For
just that selection, run `pnpm --filter pi-code-mode-runtime exec vitest run tests/test262.test.ts`.

```sh
pnpm --filter pi-code-mode-runtime typecheck
pnpm --filter pi-code-mode-runtime test
pnpm --filter pi-code-mode-runtime lint
pnpm --filter pi-code-mode-runtime format:check
pnpm --filter pi-code-mode-runtime effect:diagnostics
```
