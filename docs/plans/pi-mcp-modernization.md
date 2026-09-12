# MCP modernization and compatibility

## Scope

Support modern MCP 2026-07-28 and the pinned SDK's supported legacy revisions over stdio and Streamable HTTP. Keep legacy and modern integration behavior in separate adapters behind one application contract. No extension compatibility aliases or automatic storage migrations are required. Preserve existing useful configuration and credential security evidence.

Keep the official SDK responsible for negotiation, framing, wire codecs, and cancellation. Keep one execution service, connection registry, discovery cache, authentication service, and result store. Do not add historical HTTP+SSE transport, sampling, roots, elicitation, tasks, or Apps.

## Required work

1. Isolate protocol integration under `src/boundary/mcp-protocol/{contract.ts,select.ts,modern/,legacy/,shared/}` and expose negotiated version and observation health. Only the selector imports both eras; neither era imports the other. Protocol-neutral services and shared helpers cannot directly import era implementations. Enforce static imports with narrow Oxlint overrides, not symbol-existence tests.
2. Add bounded modern-first negotiation with safe legacy fallback and optional canonical `protocol: "auto" | "legacy"`. Preserve custom stdio process-group and pipe ownership; never overlap probe and replacement processes.
3. Recover expired legacy HTTP sessions without replaying failed application calls. DELETE 404 establishes remote session absence, not native cleanup completion.
4. Bound SSE events and incomplete input instead of total lifetime bytes. Observe background stream failures and withdraw stale metadata.
5. Own modern metadata subscriptions independently of ordinary request deadlines.
6. Accept valid JSON Schema identifiers and annotations while disabling external reference loads and preserving isolated bounded validation. Document conservative guard limitations rather than claiming full dialect support. Distinguish proven output mismatch from locally unavailable validation without changing completed execution certainty or losing retained output.
7. Recheck live trust and configuration during headless credential access and before refresh or publication. Prevent managed bearer credentials from reaching remote plaintext HTTP.
8. Serialize OAuth credential transactions across Pi processes for the same Keychain service/account in an OS-user namespace, including reread, refresh quarantine, refresh, registration/grant persistence, and logout. Journal native-pending mutations durably. Reclaim dead quiescent owners only; unresolved native mutation evidence must fail closed with no automatic unsafe reset.
9. Update documentation, integration fixtures, compatibility checks, and applicable conformance coverage.

## Invariants

- Never automatically replay an uncertain or completed application operation.
- Never open login UI or escalate scopes from ordinary tool calls.
- Recheck current authority after asynchronous waits.
- Confirm native cleanup before replacement admission.
- Do not discard quarantine or unresolved mutation evidence to change formats.
- Protocol-neutral application services do not branch on specific revisions or import protocol implementations.
- Removing legacy support should remove its adapter, selection policy, tests, and documentation without rewriting auth, execution, discovery, retention, or UI.

## Verification

Run focused tests for each change, pi-mcp checks, pi-code-mode integration tests, the full `pnpm validate` gate, and available MCP compatibility/conformance scripts. Exercise modern-only, legacy-only, and dual-protocol servers; malformed negotiation; authorization failures; stream loss; session expiration; cancellation; and cross-process credential races and owner death.

## Implementation record

Implementation and independent regression review completed. No confirmed blockers remain in the reviewed scope.

- `pnpm --filter pi-mcp test`: 963 tests passed across 61 files. Modern and legacy HTTP/stdio fixtures use the official SDK. Real `makeMcpLayer` checks exercise tools, resources, templates, prompts, protocol status, observation loss, disconnect, and retained results without replay.
- `pnpm --filter pi-cosmic-core test`: 258 tests passed across 29 files. Real child processes cover transaction exclusion, owner death, cancellation, publication faults, and independent `HOME` settings. OAuth tests cover single refresh, reread, logout versus late save, native-pending recovery refusal, and live trust/configuration revocation after waits and entry creation.
- `pnpm --filter pi-code-mode test`: 140 tests passed across 17 files.
- MCP and core `typecheck`, `lint`, `format:check`, and `effect:diagnostics` passed with zero Effect errors or warnings.
- `pnpm validate` passed version consistency, layout, diagnostics guards, workspace typechecks, Effect diagnostics, lint, formatting, tests, and clean-consumer packed-source installation/import checks.
- `pnpm mcp:smoke` passed automatic negotiation with `@modelcontextprotocol/server-filesystem@2026.8.31` and `@playwright/mcp@0.0.80`, selecting legacy MCP `2025-11-25`. Tool operations, isolated browser use, 80 KB retained-output recovery, and owned-resource cleanup passed.
- `pnpm mcp:conformance` passed both configured scenarios, `initialize` and `tools_call`, using pinned `@modelcontextprotocol/conformance@0.1.16`. These legacy scenarios explicitly select `protocol: "legacy"`. Both require upstream success plus a driver receipt after confirmed disconnect and scoped cleanup. This is not the full upstream suite or modern-protocol certification.
- `PI_MCP_KEYCHAIN_INTEGRATION=1 pnpm --filter pi-mcp exec vitest run tests/auth/keychain.test.ts`: 8 tests passed, including real macOS Keychain create/read/replace/delete and absence checks in a disposable namespace. Cross-process fault tests use owned Keychain doubles rather than inducing native service crashes.
- Import enforcement checked with installed Oxlint against a disposable tree outside the workspace. Overrides rejected seven neutral/shared/contract/cross-era imports across five fixtures and accepted five fixtures covering the selector, tests, contract/shared imports, and same-era imports. Existing diagnostic rules were retained.
- A final conformance rerun exposed optional GET 404 handling on a stateless legacy server. The transport now distinguishes absent optional GET routes from session-bearing 404, auth failures, and outages. All 90 focused HTTP tests and both conformance scenarios passed after the fix. No application operation is replayed.
- Final independent regression review passed 196 targeted tests across nine files and found no remaining confirmed issues in the previously reported negotiation, schema-reference, observation, lock-publication, namespace, or post-entry-creation authority defects.

Known limits remain macOS native credentials/process ownership, no historical HTTP+SSE or interactive optional features, conservative schema guards, and no automatic recovery from unresolved native mutation evidence. Managed-token rejection evidence remains process-local; refresh quarantine is durable. A silent stdio probe may select legacy only after its bounded deadline and confirmed cleanup. Early-exiting pre-initialize servers need explicit legacy selection; HTTP errors and timeouts alone never authorize downgrade.
