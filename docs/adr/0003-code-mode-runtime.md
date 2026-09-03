# ADR 0003: Vendored Code Mode runtime and two-package architecture

- Status: Accepted; integration policy superseded in part by ADR 0004 and expanded by ADR 0006
- Date: 2026-08-11

## Context

Code Mode lets a model write one small JavaScript program that orchestrates many
tool calls (sequence, transform, branch, parallelize) instead of emitting one
tool call per model turn. OpenCode 2 ships a mature, MIT-licensed, Effect-native
implementation as the workspace-private package `@opencode-ai/codemode`: a
confined interpreter over explicit, schema-described tools with a budgeted
discovery catalog, normalized diagnostics, and a strict host-authority boundary.

Cosmic-pi wants that capability for Pi without coupling the interpreter to Pi
host concerns, and without depending on an unpublished upstream package.

## Decision

### Two packages, one shipping unit

1. `packages/pi-code-mode/runtime/` (implemented) is a workspace-private,
   host-neutral library containing the vendored Code Mode runtime. It has no Pi
   imports, no `pi.extensions`, and no Pi-specific policy. It is a separate
   workspace package (own tests, tsconfig, lint config) but is **nested inside
   the public `pi-code-mode` package directory** so that its TypeScript
   `runtime/src/` tree ships inside the `pi-code-mode` tarball and Pi/Jiti loads
   it directly without a build step. A private package can never resolve from a
   registry, and package managers resolve transitive `file:` dependencies
   against the consumer root (verified empirically with pnpm), so
   `pi-code-mode` carries the runtime by value and imports it **only by a computed
   relative path** through one boundary door (`src/boundary/codemode-runtime.ts`).
   The boundary owns the narrow structural API used by Pi, so the vendored tree
   remains checked under its own TypeScript project while inheriting the full
   workspace compiler, Effect language-service, and lint policy with no runtime
   exemptions. The relative import also guarantees the runtime shares the
   extension's single `effect` instance. The runtime's `acorn`, `effect`, and
   `typescript-compiler-api` dependencies are declared by `pi-code-mode` itself so packed
   consumers install them. Only
   `runtime/src/` and the runtime's legal/provenance docs ship in the tarball;
   the nested workspace manifest is repository-only.
2. `packages/pi-code-mode/` is the public Pi extension that owns registration,
   trusted-project-only scoped settings, session lifecycle,
   `/code-mode-settings`, seven core Pi built-in adapters under ADR 0004
   (`tools.pi.read/bash/edit/write/grep/find/ls` over fresh built-in definition factories),
   Windows PowerShell and the explicit Background Tasks adapter under ADR 0006, and the one outer
   `code_mode` agent tool (registered per session
   start when `CodeModeState.available`, wrapped with the `pi-code-previews`
   cooperative shell after `loadCodePreviewSettings` completes).

### Vendored OpenCode 2 runtime at a pinned commit

The runtime is vendored from the OpenCode repository
(<https://github.com/anomalyco/opencode>, `dev` branch) at commit
`d4704347465c1ee63d0c213ed00e648e7f0231c5`, package `packages/codemode`
(`@opencode-ai/codemode@1.18.16`, MIT). Upstream file structure and behavior are
preserved for diffability; the mechanical local deviations (Effect
4.0.0-rc.111, the TypeScript 7.0.2 toolchain with a side-by-side TypeScript 6.0.3
compiler API, Node + Effect-backed Vitest, oxfmt formatting,
OpenAPI removal, explicit erasable TypeScript syntax, closed owned failure
channels, Effect subpath imports, and host/guest clock separation) are enumerated
in `packages/pi-code-mode/runtime/PROVENANCE.md`. These adaptations require no
compiler relaxation, Effect diagnostic override, lint exemption, or source
suppression. The upstream `interpreter/language-v1` wording and `1.x` semver name the interpreter
contract inside OpenCode 2; they are not the legacy OpenCode product-v1
architecture.

Provenance policy: the upstream code is MIT-licensed and its notice is retained
in the package (`THIRD_PARTY_NOTICES.md`). Resyncs happen only by pinning a new
upstream commit and manually reviewing the full upstream diff - this code
interprets model-generated programs, so every adopted hunk is security-reviewed.
No moving branches, no automated sync.

### OpenAPI subsystem excluded

Upstream `src/openapi/**` (OpenAPI-to-tools adapter) and its test suite are not
vendored. The planned Pi integration does not need HTTP-operation tool
generation, and excluding it removes the outbound HTTP client surface from the
confined-execution package entirely.

### Execution model: interpreted, never evaluated

Model-generated programs are TypeScript-transpiled using the
`typescript-compiler-api` alias pinned to TypeScript 6.0.3, parsed with Acorn, and executed by a
tree-walk interpreter over a deliberately bounded JavaScript subset. Generated
code is never passed to `eval`, `new Function`, `node:vm`, or a child JavaScript
process. Programs receive no filesystem, process, network, module, timer, or
prototype-mutation authority; they can only invoke the tool tree the host
supplies, across a validated plain-data boundary.

Host-policy knobs stay host-owned: `timeoutMs`, `maxToolCalls`, and
`maxOutputBytes` have no library defaults; the discovery catalog budget defaults
to 2000 estimated tokens. Fixed interpreter constants (tool-call concurrency 8,
data depth 32) are preserved as-is. Pi-specific limits (program source size in
exact UTF-8 bytes, cumulative nested output in exact UTF-8 bytes of the plain
data entering the guest) are implemented in the extension, not this runtime.

The pinned upstream (like OpenCode 2 itself) runs Code Mode in-process with an
Effect timeout plus abort composition — there is no terminable worker isolate —
and cosmic-pi deliberately retains that OpenCode-compatible in-process execution
model. Because the interpreter runs in the host process, a synchronous native
operation cannot be preempted by the `timeoutMs` Effect timeout once it starts.
The runtime therefore carries a deliberate, security-motivated confinement layer
(`src/interpreter/confinement.ts`; PROVENANCE deviation 8) that bounds every
admitted native operation up front: a conservative static regex screen (nested
quantifiers, repeated alternation, backreferences, inline flag-modifier groups
like `(?i:...)`, more than 3 unbounded
quantifiers/lookarounds — the polynomial `/a*a*a*b/` family — and oversized
optional branch factors are refused) plus subject-length caps scaled to residual
backtracking degree and branch factor; fixed string/collection/log amplification
limits enforced by preflight guards that project the output and refuse the first
overrun before native allocation (forged array-like lengths, `flat`/merge
projections, URLSearchParams doors, and percent-encoding expansion included);
and a shared wall-clock deadline that normalizes a synchronous overrun to
`TimeoutExceeded` without a multi-second event-loop block. These are bounded
allocations and conservative screens, not strict preemption: the deadline is
cooperative, an admitted native operation still runs to completion (bounded to a
small worst case), and some safe programs are rejected in exchange. Guest
authority is unchanged: read-only, exactly the supplied tool tree, and no
eval/`Function`/`node:vm`/child JavaScript process. `boundOutput` reserves its
truncation markers inside `maxOutputBytes` (value and diagnostic message alike).
The extension adds one final code-point-safe UTF-8 clamp over the entire
model-visible text (success, thrown failure, cancellation, source-size refusal,
and unexpected-error paths) so the model never sees more than `maxOutputBytes`
after the extension's own logs/diagnostic framing; only the stale/unavailable
refusal — which can fire with no current configuration — is a short fixed
bounded constant instead.

Deliberate `code_mode` deactivation is preserved across Pi recreating the
extension module (reload/new/resume/fork) through a process-memory handoff keyed
only by the stable Pi session id, comparable to the `pi-subagents` reload
handoff; when no session id is exposed nothing is preserved (no cwd fallback, so
a different session in the same project can never inherit the intent). It is
process memory only; Pi re-instantiates extensions in the same process, so no
cross-process persistence is attempted.

### The integration is read-only, and nested dispatch is a prerequisite for more

> Superseded by ADR 0004. This section records the original MVP policy; the runtime and
> two-package decisions elsewhere in this ADR remain authoritative.

The implemented `pi-code-mode` MVP exposes exactly the read-only Pi tools
`tools.pi.read`, `tools.pi.grep`, `tools.pi.find`, and `tools.pi.ls` (plus the
runtime-owned `tools.$codemode.search`) through Code Mode. A known limitation is
explicit and disclosed in the tool description: tools invoked from inside a
Code Mode program are dispatched directly and bypass Pi middleware that observes
or wraps top-level tool calls (approval wrappers, preview shells, other
extensions' interceptors), and their filesystem authority matches the direct Pi
tools, including absolute paths outside the project. Until a canonical
nested-tool dispatcher exists - one that routes nested calls through the same
middleware pipeline as top-level calls - Code Mode must not expose bash, edit,
write, MCP, or otherwise arbitrary tools. Read-only tools bound the blast radius
of that limitation; they do not remove it.

## Consequences

- Cosmic-pi carries ~5.5k lines of vendored interpreter code. The vendored files
  are exempt from the local soft file-size guidance and stylistic refactors;
  upstream comparability is the review mechanism (documented in the package
  `ARCHITECTURE.md` and `PROVENANCE.md`).
- The workspace compiler is `typescript@7.0.2`. TypeScript 7 has no stable JavaScript
  compiler API, so Code Mode follows Microsoft's side-by-side guidance and uses the catalog's
  `typescript-compiler-api` alias at TypeScript 6.0.3 solely for in-process transpilation. Both the
  runtime package and `pi-code-mode` (which ships the runtime source and therefore owns its
  external dependencies for consumers) declare that alias with `acorn` and `effect`. Because the
  alias also exposes TypeScript 6's `tsc` binary, both package typecheck scripts invoke the root
  TypeScript 7 binary explicitly. Runtime tests also consume the catalog-pinned `@effect/vitest`.
- Retained upstream behavioral cases from the codemode, parity, promise, and
  stdlib suites run as Effect-backed, non-`async` Vitest tests and gate the package,
  alongside the local `confinement` suite. Enumeration, signature-rendering, and
  public-contract-only cases remain excluded as recorded in `PROVENANCE.md`.
  JavaScript `async`, `Promise`, and `Date` remain guest-language behavior inside
  the interpreter rather than host test-runner behavior. The `pi-code-mode`
  extension suites additionally run real interpreter integration tests over
  the source-loaded runtime, including compact early-path clamp wiring and the
  deactivation handoff. Pure limit tests cover the full clamp boundary matrix.
- The nested-package layout is reflected in `pnpm-workspace.yaml`
  (`packages/pi-code-mode/runtime`), the layout/version check scripts, and the
  packed-tarball smoke test, which asserts the runtime TypeScript source and its
  legal/provenance docs ship inside the installed `pi-code-mode` package and load
  through Jiti while the nested workspace manifest and runtime dev files stay out.
- A future Effect or TypeScript bump revalidates this package like any other,
  at zero diagnostics and without package-specific disabled checks. Upstream
  resyncs remain deliberate, pinned, and manually reviewed.

## Primary references

- Upstream package at the pinned commit:
  <https://github.com/anomalyco/opencode/tree/d4704347465c1ee63d0c213ed00e648e7f0231c5/packages/codemode>
- `packages/pi-code-mode/runtime/PROVENANCE.md`
- `packages/pi-code-mode/runtime/ARCHITECTURE.md`
- ADR 0001: Effect v4 prerelease-first architecture
