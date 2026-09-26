## pi-mcp (tests)

This shard has 79 confirmed findings from four units: T-mcp-boundary (19, 593 LOC), T-mcp-auth-invocation (17, 443), T-mcp-connection-discovery (19, 657) and T-mcp-rest (24, 599). Nothing was disputed and one finding was dropped. The raw total is 2,292 LOC. Five cross-unit merges turn those findings into **72 entries**. Three documented overlap deductions remove another 25 LOC, which leaves **2,267 test LOC and 0 source LOC**, because every change is in test code or test fixtures. Most entries are effort S with risk none or low. The value falls into four themes:

- **Shared fixtures.** Service stubs, config and server builders, JSON-RPC and SSE wire builders, keychain, auth, manager, results and Deferred gate helpers.
- **Idiom compression.** `Effect.flip` and `Effect.isFailure` instead of `Effect.result` plus `_tag` matchers, defaulted call helpers, and one-line `Effect.sync`.
- **Deleting or merging redundant tests.** In each case the verifiers confirmed that another test already owns the behavior.
- **Some live tests become fake-seam tests.** These are the real-server and real-process tests that only re-prove transport-agnostic logic.

I opened the code for the 8 largest entries and checked each claim: T-mcp-connection-discovery-1, merged entries B, D, A and C, T-mcp-auth-invocation-1, T-mcp-rest-12 and T-mcp-boundary-7. I also checked T-mcp-connection-discovery-8, which ranked 8th before its overlap deduction. All claims and estimates hold, and nothing was demoted. Paths are relative to `packages/pi-mcp/tests/`, and `src/` paths are relative to `packages/pi-mcp/`.

| Category                 | Entries | Source LOC |  Test LOC |
| ------------------------ | ------: | ---------: | --------: |
| verbose-code             |      21 |          0 |       718 |
| test-fixture-duplication |      16 |          0 |       635 |
| test-redundancy          |      21 |          0 |       555 |
| boilerplate              |       5 |          0 |       150 |
| duplication              |       6 |          0 |       146 |
| shared-helper-reuse      |       2 |          0 |        53 |
| test-policy-violation    |       1 |          0 |        10 |
| **Total**                |  **72** |      **0** | **2,267** |

**How the totals were adjusted.**

- Each merged entry takes the category of its largest part. The Deferred-gate merge (E) is counted under boilerplate.
- The three deductions sit where one finding claims lines inside code that another finding removes:
  - T-mcp-connection-discovery-11: −10 LOC at two store fakes that entry B replaces.
  - T-mcp-connection-discovery-8: −12 LOC for the `1204-1220` HTTP override that T-mcp-connection-discovery-6 already claims.
  - T-mcp-connection-discovery-14: −3 LOC for the duplicate setup that T-mcp-connection-discovery-15 collapses.

### Cross-area shared fixtures (merged entries): 383 test

**B · T-mcp-rest-1, T-mcp-connection-discovery-5, T-mcp-auth-invocation-9: One shared service-stub fixture**

- `application.test.ts:22-66,143-149,198-215`, `lifecycle.test.ts:17-71,161-167,203-220`, `settings.test.ts:234-250`, `connection/service.test.ts:87-135`, `discovery/service.test.ts:88-119,166-184`, `manager/service.test.ts:64-95,161-175`, `invocation/service.test.ts:255-300,350-360,640-648`.
- Build one `tests/fixtures` module with:
  - `stubAuth(overrides)`, with no-op defaults for all 8 McpAuth members.
  - `stubConfigStore(initial)`, which returns `{ layer, current, replace }` and publishes on subscribe, as production does.
  - `stubDiscovery`, `queryCodeMode`, and the application `presentationLayer`, `emptyConfig(trusted)` and `host`.

  Tests pass only the overrides they instrument: connection's access counting and reject recording, manager's counting access, and settings' `access`, `status` and `login`.

- src 0 / test 95 (45 + 35 + 15) · risk low · effort M · spot-checked. Each finder subtracted its own fixture module's cost, so sharing one module makes the combined count conservative.
- Behavior: the Layers and override values stay the same. The discovery and manager store fakes gain the same-revision initial publish that production already sends (`config/store.test.ts:259`). The stub must be closure-based, because the connection fixture is built outside Effect. The auth-invocation-9 count leaves out the terminal-cleanup stubs, which T-mcp-auth-invocation-10 removes.

**D · T-mcp-connection-discovery-4, T-mcp-boundary-6: Shared `McpEffectiveServer` and `McpResolvedConfig` builders that reuse `DEFAULT_MCP_SETTINGS`**

- `boundary/sdk-connection.test.ts:26-33,75-94,121-139,153-181,189-203,215-233,243-258,273-275,345-347`, `connection/service.test.ts:25-58`, `discovery/service.test.ts:30-47,73-87`, `discovery/cached.test.ts:8-29`, `discovery/pagination.test.ts:17-33`, `manager/service.test.ts:42-63`, `connection/admission.test.ts:8-16`.
- Add `tests/fixtures/config.ts` with:
  - `stdioServer(id, overrides)`.
  - `httpServer(id, overrides)`, defaulting to url `https://example.test/mcp`, `headers: {}`, auth none and `denyTools: []`.
  - `resolvedConfig(servers, settings?)`, which spreads `DEFAULT_MCP_SETTINGS`.

  Also add a `spyOpen` helper for the six `openSdk*` spies in sdk-connection.

- src 0 / test 90 (50 + 40) · risk none · effort M · spot-checked. connection `defaults` and the discovery harness settings are exact copies of `DEFAULT_MCP_SETTINGS`.
- Behavior: every asserted value and leak marker stays explicit:
  - connection keeps `/private/secret-path` and ids `a`/`b` with identity `${id}-1`;
  - manager keeps its `private-*` values;
  - cached keeps `denyTools: ["denied"]`;
  - cached and pagination keep identity `"identity"` for cursor binding;
  - admission keeps its three overrides.

  sdk-stdio's 2000 ms settings stay local.

**A · T-mcp-boundary-14, T-mcp-connection-discovery-19, T-mcp-auth-invocation-13: Assert expected failures with `Effect.flip` and `Effect.isFailure`**

- Covered sites:
  - About 45 sites in `boundary/{schema-validator,sdk-http,sdk-stdio,sdk-connection,sdk-client,host-auth,host-ui}.test.ts`, for example `schema-validator.test.ts:66-76,718-757`, `sdk-http.test.ts:1261-1288` and `sdk-stdio.test.ts:527-555`.
  - `discovery/pagination.test.ts:85-193`, `discovery/service.test.ts:229-250,533-549,890-918`, `manager/service.test.ts:393-419` and `connection/admission.test.ts:62-70`.
  - `auth/{policy,sdk-auth,keychain,credential-store,scopes}.test.ts`, for example `policy.test.ts:51-102`.
- Three rewrites:
  - `.pipe(Effect.result)` followed by a `{ _tag: "Failure", failure }` match becomes `expect(yield* x.pipe(Effect.flip)).toMatchObject({ kind, outcome })`. Forked sites use `Effect.flip, Effect.forkScoped`.
  - Checks that only read `._tag` become `Effect.isFailure` or `isSuccess`.
  - The duplicated `rpc-method-not-found` failure in pagination is hoisted.

  Leave these sites alone: `String(result)` and `encodeUnknown(result)` redaction checks, the Result equality at `sdk-http.test.ts:856-857`, and sites that narrow on `_tag`.

- src 0 / test 88 (50 + 20 + 18) · risk none · effort M · spot-checked.
- Behavior: `Effect.flip` fails the test on an unexpected success. In the pinned effect 4.0.0-rc.112, `isFailure` matches typed failures only, so defects still propagate. The count excludes sites deleted by T-mcp-boundary-8, -9 and -13.

**C · T-mcp-boundary-11, T-mcp-rest-20: One JSON-RPC/SSE wire fixture**

- Sites:
  - `boundary/mcp-protocol/legacy.test.ts:8-15,26-50,78-96`
  - `boundary/mcp-protocol/negotiation-rejection.test.ts:9-16,29-49`
  - `boundary/mcp-protocol/modern.test.ts:29-53,81-93,197-206,292-307,389-405,438-526`
  - `boundary/mcp-protocol/legacy-subscriptions.test.ts:22-37`
  - `boundary/sdk-client.test.ts:52-61`, `boundary/sdk-instructions.test.ts:10-23`, `boundary/sdk-http.test.ts:49-53`
  - `resources/legacy-subscriptions.test.ts:16-20,58-77`
  - `resources/subscriptions.test.ts:240-257,351-362,419-432,628-642`
  - `observations/service.test.ts:40-41,186-200`, `interaction/service.test.ts:357-359`
  - `fixtures/optional-features.ts:22-39`
- Put the following in one module:
  - `parseWire` and a `parseWireOption` variant.
  - Raw builders: `legacyInitialized(capabilities)`, `rpcResult`, `rpcError`, `sseFrame(s)` and `sseResponse`.

  Then delete the four local `Schema.Struct({ method, id })` decoders, about 10 legacy initialize literals, and the inline Response construction. Keep `reply`'s 60 s envelope separate; modern's `ttlMs: 0` becomes an option. Leave sdk-http's own `Wire` alone, because it types `params.name`.

- src 0 / test 70 (50 + 20) · risk none · effort M · spot-checked. The two finders put the helpers in different files (`fixtures/json-rpc.ts` and `fixtures/optional-features.ts`); choose one.
- Behavior: the wire bytes stay the same, except for serverInfo names, which no test asserts. The initialize and error builders stay raw, without resultType or ttlMs.

**E · T-mcp-connection-discovery-14, T-mcp-auth-invocation-12: Deferred gate and probe helpers**

- `connection/service.test.ts:317-338,403-500,618-680,748-843,1314-1472`, `discovery/service.test.ts:555-613,649-897,1121-1196`, `auth/scopes.test.ts:170-190`, `auth/sdk-auth.test.ts:177-195`, `auth/flow.test.ts:304-326,336-361,495-517`.
- Add `tests/fixtures/probes.ts` with two helpers:
  - `gate()`, which returns `{ entered, release, pass }`: signal entry, then await release.
  - `blockingProbe`, which returns `{ entered, block, released() }`: signal entry, never complete, and set a flag in `ensuring`.

  Use them for about 17 entered/release pairs, about 25 chains, and five hang-and-record-release sites of 10 to 12 lines each. Keep call-specific gating inline.

- src 0 / test 40 (25 + 18 − 3 overlap with connection-discovery-15) · risk none · effort M. Confidence in connection-discovery-14 is low, because not every chain fits the pattern.
- Behavior: the pauses stay on the same Deferreds at the same ownership boundaries, as `testing.md` requires. Tests still fail if interruption skips the finalizer.

### connection/, discovery/, config/, manager/, client/: 505 test

**T-mcp-connection-discovery-1: Put the 27 six-argument `queryCached` calls behind a helper with defaults**

- `discovery/cached.test.ts:52-390`.
- Add `query(request, { at?, stored?, evidence?, cursors? })`, which defaults to config, snapshots, `new Map()`, `emptyCursorState()` and `"test"`. Each call becomes 1 or 2 lines.
- src 0 / test 110 · risk none · effort S · spot-checked. 25 calls take about 8 lines each; the verifier puts the realistic saving at 120 to 130.
- Behavior: every request, override and assertion is kept.

**T-mcp-connection-discovery-2: Consolidate the reason-routing and per-outcome loops in diagnostics tests**

- `client/diagnostics.test.ts:39-98,133-147,178-207,220-229`.
- Write one `it.each` over the 12 settings-routed reasons, and keep a short sign-in routing test. Merge the four loops over all 30 reasons into `it.each(["not-sent","unknown","completed"])`.
- src 0 / test 45 · risk low · effort S.
- Behavior: `failureDiagnostic` switches on the reason before the kind, and unknown and completed are handled identically, so the different error kinds never reached different branches. The no-leak, routing, no-replay and no-invented-retention checks all stay.

**T-mcp-connection-discovery-7: Parameterize the near-duplicate request and subscription tests**

- `connection/service.test.ts:283-315,380-401,403-500,526-553`.
- Run 403-500 and the pair 380-401/526-553 through `it.effect.each(["request","subscribe"])`, with both phases on `httpServer` with env auth. The held operation and the dispatch counter depend on the phase. Lines 283-315 become a 3-row table.
- src 0 / test 45 · risk low · effort M. This count is what remains after connection-discovery-6 is applied.
- Behavior: request and subscribe keep their separate production paths, and both still run. The request variant gains the `auth-env-required` check, which lines 221-281 already show holds for request-phase rejections.

**T-mcp-connection-discovery-8: Replace the 82-line live-HTTP static-authorization test with a fake-connector assertion**

- `connection/service.test.ts:1165-1246`, plus `boundary/sdk-http.test.ts`.
- Write an `it.effect` on the fake connector. It configures `httpServer(config, { auth: none, headers: { Authorization } })`, makes two calls, disconnects, and asserts `expect(f.state.tokens).toEqual([])`. Also add a short assertion to sdk-http that a static-only Authorization header reaches every request, including the DELETE.
- src 0 / test 43 (55 − 12 overlap with connection-discovery-6) · risk low · effort S · spot-checked.
- Behavior: the guard at `src/connection/operation.ts:101-104` stays tested. The only coverage lost is a real-socket run whose connector mapping was written inside the test.

**T-mcp-connection-discovery-13: Give service fixtures a generator-taking `run` helper**

- `discovery/service.test.ts:197-1462`, `connection/service.test.ts:221-1494`, `manager/service.test.ts:178-478`.
- Add `run(function* ({ discovery, connections }) {...})`, which yields the services and provides the layer. Do not use the arrow-returning-Effect form, which oxfmt formats so that it saves no lines.
- src 0 / test 40 · risk none · effort M. The finder claimed 75; the verifier adjusted it to 40.
- Behavior: the same layer is provided at the same entry point. Proceed only if the typing stays clean under Effect v4 Yieldable and the anti-slop lint rules.

**T-mcp-connection-discovery-9: Delete the store test for wholesale replacement**

- `config/store.test.ts:352-393`, `config/project-root.test.ts:131-133`.
- Delete the test. In the project-root merge test, add a check that the diagnostic contains `'"url"'` and that the local server matches `{ scope: "project", directory: "/project" }`.
- src 0 / test 36 · risk low · effort S.
- Behavior: `project-root.test.ts:71-193` already covers override, tombstone, fail-closed and remove. The two checks that only this test made move over.

**T-mcp-connection-discovery-3: Add a `resolveServers` helper to the options tests**

- `config/options.test.ts:9-324`.
- Add `resolveServers(mcpServers, source?, revision)`, and provide Path and NodeCrypto once with the @effect/vitest `layer(...)` around the describe. Delete the four local resolve closures and the `const path` lines.
- src 0 / test 35 · risk none · effort S.
- Behavior: resolveMcpConfig receives the same inputs. The helper must accept an already-decoded source, because the allow/deny, cwd/registration and identity tests pass decoded documents.

**T-mcp-connection-discovery-12: Add a `queryPage` helper**

- `discovery/service.test.ts:194-1451`, about 20 three-line sites.
- Add `queryPage(discovery, request, operation?)` in place of the `discovery.query(...).pipe(Effect.flatMap(decodePage))` chain.
- src 0 / test 30 · risk none · effort S.
- Behavior: the effect composition is identical.

**T-mcp-connection-discovery-6: Connection test helpers**

- `connection/service.test.ts:211-246,422-427,448-464,479-484,1051-1057`, plus lines 367, 475 and 545.
- Four changes:
  - Replace the local `until` with pi-cosmic-core/testing `yieldUntil`, with 1,000 attempts.
  - Add `httpServer(config, { auth, headers?, url? })`.
  - Add a bounded `awaitStatus`.
  - Add `subscribe(c)`. Only 3 sites use it; line 513 is a custom operation.
- src 0 / test 28 · risk none · effort S.
- Behavior: the polling bounds and assertions are unchanged. `yieldUntil` fails with a typed TestPollingTimeout, which is equivalent inside `it.effect`.

**T-mcp-connection-discovery-16: Manager test fixtures**

- `manager/controller.test.ts:12-36,57-88`, `manager/policy.test.ts:5-23`, `manager/service.test.ts:188-228,267-282,333-336`.
- Add `tests/fixtures/manager.ts` with `managerRow(overrides)`, a plain theme, and `managerHarness(screen, { snapshot?, resultId?, height? })`. Replace the 7 inline `{ maxOutputBytes: 4096, images: false }` with a module-level constant.
- src 0 / test 25 · risk none · effort M.
- Behavior: the rows, theme and options are the same. Height stays an option, because service uses 30 and controller uses 28.

**T-mcp-connection-discovery-11: Write single-statement `Effect.sync` callbacks as one-liners**

- `config/store.test.ts:247-622`, `connection/service.test.ts:101-109,169-172,808-1488`, `discovery/service.test.ts:628-632`, `manager/service.test.ts:82-90`.
- Use `Effect.sync(() => void stmt)`, the idiom at `store.test.ts:73`, or a Deferred for boolean flags.
- src 0 / test 20 (30 − 10 at the two store-fake sites that entry B replaces) · risk none · effort S.
- Behavior: the side effects are identical. Only the formatting changes.

**T-mcp-connection-discovery-10: Share the config-store paths and layer**

- `config/project-root.test.ts:12-25,134-160`, `config/store.test.ts:27-47,189-230`.
- Add `tests/fixtures/config-store.ts` with GLOBAL, PROJECT and PROJECT_ROOT and the parameterized `layerFor`. Add one JSON parse helper next to `serializedConfig`.
- src 0 / test 15 · risk none · effort S.
- Behavior: this changes plumbing only.

**T-mcp-connection-discovery-17: Add a typed `requestOf(requests, kind, index)` narrowing helper**

- `manager/controller.test.ts:256-505`, `manager/service.test.ts:215-235`.
- Collapse the 21 fetch-then-narrow pairs into one line each. The cast needs a `// SAFETY:` comment.
- src 0 / test 13 · risk none · effort S.
- Behavior: a kind mismatch still fails the test.

**T-mcp-connection-discovery-18: Build result-view `page()` on top of `retained()`**

- `manager/result-view.test.ts:5-47`.
- Allow `origin` in retained's patch.
- src 0 / test 12 · risk low · effort S.
- Behavior: pages now carry format "json", but they stay on the raw path because total 40 differs from the text length. Only the variant with no format key is lost.

**T-mcp-connection-discovery-15: Extract a `holdRefreshThenNotify` helper**

- `discovery/service.test.ts:711-742,764-793`.
- Make the follow-up route a parameter. The outcome-specific assertions stay in each test.
- src 0 / test 8 · risk none · effort S.

### boundary/ (SDK transports, schema validator, host adapters): 453 test

**T-mcp-boundary-7: Extract fetch-callback helpers in the sdk-http tests**

- `boundary/sdk-http.test.ts:156-222,368-380,720-1246` (15 ranges).
- Add local helpers:
  - `onAbort(init, f)` for the seven 7-line abort listeners.
  - `streamResponse(source, init?)` for the 8 ReadableStream bodies. Put it in a fixture so the sdk-fetch tests can reuse it.
  - `jsonResponse`.
  - `heldSibling()` for the clone at 988-1010 and 1079-1101.
  - `failOnce(method, response, onCall)`.
- src 0 / test 50 · risk none · effort M · spot-checked.
- Behavior: every Deferred, TestClock and yieldUntil checkpoint stays. `heldSibling` must be recreatable on each loop iteration, and `seen()` must be a flag set when fetch is called.

**T-mcp-boundary-1: Move the duplicated `protocolResponses` table into `fixtures/sdk-protocol-errors.ts`**

- `boundary/sdk-http.test.ts:2-8,101-139`, `boundary/sdk-stdio.test.ts:3-10,347-386`.
- Export the mapped list and delete both copies and their SDK error imports.
- src 0 / test 40 · risk none · effort S.
- Behavior: the data is identical, and all four `it.effect.each` suites run every case.

**T-mcp-boundary-2: Add per-method responders to `makeProcess` and a `startTransport` helper**

- `boundary/sdk-stdio.test.ts:279-345,388-421,445-471,513-635`.
- Change the fake to `makeProcess(responses = {})`, with a default initialize reply, and add `startTransport(fake, maxBufferSize = 1024)`.
- src 0 / test 40 · risk none · effort S.
- Behavior: writes are still recorded, and an override replaces the initialize reply. The overflow test must keep maxBufferSize 64 and set onclose before start.

**T-mcp-boundary-16: Share one fake custom-overlay host between the host-auth-panel and host-ui tests**

- `boundary/host-auth-panel.test.ts:14-335`, `boundary/host-ui.test.ts:16-265`.
- Add `tests/fixtures/custom-overlay.ts` with `customOverlayHost({ columns, rows })`, plus `open` and `openOverlay` helpers for the preamble. Replace host-ui's `ready` poller with `yieldUntil`.
- src 0 / test 40 · risk low · effort M.
- Behavior: the fake keeps Pi's global-pop semantics. The late-factory and late-mount orderings must stay expressible.

**T-mcp-boundary-9: Merge the DELETE-404 test into the expired-session replay test**

- `boundary/sdk-http.test.ts:527-603,639-682`.
- Make DELETE return 404 in the 527 fixture, and add the repeated-close cached assertion before the DELETE-session check. Delete 639-682.
- src 0 / test 38 · risk low · effort S.
- Behavior: the merged test still proves that close succeeds despite a 404, that exactly one DELETE carries sessionA, that the repeated close is cached, and that post-close requests are not sent.

**T-mcp-boundary-12: Add `countingRunner` and `expectSilentRejection` helpers to the schema-validator tests**

- `boundary/schema-validator.test.ts:48-824` (12 ranges).
- Define `fixedRunner` through `countingRunner`. The 5 silent-rejection blocks become the helper, which slightly strengthens 2 tests that check only a subset today.
- src 0 / test 35 · risk none · effort S.

**T-mcp-boundary-4: Use `describe.skipIf` in place of the `macOnly`/`mac` wrappers, and drop the inner `Effect.scoped`**

- `boundary/sdk-stdio.test.ts:47-55,94-269,790-856`, `boundary/mcp-protocol/negotiation.test.ts:15-87`.
- src 0 / test 30 · risk none · effort S.
- Behavior: `it.live` already runs the test under `Effect.scoped`, and no test asserts anything after its inner scope closes. On other platforms the tests are now reported as skipped instead of passing with an empty body. Keep the scoped block in sdk-http's "dispatches with fixed token auth", which asserts the DELETE after the scope closes.

**T-mcp-boundary-10: Bind the owned-fetch builder to `ownership()` in the sdk-fetch tests**

- `boundary/sdk-fetch.test.ts:29-401`.
- `ownership()` returns `bounded(fetch, maxBytes = 128)`. Add an `uncorrelated(fetch)` builder, and use `streamResponse` from boundary-7.
- src 0 / test 28 · risk none · effort S · depends on boundary-7.

**T-mcp-boundary-18: Publish `pausedScheduler` from pi-cosmic-core/testing instead of copying it**

- `boundary/sdk-stdio.test.ts:65-90`, `packages/pi-cosmic-core/tests/duplex-process.test.ts:83-108`, `packages/pi-ask-user/tests/async-service.test.ts:647-662`.
- src 0 / test 25 · risk none · effort S. That is the pi-mcp share; the workspace total is about 35.
- Cross-package: this needs a new core testing export and a `docs/architecture/testing.md` entry. The helper has no Vitest dependency and three consumers, so it meets the rules for core testing exports.

**T-mcp-boundary-5: Use static imports and one shared subscribe literal in the actual-stdio subscription tests**

- `boundary/sdk-stdio.test.ts:889-893,983-997,1044-1070,1111-1137`.
- src 0 / test 24 · risk low · effort S.
- Behavior: spies act on module namespaces, so the import style does not change their targets.

**T-mcp-boundary-8: Delete the real-server 401/403 no-replay test**

- `boundary/sdk-http.test.ts:326-350`. Add a token to the test at 449-489.
- src 0 / test 24 · risk low · effort S.
- Behavior: classification uses only the status (`src/boundary/sdk-http-transport.ts:303-346`). Token with 401/403 and single dispatch is covered by "rotates and clears" and "keeps interleaved POST challenges". Only the real-socket variant is lost.

**T-mcp-boundary-13: Merge the two pre-admission input-bound tests into one input×outcome loop**

- `boundary/schema-validator.test.ts:89-117,667-733`.
- src 0 / test 20 · risk none · effort S · depends on boundary-12.
- Behavior: coverage becomes a superset. Keep the output-certainty assertions (715-731) with `oversized` still in scope.

**T-mcp-boundary-17: Micro-helpers in the host-mcp-status and host-auth tests**

- `boundary/host-mcp-status.test.ts:59-192`, `boundary/host-auth.test.ts:125-154`.
- Add `rejects(run)`, `announce(available = true)`, `h.register()`, and one shared prompt `record` handler. The `rejects` helper is the same idiom as T-mcp-rest-5.
- src 0 / test 20 · risk none · effort S.

**T-mcp-boundary-3: Extract a `recordAcquired(onAcquire?)` spy helper**

- `boundary/sdk-stdio.test.ts:165-175,194-204,221-233`.
- src 0 / test 15 · risk none · effort S.
- Behavior: real process acquisition and the cleanupState assertions stay.

**T-mcp-boundary-15: Trim the live instructions-capture tests**

- `boundary/sdk-instructions.test.ts:24-37,61-67,96-106`, `boundary/sdk-client.test.ts:16-46`.
- Keep the absent and oversized-multibyte cases, and add an `expectCaptured` helper shared by both transports. This removes 4 live tests.
- src 0 / test 14 · risk none · effort S.
- Behavior: the pure `boundedSdkInstructions` it.each covers the empty, supplied and boundary cases.

**T-mcp-boundary-19: Drop the gateway-reply copy assertions from the negotiation-rejection test**

- `boundary/mcp-protocol/negotiation-rejection.test.ts:4-7,60-82`.
- Keep the boundary assertions, and add a check that `JSON.stringify(result.failure)` does not match `/private-/`.
- src 0 / test 10 · risk low · effort S.
- Behavior: `client/diagnostics.test.ts` already covers reply projection and no-leak for protocol-negotiation-rejected.

### auth/: 324 test

**T-mcp-auth-invocation-1: Replace the hand-built OAuth patches in the sdk-auth tests with a patchable `fixture.configured()`**

- `auth/sdk-auth.test.ts:65-75,595-610,844-883,907-920,936-949,1027-1040,1146-1159`, `fixtures/oauth-server.ts:257-285`.
- Swap the unused `identity` parameter for `patch: Partial<McpOAuthConfig>` and delete `changeOAuth`. The inline rebuilds become one-line calls:
  - `allowMissingResourceMetadata` at 907-920 and 936-949.
  - `redirectUri` at 595-610 (local mode only), 1027-1040 and 1146-1159.

  Keep the explicit narrowing for the full-replacement variant at 844-883 and for 773-786, because exactOptionalPropertyTypes does not let a patch unset a field.

- src 0 / test 65 · risk none · effort S · spot-checked. An alternative with nearly the same saving: call the existing `changeOAuth` at the five sites and leave the fixture alone.
- Behavior: the tests get the same server objects, and no caller passes an identity.

**T-mcp-auth-invocation-2: Give the auth/service server builder auth and url parameters**

- `auth/service.test.ts:30-43,94-105,176-187,246-259,286-295,320-331,344-367`.
- Change the builder to `server(digit, auth = oauth, url)`.
- src 0 / test 45 · risk none · effort S.
- Behavior: the definitions are identical, including the plaintext URL and the implicit flag. The status and logout tests pass `https://resource.example` explicitly.

**T-mcp-auth-invocation-3: Extend `discover()` in discovery.test with a challenge option, and share a bare config and local policy**

- `auth/discovery.test.ts:20-387`.
- The helper becomes `discover(origin, config, { root, challenge })`, alongside a shared `bare` config and `localPolicy`. Apply this in discovery.test only, and leave the sdk-auth policy literals as they are.
- src 0 / test 36 · risk none · effort S.
- Behavior: the fixture's resource is `${origin}/mcp` and its issuer equals the origin, so the defaults match the inlined arguments.

**T-mcp-auth-invocation-5: Add shared `testGrant`, `testRegistration` and `manualUi` builders in `tests/fixtures/auth.ts`**

- `auth/credentials.test.ts:16-38`, `auth/credential-store.test.ts:20-43,297-340`, `auth/service.test.ts:30-63`, `auth/sdk-auth.test.ts:76-81`, `auth/scopes.test.ts:19-23`, `invocation/service.test.ts:762-766,934-947,1776-1780`, `fixtures/credential-transaction-child.ts:24-52`.
- Use `oauthServer` only at credential-store 297-310 and in the service builder. Keep the normalized server at sdk-auth 526-545 inline.
- src 0 / test 35 · risk none · effort M · depends on auth-invocation-2.
- Behavior: the values are byte-identical, because the overrides are explicit. Keep the redaction token literals visible at the call site.

**T-mcp-auth-invocation-6: Give the auth/service `make()` store defaults and add a `memory()` grant store**

- `auth/service.test.ts:69-1037` (18 sites).
- Make the store fields `Partial` with defaults. This also drops the redundant inner transactionStore at 394-407.
- src 0 / test 30 · risk none · effort S.
- Behavior: the defaults equal the values spelled out today. `memory()` must clear the value on remove.

**T-mcp-auth-invocation-7: Share the cross-process IPC child harness through pi-cosmic-core/testing**

- `auth/credential-transactions.test.ts:1-155`, `packages/pi-cosmic-core/tests/cross-process-lock.test.ts:19-90`.
- Add `temporaryDirectory`, `killChild` and `spawnIpcChild({ timeout, env? })` to core testing. In pi-mcp, `launch` becomes a 3-line call. Add local `exists` and `readText` helpers for the repeated file checks.
- src 0 / test 30 (workspace net) · risk low · effort M.
- Behavior: all 7 real-child scenarios stay. The timeout (15 s here, 10 s in core) and core's HOME env become parameters. This also removes pi-mcp's relative import into `pi-cosmic-core/src`.

**T-mcp-auth-invocation-8: Share in-memory and held-write keychain fakes in `tests/fixtures/keychain.ts`**

- `auth/credential-store.test.ts:44-62,185-210`, `auth/keychain.test.ts:95-177`, `auth/service.test.ts:522-548`, `auth/credential-transactions.test.ts:200-219`.
- Add `memoryKeychain(initial?, missing)` and `heldKeychain({ firstOnly? })`.
- src 0 / test 30 · risk none · effort M.
- Behavior: native semantics are unchanged. One-off fault fakes stay inline.

**T-mcp-auth-invocation-11: Fold the trust-loss test into the parameterized guard recheck**

- `auth/credential-store.test.ts:64-140`.
- Loop over trust or config × operation.
- src 0 / test 18 · risk none · effort S.
- Behavior: coverage grows, because trust loss is now checked on write and remove too. Assert `kind: "stale"` only for config.

**T-mcp-auth-invocation-14: Merge the env and none sign-in tests into one three-mode test**

- `auth/service.test.ts:237-311`.
- src 0 / test 15 · risk low · effort S · depends on auth-invocation-2.
- Behavior: all four facts stay covered, and the status-unchanged assertion holds in every mode.

**T-mcp-auth-invocation-15: Add `awaitCallback` and `openFailed` helpers to flow.test**

- `auth/flow.test.ts:199-398`.
- src 0 / test 12 · risk none · effort S.
- Behavior: the effects passed to the flow are identical.

**T-mcp-auth-invocation-17: Extract an `expectFenced` helper**

- `auth/service.test.ts:745-756,776-786,921-935`.
- src 0 / test 8 · risk none · effort S · depends on auth-invocation-6.
- Behavior: the four-phase fence check still runs in each test.

### ui/, tool-result, code-mode-presentation: 241 test

**T-mcp-rest-12: Delete `ui/compact-projection.test.ts`**

- `ui/compact-projection.test.ts:1-66`, `ui/compact-summary.test.ts:385-393,492-501`.
- Move the two checks this file alone makes into compact-summary:
  - At line 387, add unknown and not-sent replies with isError and empty data to the undefined list.
  - At 391-392, assert that `issues.coverage` is `"unknown"`.
  - At 493-498, add `{ outcome: "completed", isError: false, outputValidation: "invalid" }`.
- src 0 / test 58 · risk low · effort S · spot-checked.
- Behavior: the equality check only tests a one-line delegate (`src/ui/compact-summary.ts:154-159`). The empty-data rule and the invalid-origin case survive in compact-summary.

**T-mcp-rest-10: Share a `projectReply(action, result, resultId)` helper**

- `ui/tool-renderer.test.ts:81-142`, `ui/compact-summary.test.ts:29-46`.
- src 0 / test 28 · risk none · effort S.

**T-mcp-rest-14: Trim the validation-notice completeness test to its redaction case**

- `ui/compact-summary.test.ts:338-376`. Delete 339-370.
- src 0 / test 28 · risk low · effort S.
- Behavior: other tests already cover the rest:
  - Consolidation and origin flags: `tool-renderer.test.ts:227-338`.
  - Getter containment: `code-mode-presentation.test.ts:168-211`.
  - Notices under invalid origin: `tool-renderer.test.ts:374-404`.
  - `noticesComplete` true, indirectly: `boundary-failure.test.ts:16-20`.

**T-mcp-rest-11: Add `withOrigin` and `retainedRead` builders**

- `ui/tool-renderer.test.ts:230-398`.
- Use `retainedRead` for the three retained sites. Use `withOrigin` directly at 348-364 and 383-398, so those fixtures get no resultId and 383 keeps no `content` key.
- src 0 / test 25 · risk none · effort S.

**T-mcp-rest-16: Merge `presentation-conformance.test.ts` into `compact-expansion.test.ts`**

- `ui/presentation-conformance.test.ts:1-66`, `ui/compact-expansion.test.ts:1-34`.
- Build the tool with `registered(mode, style)`.
- src 0 / test 25 · risk none · effort S.
- Behavior: the same conformance loop runs over every mode, style and action family.

**T-mcp-rest-17: Add an `owned(execution)` tool-execution helper**

- `tool-result.test.ts:43-237`.
- src 0 / test 25 · risk none · effort S.

**T-mcp-rest-18: Remove the hand-built unwrapped render loop**

- `tool-result.test.ts:100-125`. Keep the result-shaping assertions.
- src 0 / test 20 · risk low · effort S · depends on rest-17.
- Behavior: harness conformance renders the wrapped tool in preview style, which uses the original renderers. `execute` rejects in those harnesses, so any execution during rendering fails the test.

**T-mcp-rest-13: Put the retained-origin cases in one `it.each` and add the hostile getter to the undefined list**

- `ui/compact-summary.test.ts:385-393,492-548`.
- src 0 / test 18 · risk none · effort S.
- Behavior: undefined cases keep the whole-summary `toBeUndefined()` check.

**T-mcp-rest-15: Merge the overlapping producer-presentation tests**

- `code-mode-presentation.test.ts:57-211`.
- Fold 57-69 into 70-96 without changing that test's projection, and add a second projection with resultId. Delete 142-157, and add two samples to 168-211: a top-level `unreadable("outcome")` and an outputValidation whose `toString` throws.
- src 0 / test 14 · risk low · effort S.

### results/: 150 test

**T-mcp-rest-8: Add a shared `tests/fixtures/results.ts`**

- `results/projection.test.ts:18-685` (19 ranges), `results/service.test.ts:18-39,178-179,345-346`.
- Export `png`, `input`, `allow`, `retained(service, prepared)` (which returns the narrowed retention), `opts(bytes, images)` and `readAll(service, id, options, extras?, onPage?)`.
- src 0 / test 45 · risk none · effort M.
- Behavior: the page-loop invariants run on every page. Adding `next>offset` to the schema loop only makes it stricter.

**T-mcp-rest-7: Delete the results-service validation-retrieval test**

- `results/service.test.ts:301-340`.
- src 0 / test 38 · risk low · effort S.
- Behavior: `projection.test.ts:83-116` asserts the same projected-versus-read distinction under the minimum allowance. Two things are lost: the read origin's action and outcome fields, and a parse of the full page text at 4 KiB. Paging stays covered at 294-319 and 452-536.

**T-mcp-rest-6: Add `read` and `expectStale` helpers**

- `results/service.test.ts:58-460`.
- src 0 / test 35 · risk none · effort S.
- Behavior: line 126 keeps its not-sent check, and line 456 needs an id overload.

**T-mcp-rest-9: Fold the small-image Code Mode privacy test into the large-image test**

- `results/projection.test.ts:321-360` and `118-158`.
- Delete 321-360. Add a projection step at 4,096 bytes with images false, asserting that images is empty, the encoding lacks the image, and the attachment descriptor is present.
- src 0 / test 32 · risk low · effort S.
- Behavior: small-image exclusion is also covered at `projection.test.ts:206-238`.

### lifecycle, application, settings, code-mode provider: 84 test

**T-mcp-rest-5: Add a one-line `rejects(p, match)` helper**

- `code-mode/provider.test.ts:79-323`, `lifecycle.test.ts:467-703`.
- src 0 / test 20 · risk none · effort S.
- The count is net of the overlaps with rest-2, rest-4 and rest-24.

**T-mcp-rest-2: Delete the redundant runtime-to-Code-Mode certainty test**

- `lifecycle.test.ts:712-726`.
- src 0 / test 16 · risk low · effort S.
- Behavior: the same rethrow is covered by `lifecycle.test.ts:688-710` and `code-mode/protocol.test.ts:184-186`.

**T-mcp-rest-4: Add `parity` and `expectRevoked` helpers**

- `lifecycle.test.ts:514-562,650-686`.
- src 0 / test 15 · risk none · effort S.

**T-mcp-rest-3: Merge the two rejected-gateway-input labeling tests**

- `lifecycle.test.ts:597-648`.
- src 0 / test 12 · risk none · effort S.
- Behavior: the guidance assertions stay conditional on each case.

**T-mcp-rest-23: Trim loops that drive a single code path**

- In `settings.test.ts:269-285`, keep one owned reason. In `lifecycle.test.ts:517-521`, keep one auth reason and all 3 outcomes. Keep all 8 malformed inputs in `application.test.ts`, because they test the default-to-status boundary.
- src 0 / test 11 · risk low · effort S.
- Behavior: all 7 reasons take the same pass-through (`src/settings/controller.ts:139-150`), and all 3 auth reasons take the same branch (`src/application/lifecycle.ts:214-219`).

**T-mcp-rest-24: Trim the host schema-literal test to its wiring check**

- `code-mode/provider.test.ts:191-204`. Rename the test.
- src 0 / test 10 · risk low · effort S.
- Behavior: `toEqual(source)` still proves the action is passed through. Budget and nested-claim rejection stay covered at `provider.test.ts:153-159,307-326` and `code-mode/protocol.test.ts:28-57`.

### invocation/: 68 test

**T-mcp-auth-invocation-4: Add a `read(result | id)` helper to the invocation harness**

- `invocation/service.test.ts:102-1910` (15 sites).
- src 0 / test 38 · risk none · effort S.
- Behavior: the offset/limit read (526) and the nested Code Mode reads stay explicit.

**T-mcp-auth-invocation-10: Build the terminal-cleanup publication test from `realFixture({ open })`**

- `invocation/service.test.ts:332-342,382-383,1840-1924`.
- src 0 / test 20 · risk low · effort S.
- Behavior: the server is stdio, so admission ignores the auth token, and McpDiscovery sends no requests, so `sent` stays at 1.

**T-mcp-auth-invocation-16: Have `realFixture.harness(extra)` return the real-service harness**

- `invocation/service.test.ts:433-1287` (9 sites).
- src 0 / test 10 · risk none · effort S.
- Behavior: the wiring is unchanged. The helper must accept an auth override.

### resources/, prompts/, completion/, interaction/: 59 test

**T-mcp-rest-19: Extract subscription-stream helpers**

- `resources/subscriptions.test.ts:268-296,696-719,499-503,681-685`, plus six `events.read` sites between lines 391 and 730.
- Add `pauseFirstEvent`, `updated(id, uri)` and `expectNoEvents`. `updated()` can build on entry C's `sseFrame`.
- src 0 / test 30 · risk none · effort S.

**T-mcp-rest-21: Share one `fakeOperation` fixture**

- `prompts/operations.test.ts:40-69`, `resources/operations.test.ts:10-38`.
- src 0 / test 15 · risk none · effort S.

**T-mcp-rest-22: Hoist the repeated literals in the completion and interaction tests**

- `completion/operations.test.ts:65-131`, `interaction/service.test.ts:106-255`.
- Hoist the completion `input`, and add `onToolCall` and `countingDecline` to the interaction tests.
- src 0 / test 14 · risk none · effort S.
- Behavior: `countingDecline` must expose `asks` through a getter.

### Structural notes (unverified)

- Using entry B's stubs across the rest of the package would remove roughly 60 to 120 more lines. The three finders estimated ~60, ~60 and ~120.
- About 20 test files across the workspace deep-import `pi-code-previews/src/config/state.ts` and hand-build a Theme cast. Exporting `plainTheme` and `withPreviewSettings` from `pi-code-previews/testing` would save ~150 LOC workspace-wide, including ~20 from the `as Theme` stubs in 6 pi-mcp files.
- Source duplication: `src/boundary/host-ui.ts:19-140` and `src/boundary/host-auth-panel.ts:40-170` implement the same inert guard-overlay pattern. A shared helper would save ~60 LOC. This belongs to the src shard and would deepen T-mcp-boundary-16.
- Validation-notice and origin evidence is asserted at four layers: projection, code-mode-presentation, compact-summary and tool-renderer. Giving each layer one owner would prevent regrowth, ~60.
- The McpSettings literal is copied in six files: sdk-connection, sdk-stdio, connection/service, discovery/service, invocation/service and optional-features. A `testSettings(overrides)` would save ~40, partly overlapping entry D.
- The live expired-session test at `connection/service.test.ts:1079-1163` hand-rolls a JSON-RPC HTTP server. Exporting sdk-http.test's `realFixture` and `resultBody` would save ~30.
- The real-process subscription tests at `sdk-stdio.test.ts:858-1163` test service fencing, not the stdio boundary. Moving them beside the resources/subscriptions tests would let them reuse rest-19's `pauseFirstEvent` (clone at 1117-1125), and `pagination.test.ts:34-50` could adopt rest-21's `fakeOperation`, ~15-25.
- The 14-entry protocol-error matrix runs at 4 transport sites, 56 cases in all. One pure `mapSdkProtocolError` table plus 2 or 3 cases per site would drop ~44 cases. That saves ~0 LOC but cuts runtime.
- The Bearer-challenge syntax variants at `auth/discovery.test.ts:138-217` each start a live OAuth server. They could move into the parser table in `scopes.test.ts`, ~0 LOC but a runtime saving.
- Several tests are large but deliberately kept, each for the reason given:
  - The six-behavior scenario at `invocation/service.test.ts:558-760` (200 lines) would not shrink if split; split it only if failures become hard to diagnose.
  - The `op.shared` cancellation re-proof at `discovery/service.test.ts:555-584` (~30) is required for refresh paths by testing.md.
  - The hand-wrapped store recorder at `store.test.ts:311-333` could become a Proxy, but that needs casts (~15).
  - The near-presentation check at `controller.test.ts:311-325` protects visibility of refresh-failed state next to retained entries (~15).
- Small items, together ~30 LOC:
  - In `modern.test.ts`, the legacy era overlaps legacy.test (~8).
  - Minor policy items (~8): the `intents` wiring assertion, a duplicate `challenge.test.ts:23`, request-guidance wording checks, and a no-op `failRefresh = false`.
  - `sdk-auth.test.ts:620-631` asserts the exact progress-phase order; this could be loosened if the order is not a contract (~8).
  - The unused `grantTypes` option in `fixtures/oauth-server.ts` (~5).
- Exact-wording assertions in result-view, discovery notices and diagnostics were kept as safety guidance, ~0 LOC. `lifecycle.test.ts:72-89` may not need a real temp directory, which would save ~15; this was not verified.

### Needs a decision

There are no disputed findings, and no spot-check demotions. For reference, one finding was dropped: T-mcp-rest-25 would have loosened exact UI-copy assertions. Deleting `tool-renderer.test.ts:443-445` would lose preview-renderer coverage that compact-summary does not replace. Without that deletion only about 3 lines would be saved, and lines 147-148 guard the exactly-once warning ownership that tool-presentation.md requires.

Some confirmed entries give up a real-socket or live-process run in exchange for coverage at a fake seam: T-mcp-boundary-8, T-mcp-boundary-15 and T-mcp-connection-discovery-8. The verifiers accepted each one. The maintainer may still want to keep one live smoke test per transport.
