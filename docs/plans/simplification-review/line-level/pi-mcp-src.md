## pi-mcp (source)

After deduplication, 56 confirmed findings become 52 entries. Four merges remove double counting: the gateway action list, the scoped listener subscription, the descriptor-reader reuse, and the owned-overlay finish guard. Together the entries remove about **814 source LOC and 36 test LOC**. Almost everything is effort S and risk none or low. The value falls into five themes:

- **Transport boundary (207 src).** Hand-rolled HTTP option bounds, a dead request-size re-check, per-action SDK request boilerplate, and single-implementation interfaces.
- **Tool, result and Code Mode projection (175 src / 26 test).** Per-server result revocation that production never uses, duplicated descriptor readers, and two JSON byte counters.
- **Connection, discovery and config wiring (199 src).** Hand-copied action lists, a 43-case diagnostic switch, and hand-restated types.
- **Manager, UI and host adapters (114 src / 9 test).** A schema round trip over already-typed data, and dead card fields.
- **Auth (119 src / 1 test).** Phase switches that can become lookup tables, and a deadline-bounded dialog repeated four times.

I opened the code for the 8 largest entries and checked each claim. All 8 hold, and none was demoted. mcp-auth findings 1, 2, 7 and 8 were also applied together in a scratch copy, where tsc, oxlint and the full pi-mcp suite (1293 tests) passed. Paths are relative to `packages/pi-mcp/` unless they start with `packages/` or `scripts/`. In this section, negative test LOC means the tests grow.

| Category             | Entries | Source LOC | Test LOC |
| -------------------- | ------: | ---------: | -------: |
| verbose-code         |      12 |        238 |        0 |
| duplication          |      11 |        186 |        0 |
| dead-code            |      12 |        156 |       22 |
| shared-helper-reuse  |       5 |         79 |        0 |
| redundant-validation |       5 |         72 |        5 |
| over-generalization  |       4 |         58 |       -1 |
| indirection          |       2 |         15 |       10 |
| boilerplate          |       1 |         10 |        0 |
| **Total**            |  **52** |    **814** |   **36** |

### Transport boundary (`src/boundary/sdk-*`, `mcp-protocol/`): 207 src

**mcp-transport-2: Use an Effect Schema struct for the HTTP option bounds and derive `SdkHttpSnapshot`**

- `src/boundary/sdk-http-options.ts:24-36,43-61,63-149`, following the pattern in `src/boundary/sdk-stdio.ts:69-93`.
- Replace the `MAX_*` constants, `positiveBounded`, the five bounded calls and the five-way undefined check with a struct: `Schema.optional(positive(max))` fields plus `Schema.optional(Schema.Literals(["auto","legacy"]))`, decoded with `decodeUnknownSync` inside the existing `Effect.try`. Merge the URL, fetch and onCleanup checks into one throw, fill defaults with `??`, and use `type SdkHttpSnapshot = Effect.Success<ReturnType<typeof snapshotOptions>>`. Sharing `positive` with sdk-stdio would save about 6 more lines (not counted).
- src 50 / test 0 · risk low · effort M · spot-checked. The count is measured after mcp-transport-1; the verifier's draft went 147 → 93.
- Behavior: the accept and reject sets and the maxima are identical. `Schema.optional` still treats an explicit undefined as "use the default". Every failure still maps to `invalidHttpOptions()`, and only the order of the failing checks changes.

**mcp-transport-1: Remove the dead HTTP `requestBytes` option and the second request-size encode**

- `src/boundary/sdk-http-options.ts:16,32,101-105,115,142`, `src/boundary/sdk-http-request.ts:7,10,27-33,84-95,178-181`, `src/boundary/sdk-client.ts:242-260`.
- Drop `requestBytes` from `SdkHttpOptions` and `SdkHttpSnapshot`, and delete `requestByteLength` with the flatMap and ternary around it.
- src 28 / test 0 · risk low · effort S · spot-checked. The verifier measured 9 + 33 lines.
- Behavior: no `openSdkHttp` caller passes `requestBytes`, and `decodeMcpRequest` already encodes the request and rejects it at `MCP_BOUNDARY_LIMITS.requestBytes` with the identical error. The second check can never fail.

**mcp-transport-3: Collapse the per-action boilerplate in `executeSdkRequest`**

- `src/boundary/sdk-client.ts:157-240`.
- Add a local `send<Output>(method, params, schema)` and `page(cursor)` (no spread, so the spread lint rule does not apply). Each case becomes `return send<...>(...)`. Keep the `SdkResult` union and the explicit generics.
- src 28 / test 0 · risk none · effort S · spot-checked. The verifier's scratch copy went 271 → 243.
- Behavior: method strings, params, schemas and merged options are identical, and the export and signature do not change.

**mcp-transport-4: Drop the single-implementation `SdkHttpTransportOperation` and `SdkHttpTransportRegistry` interfaces**

- `src/boundary/sdk-http-transport.ts:45-67,144,203,211-219,461-463,479-483,496,517,534`, `src/boundary/sdk-http-request.ts:21-25`, `src/boundary/sdk-http.ts:41-47,128,142`.
- Use the classes as the types. Write `registry.current()` and `operation ? registry.run(operation, send) : send()`.
- src 22 / test 0 · risk none · effort S. A verifier recounted about 28.
- Behavior: the classes are the only implementations, and `current` and `run` are always defined.

**mcp-transport-6: Inline `bindRequestIds` and `markResponses`**

- `src/boundary/sdk-http-transport.ts:451-471,498-501,537`.
- The SDK 2.0 `Transport` `send` and `onmessage` carry single messages, so inline the `isJSONRPCRequest` checks. Adjusted: the onmessage check needs `&& message.id !== undefined` to typecheck.
- src 18 / test 0 · risk low · effort S.
- Behavior: the same checks run on the only shape that can occur, and `Map.get(undefined)` already returned undefined.

**mcp-transport-9: Derive the stdio TS types from the adjacent Schemas**

- `src/boundary/sdk-stdio-transport.ts:21-28,46`, `src/boundary/sdk-stdio.ts:52-67,75-93`.
- Type the factory as `static of(kind: SdkStdioTransportError["kind"])`. Define `SdkStdioOptions = typeof OptionsSchema.Type & { readonly onCleanup?: ... }` and move the environment doc comment onto the schema field.
- src 18 / test 0 · risk none · effort S. A verifier recounted 20.
- Behavior: type-only. The one test annotation still typechecks.

**mcp-transport-8: Delete the dead `NativePromise` ES2024 shims**

- `src/boundary/mcp-protocol/select.ts:43-50,74`, `src/boundary/sdk-stdio-transport.ts:51-59,97,267`.
- Call `Promise.withResolvers<void>()` directly. The pi-mcp tsconfig already includes `ES2024.Promise`, and keychain.ts and auth-fetch.ts already use it.
- src 16 / test 0 · risk none · effort S. A verifier recounted 19.
- Behavior: the runtime function is the same, and pi-code-mode's program does not reach these files.

**mcp-transport-10: Tighten the repeated method tests in `SdkEvents.bindTransport`**

- `src/boundary/sdk-events.ts:300-308,342-386`.
- In send, merge the two subscription `if`s into one guarded block. In onmessage, bind `const method = "method" in message ? message.method : undefined` once.
- src 11 / test 0 · risk none · effort S. The scratch copy went 429 → 417.
- Behavior: same predicates in the same order, and the early returns stay.

**mcp-transport-5: Remove the constant registry generation and the unreachable tag-length guard**

- `src/boundary/sdk-http-transport.ts:76,145,153-161,207-215,221-229`, `src/boundary/sdk-http.ts:133`, and tests `boundary/sdk-http.test.ts:492` and `boundary/sdk-fetch.test.ts:30`.
- Drop the always-1 `generation` parameter and fields and `OPERATION_TAG_MAX`, and write `` const tag = `g1:o${this.nextOperation++}` ``. Update the two test constructor calls and the stale JSDoc. Apply it together with or after mcp-transport-4.
- src 8 / test 0 · risk none · effort S. A verifier recounted up to 13.
- Behavior: nothing reads the field. The tag is private and is stripped before sending, and the guard is unreachable.

**mcp-transport-7: Alias the identical `SdkHttpTraffic` lease methods**

- `src/boundary/sdk-http-transport.ts:94-114`.
- Write `bodyStarted = this.fetchStarted`, `fetchFinished = () => this.releaseResource()` and `bodyFinished = this.fetchFinished`.
- src 8 / test 0 · risk none · effort S.
- Behavior: the same functions run under both names. No subclass overrides them, and field initializer order makes the aliases safe.

### Tool, result and Code Mode projection: 175 src / 26 test

**mcp-tools-results-3: Remove per-server result revocation and `serverGenerations`**

- `src/results/service.ts:19-25,50-61,84-97,197-226`, `src/results/model.ts:64-71,106`, and tests `results/service.test.ts:220-242`, `ui/compact-summary.test.ts:42`, `ui/tool-renderer.test.ts:104,138`.
- Change the contract to `revoke: () => Effect<void>`, a single `Ref.update`. Drop the `serverGenerations` state and the `serverGeneration` stamps. Delete the per-server test and change the results `revoke("x")` test calls to `revoke()`.
- src 20 / test 26 · risk none · effort S · spot-checked.
- Behavior: the only production caller is `results.revoke()` at `tools/service.ts:90`. Without the per-server path every check compares 0 to 0.

**mcp-tools-results-4 + mcp-ui-manager-3: Reuse `ownPresentationField` and `presentationArrayLength` instead of the re-implemented descriptor readers**

- `src/ui/content-preview.ts:58-80`, `src/ui/compact-summary.ts:13-31`, `src/code-mode/protocol.ts:91-103`. The shared helpers are in `src/code-mode/presentation-evidence.ts:9-31`.
- Delete content-preview's `DisplayField`, `own` and `arrayLength`, and import the helpers under those aliases, as tool-render-details already does. Write `decodeOwnField` as `decodeSafely(schema, ownPresentationField(value, key).value)`. `searchQuery` becomes `own(args, "query").value` plus the string and length check and the sanitizers.
- src 31 / test 0 · risk none · effort S · spot-checked. The 31 is mcp-tools-results-4's 22 plus the searchQuery part of mcp-ui-manager-3 (28 − 19 overlapping content-preview lines).
- Behavior: `.value` matches for non-objects, missing keys, accessors and throwing proxies, and the decoded schemas reject `undefined`. The only step that can throw stays guarded, and no import cycle is created.

**mcp-tools-results-1: Share one JSON-escaped string byte counter**

- `src/code-mode/protocol.ts:224-255`, `src/validation/schema-policy.ts:262-300`.
- Export `jsonStringBytes(text)`, returning `{ escaped, raw }`, from schema-policy.ts. Leave its return type inferred: an annotated one fails anti-slop `no-known-value-widening`. `mcpCodeModeJsonFits.string` and `snapshotJson.addBytes` then call it.
- src 25 / test 0 · risk low · effort S.
- Behavior: the escape costs are identical, and a fuzz run over 200k strings matched. The length prechecks still bound the loop, and because the budgets are monotone, one final charge is equivalent.

**mcp-tools-results-5: Deduplicate the presentation evidence reads in `code-mode/issues.ts`**

- `src/code-mode/issues.ts:43-48,123-130,165-173,249-251`, `src/code-mode/presentation-evidence.ts:32-41,44-57`.
- (a) Use `presentationValidationIdentity`. (b, c) Replace the `isArray` closure and the length re-reads with `presentationArrayLength`. (d) Write `presentationOutcome` as `(["completed","not-sent","unknown"] as const).find(...)`; the `=== ? value` form fails tsc.
- src 22 / test 0 · risk none · effort S.
- Behavior: the same fields and arguments are read. A real array's length is always an own property, and the non-array `incomplete` flag is already set at presentation.ts:166-168.

**mcp-tools-results-2: Collapse the `withOperation`/`projectOperation` boilerplate in `McpExecution.dispatch`**

- `src/tools/service.ts:62-80,101-121,128-145,172-220,228-276,279-303,316-344,363-371`.
- Add local `checked`, `completed`, `serverJson` and `invoke` helpers. Drop the proposed `LOCAL_ACTIONS` Set, which adds lines. Type the `intent` default through a named type so `no-known-value-widening` does not fire.
- src 20 / test 0 · risk low · effort M.
- Behavior: only elicitation errors are mapped, as before. The logged operation spreads the original, and `notices: []` is equivalent to omitting them. It touches the same switch as mcp-tools-results-8 without conflict.

**mcp-tools-results-8: Drop test-only optional contract members and dead fields**

- `src/tools/service.ts:33-50,128-171,418-424`, `src/connection/model.ts:51,110-121`, `src/interaction/model.ts:20-22`, `src/boundary/host-ask-user.ts:47-48`.
- Make `resourceSubscriptions`, `unsubscribeResource`, `readEvents` and `subscribeResource` required, and delete the fallback replies and the "unavailable" guard. Remove `McpExecutionContract.available` and `McpInteractionProvider.generation`. The test fakes change by +7/−7.
- src 16 / test 0 · risk none · effort S.
- Behavior: the only production implementations always provide these members, and nothing reads the removed fields.

**mcp-tools-results-7: Use core `invokeHostCallback` in the code-mode protocol**

- `src/code-mode/protocol.ts:80-89,165-197`.
- Implement `decodeSafely` with `invokeHostCallback` and delete `containThenable`. The respond wrapper uses `Predicate.isPromiseLike` plus `.then(noop, noop)`. Keep the boundary comment.
- src 15 / test 0 · risk low · effort S.
- Behavior: throws are still swallowed and rejected thenables are still contained. Only a hostile `then` getter could observe the extra reads.

**mcp-tools-results-9: Remove the single-valued `SnapshotLimits` fields and the `setRoot` callback**

- `src/validation/schema-policy.ts:103-117,214-261,413-454`.
- Read the document depth and node limits from `JSON_SCHEMA_VALIDATOR_LIMITS` inside `snapshotJson`, destructured into locals. Store the root in a one-element holder array.
- src 12 / test 0 · risk none · effort S. The verifier measured 15.
- Behavior: all three callers pass the same constants, and the root goes through the existing array branch.

**mcp-tools-results-10: Derive log severity from `McpLogLevel.literals`**

- `src/observations/model.ts:14-23`, `src/boundary/sdk-http-observations.ts:6,29-32`.
- Use `McpLogLevel.literals.indexOf(level)`, optionally inlined at the single call site, and add a comment that the order is RFC 5424 severity.
- src 9 / test 0 · risk none · effort S.
- Behavior: the literal order equals the table's 0..7 values.

**mcp-tools-results-11: Remove the unreachable post-loop return**

- `src/interaction/conversation.ts:51,65-70,150-155`.
- Use `for (let round = 0; ; round++)`. Optionally use `>=` in the in-loop limit check for robustness.
- src 5 / test 0 · risk none · effort S.
- Behavior: `rounds` is frozen at 8, and the in-loop check always returns on the last round.

### Connection, discovery, config and application wiring: 199 src

**mcp-connection-discovery-1 + mcp-tools-results-6: Share constants for the gateway and discovery action lists**

- `src/tools/model.ts:13-78`, `src/tools/controller.ts:23-49`, `src/application/lifecycle.ts:59-98`, `src/discovery/model.ts:123-134`, `src/discovery/diagnostics.ts:27-38`, `src/client/diagnostics.ts:319-330`.
- Export `MCP_GATEWAY_ACTIONS` in the controller's order, optionally with `satisfies ReadonlyArray<McpGatewayRequest["action"]>`. Use it for the TypeBox enum and in lifecycle as `Schema.is(Schema.Literals(...))`, which drops the Option import. Export `MCP_DISCOVERY_ACTIONS`, derive `McpDiscoveryRequest` from it, and replace two runtime arrays. Optionally use `enum: [...McpLogLevel.literals]`.
- src 35 / test 0 · risk none · effort S · spot-checked. mcp-tools-results-6 measured the gateway half alone at 13, after the controller import wraps.
- Behavior: the model-facing enum stays byte-identical and the membership sets are identical. The order of the literals in lifecycle is not observable.

**mcp-connection-discovery-2: Replace the diagnostic switch with reason and kind lookup tables**

- `src/client/diagnostics.ts:21-316`.
- Add a `Partial<Record<Reason, tuple>>` table and a kind table with a signIn marker. Keep the three dynamic cases as explicit `if`s. Use `Object.hasOwn` or a null-prototype table, and guard `reason === undefined`.
- src 22 / test 0 · risk low · effort M.
- Behavior: titles, explanations, recovery, severity and fallthrough are the same; oauth-coordination-timeout still reaches the kind table. The positional tuples read slightly worse than the switch.

**mcp-connection-discovery-5: Trim the discovery service and pagination boilerplate**

- `src/discovery/service.ts:60-65,377-380,390-409,423-427,437-465,504-507,517-520`, `src/discovery/pagination.ts:125-128,164-167`.
- Yield `boundaryError(...)` directly. Add module-local `localFailure(message)` and `commitChecked(operation, effect)` helpers, and drop the braces in the `.filter`.
- src 22 / test 0 · risk none · effort S.
- Behavior: the errors and commit semantics are the same, and publication is still infallible.

**mcp-connection-discovery-3 + mcp-ui-manager-9: Compact the scoped listener-set subscriptions**

- `src/connection/registry.ts:658-667,699-712`, `src/discovery/service.ts:476-485`, `src/auth/flow.ts:72-82`, `src/manager/service.ts:185-195`.
- Two options:
  - **Option A (mcp-connection-discovery-3, adjusted):** add `scopedMember(set, value, guard = identity)` to pi-cosmic-core coordination and use it at all five sites, with the registry revocation site passing `withLock`. This also needs one ARCHITECTURE line and a small core test of about 15 lines.
  - **Option B (mcp-ui-manager-9, adjusted):** skip the helper and write expression-bodied `acquireRelease(...).pipe(Effect.asVoid)` at the four unlocked sites, about 5 lines saved each.
- src 18 / test 0 · risk none · effort S. 18 is the conservative figure; Option A is estimated at about 33 across five sites.
- Behavior: acquire and release are identical, `asVoid` restores the void contract, and the guard keeps the locked revocation path. results/service.ts and the non-Effect subscribers are out of scope.

**mcp-connection-discovery-9: Derive `McpSettings` and `McpSettingsPatchSchema` from `McpSettingsSchema`**

- `src/config/model.ts:58-66`, `src/config/schema.ts:6,53-62`.
- Use `type McpSettings = typeof McpSettingsSchema.Type` with a type-only import, and `McpSettingsPatchSchema = McpSettingsSchema.mapFields(Struct.map(Schema.optionalKey))`. Drop the schema.ts → model.ts import.
- src 15 / test 0 · risk none · effort S.
- Behavior: the struct has no struct-level checks and the field checks are kept. Exact-optional patch keys were verified on rc.112.

**mcp-connection-discovery-4: Trim local verbosity in the registry**

- `src/connection/registry.ts:57,67,224-230,537-573,685-696`.
- (a) Write `status` and `config` as `withLock(trustLocked.pipe(Effect.andThen(...)))`.
- (b) Reuse `isToolAllowed`, which adds a connection → discovery/policy import with no cycle.
- (c) Only bind owner and suspension once. The separate-statement optional field additions stay, because `anti-slop/no-conditional-empty-object-spread` requires them.
- (d) Inline `McpConnectorContract`.
- src 14 / test 0 · risk low · effort S.
- Behavior: `Effect.sync(() => config)` still reads lazily after the trust check. isToolAllowed's extra conditions are already true at that point, and the error text is the same.

**mcp-connection-discovery-7: Use `invokeHostCallback` for the lifecycle and layer try/catch, and share the tool-conflict check**

- `src/application/lifecycle.ts:266-275,422-438`, `src/layer.ts:36-42`.
- Add a `foreignTool` thunk and a `CONFLICT_NOTICE` constant in lifecycle. Write `isTrusted = () => invokeHostCallback(() => input.isTrusted() === true, false)`, adding the name to layer.ts's existing pi-cosmic-core import.
- src 13 / test 0 · risk none · effort S.
- Behavior: `invokeHostCallback` is exactly try, return, catch, fallback, and the notice text and order do not change.

**mcp-connection-discovery-6: Deduplicate the observation guard and the token-access pipeline in `operation.ts`**

- `src/connection/operation.ts:46-58,96-99,117-158,284-287`.
- Add an `observable()` predicate after `let observing`. Make the token pipeline a thunk, `accessToken = () => registry.access(...).pipe(...)`, not a hoisted value, because test doubles read mutable state at call time.
- src 12 / test 0 · risk low · effort S.
- Behavior: the same predicates run at callback time, and access is still invoked at dispatch.

**mcp-connection-discovery-11: Use core `freezeSnapshot` instead of `freezeMetadata(structuredClone(...))`**

- `src/discovery/pagination.ts:64-74`, `src/discovery/collect.ts:11,88-109`.
- Call the existing core `freezeSnapshot` inside the existing `Effect.try` and delete `freezeMetadata`. Keep `isContainer` for `chargeMetadata`.
- src 11 / test 0 · risk low · effort S.
- Behavior: the input is schema-decoded finite JSON, and any throw maps to the same output-limit error.

**mcp-connection-discovery-12: Fold `issue` and `issueDependency` into one method (low priority)**

- `src/connection/admission.ts:39-71`, `src/connection/operation.ts:221`, `src/connection/service.ts:78`.
- Make `issue(server, now, dependency = false)` public and keep the doc comment. Call `issue(id, now, /* dependency */ true)` and rename the four test calls.
- src 9 / test 0 · risk none · effort S.
- Behavior: the same code path runs. A verifier cautions that it breaks the calls in `tests/connection/admission.test.ts` and swaps a named seam for a boolean flag.

**mcp-connection-discovery-10: Drop the redundant `applyChange` guard and the decode boilerplate in `config/store.ts`**

- `src/config/store.ts:131-188,203-210,218-227,236-243`.
- Remove the inner `guardScope` wrapper, since all three callers guard first. Add a `mutableRecord(v)` helper and yield `boundaryError` directly. Add a one-line comment that callers must guard.
- src 8 / test 0 · risk low · effort S.
- Behavior: error precedence is unchanged. The trade-off is losing a defense-in-depth check in a security-relevant store.

**mcp-connection-discovery-14: Derive the restated model types (adjusted)**

- `src/discovery/model.ts:113-122,183-189`, `src/connection/model.ts:18-23`.
- Write `McpMetadataSummary = Pick<McpMetadataSnapshot, ...> & Readonly<Record<McpCachedFamily, number>>` and `McpCachedDetail extends McpCachedEntry`. Keep `McpActionBinding` as its own interface, because it is a distinct authority concept.
- src 8 / test 0 · risk none · effort S.
- Behavior: types only, and the shapes are structurally identical.

**mcp-connection-discovery-8: Curry `rawExecute` over the session triple**

- `src/application/lifecycle.ts:177-233,284-294,335-338`.
- `executor(input, token, execution)` returns the per-request function, bound once per activation as `run`.
- src 7 / test 0 · risk none · effort S.
- Behavior: the closure values are the same, and `current` and `slot` still resolve at call time.

**mcp-connection-discovery-13: Remove the unused discovery-notice re-exports from `pi-mcp/code-mode`**

- `src/protocol.ts:8-13`.
- Delete the re-export block.
- src 5 / test 0 · risk none · effort S.
- Behavior: no importer uses the code-mode entry point for these symbols, and the package is private.

### Manager, UI and host adapters: 114 src / 9 test

**mcp-ui-manager-1: Drop the `RefreshFeedback` schema round trip**

- `src/manager/controller.ts:23,29-76,196-216`, `tests/manager/outcome.test.ts:5-46`.
- Split out `successfulMcpOutcome(action, metadata?)`, which reads the typed `McpMetadataSummary` directly, and call it from `runMcpManager`. Delete `RefreshFeedback`, make the `MCP_DISCOVERY_LIMITS` import type-only, and rewrite the refresh test cases.
- src 27 / test 5 · risk low · effort S · spot-checked.
- Behavior: the only producer that reaches the decode is `runMcpManager`, which already has typed data. TUI `/mcp refresh` returns `reply(action, null)`, and the non-TUI path JSON-stringifies its reply. Out-of-range counts cannot occur because each family is capped at 1000.

**mcp-ui-manager-4: Remove the dead and duplicate `McpCardDetails` fields**

- `src/ui/tool-render-details.ts:21,58-60,79,130,149,213-248,274-286`, `src/ui/compact-summary.ts:94`, and tests `ui/compact-summary.test.ts:51,58,117`, `ui/tool-renderer.test.ts:12,112`.
- Delete `metadata`, `counters`, `undiscoveredCount`, `addCounter` and the `MCP_CARD_LIMITS` alias, and read `card.counts[0]` in compact-summary. Delete the assertions on undiscoveredCount copy rather than rewriting them.
- src 16 / test 2 · risk none · effort S.
- Behavior: no render path reads the removed fields, and `counters[0]` equals `counts[0]` in the only branch that reads it.

**mcp-ui-manager-10: Use one label table for blocked reasons**

- `src/ui/actions.ts:5-40`, `src/ui/dashboard.ts:24-33`, `src/manager/policy.ts:8-19`.
- Add `blockedLabel` to policy.ts with `satisfies Record<Exclude<McpManagerBlocked, "not-applicable">, string>`, plus a four-entry tone table for the dashboard.
- src 11 / test 0 · risk none · effort S.
- Behavior: the strings are identical, and `satisfies` keeps the lookup exhaustive.

**mcp-ui-manager-6: Remove the unused named re-exports from the root `index.ts`**

- `index.ts:2-11`.
- Keep only `export { default } from "./src/extension.ts"`.
- src 10 / test 0 · risk low · effort S.
- Behavior: the package is private, the scripts use index.ts only as a Jiti anchor, and the exports map does not change.

**mcp-ui-manager-8: Use `Effect.fromOption`'s `onNone` for the busy permits**

- `src/boundary/schema-validator.ts:212-218`, `src/manager/service.ts:177-183`, `src/auth/flow.ts:224-230,359-369`.
- Write `Effect.flatMap(Effect.fromOption(() => boundaryError("busy", ...)))` at each site.
- src 10 / test 0 · risk none · effort S.
- Behavior: the Some/None mapping is the same. The dual form was confirmed in rc.112.

**mcp-ui-manager-5: Stop building Ask User cleanup errors that `Effect.ignore` discards**

- `src/boundary/host-ask-user.ts:65-84,91-96`.
- Write `Effect.tryPromise(() => settlement).pipe(Effect.interruptible, Effect.timeout(ms), Effect.tap(joined = true), Effect.ignore)`, and leave the one remaining error literal inline.
- src 9 / test 0 · risk none · effort S.
- Behavior: `timeout` is `timeoutOrElse` failing with TimeoutError on the same deadline, so `joined` is still set only when settlement succeeds in time.

**mcp-ui-manager-7 + mcp-auth-9: Share `finishOwnedOverlay` through pi-cosmic-ui (cross-package)**

- `src/boundary/host-ui.ts:52-62`, `src/boundary/host-auth-panel.ts:48-60`, `packages/pi-cosmic-ui/src/boundary/host-activity.ts:301-312`, `packages/pi-ask-user/src/boundary/host-tui.ts:14-23`.
- Move pi-ask-user's helper into a pi-cosmic-ui boundary module. The reviewers disagree on the target:
  - mcp-ui-manager-7 prefers `host-viewport.ts`, which is already exported and imported by host-ui.
  - mcp-auth-9 prefers `host-input-dock.ts`, which pi-mcp and pi-ask-user already import.
  - At the `let`-based sites, capture the narrowed `hostDone` and `requested.value` in consts. Update the ownership line in both ARCHITECTURE.md files.
- src 9 / test 0 · risk none · effort S. The 9 is mcp-ui-manager-7's estimate; mcp-auth-9 estimates 16 across all four packages.
- Behavior: the order stays hide, inert guard, done, guard.hide, inside each caller's existing try/catch.

**mcp-ui-manager-12: Remove interface members that only tests read**

- `src/boundary/host-ui.ts:13,31,66,98`, `src/boundary/host-mcp-status.ts:36,91`, and tests `boundary/host-ui.test.ts:213-234`, `boundary/host-mcp-status.test.ts:94-100,204`.
- Delete `McpOverlayHost.signal` with its AbortController, and `McpStatusHost.isActivityAvailable`. Delete the test calls outright, because the adjacent status assertions already cover them.
- src 6 / test 3 · risk none · effort S.
- Behavior: no production code reads either member.

**mcp-ui-manager-14: Add menu and browse-reset helpers to `McpManagerComponent`**

- `src/ui/manager.ts:263-338,283-285,328-330,373-375,437-439`.
- Add `openMenu<A>(page)`, which supplies the host fields, the shared cancel and focus. Add `restartBrowse()` for the reset triple.
- src 6 / test 0 · risk none · effort S.
- Behavior: the menu options, cancel, focus and reset order are the same.

**mcp-ui-manager-13: Simplify schema-validator (unused layer options, test-only re-export, boolean union)**

- `src/boundary/schema-validator.ts:22-23,41-44,229-231`, `src/layer.ts:78`, `tests/fixtures/optional-features.ts:191`, `tests/boundary/schema-validator.test.ts:10-14`, and `scripts/verify-mcp-compat.mjs:257`.
- Write `static readonly layer = Layer.effect(this, makeJsonSchemaValidator())` and update all three `.layer()` call sites. The untyped .mjs script would otherwise throw at runtime. Have the test import the limits from schema-policy, and use `Struct({ valid: Boolean })`.
- src 6 / test −1 · risk low · effort S.
- Behavior: the constructor is lazy, and the Boolean struct accepts and rejects the same replies under `onExcessProperty: "error"`.

**mcp-ui-manager-11: Drop the redundant receipt activation stamps (adjusted to host-tool-result.ts only)**

- `src/boundary/host-tool-result.ts:11-14,35,42-43`.
- Use `Map<string, McpGatewayReply>` and `if (receipt === undefined || event.details !== receipt) return;`. Keep the manager's `alive` Ref and `projection` SynchronizedRef: effect-v4.md requires Ref-owned state, and a code comment keeps the latches separate.
- src 4 / test 0 · risk low · effort S.
- Behavior: the map is cleared on activate and deactivate, and it stores receipts only for the current activation.

### Auth: 119 src / 1 test

**mcp-auth-1: Replace the auth phase union and two switches with lookup tables**

- `src/auth/progress.ts:6-21,49-111`.
- Add an `AUTH_PHASE_LABELS` const and derive `McpAuthPhase = keyof typeof ...` from it. Declare `AUTH_ACTIVITY_PHASES satisfies Record<McpAuthPhase, McpActivityPhase | undefined>`, not with a Partial annotation, which fails lint.
- src 40 / test 0 · risk none · effort S · spot-checked. The scratch copy went 121 → 81 with the full suite passing.
- Behavior: the labels, the mapping and the undefined terminal phases are the same. This is the same pattern as `MCP_ACTIVITY_PHASES`.

**mcp-auth-2: Use one deadline-bounded dialog helper and one liveness predicate in `host-auth.ts`**

- `src/boundary/host-auth.ts:53-59,72-102,110-121,144-178,180-201`.
- Add a `live()` predicate and a `dialog(deadline, open)` helper (check, remaining, tryPromise, check, remaining). Use them for approveScopes, both readCallback dialogs and nextAction.
- src 23 / test 0 · risk low · effort S.
- Behavior: the dialogs, timeouts and errors are the same, with one extra idempotent `check()`. Only an expiry and a revocation at the same moment could now report stale before expired.

**mcp-auth-3: Delete the test-only v1 grant codec**

- `src/auth/credentials.ts:1,3,42-57`, and tests in `auth/credentials.test.ts`, `auth/credential-store.test.ts`, `auth/sdk-auth.test.ts` and `auth/service.test.ts`.
- Remove `decodeGrant`, `encodeGrant` and their imports. Tests use `serialize` or a round trip through `decodeCredentialRecord(encodeCredentialRecord({version: 2, grant}))`.
- src 18 / test −5 · risk none · effort S.
- Behavior: production uses credential-record.ts, which still reads v1 grants.

**mcp-auth-7: Build plain literals instead of `Object.assign` optional-field ladders**

- `src/boundary/sdk-auth-challenge.ts:6-10,81-85`, `src/boundary/sdk-auth-discovery.ts:20,54-57`, `src/auth/scopes.ts:28-34`, `src/boundary/sdk-auth.ts:29-34,143-151`, `src/boundary/keychain.ts:23`, `src/boundary/credential-store.ts:95-97`.
- Widen the private optional fields to `?: T | undefined` and build the literals directly.
- src 14 / test 0 · risk none · effort S.
- Behavior: every consumer reads these fields with `=== undefined` or optional chaining, and the objects are never persisted. `discovery.source` is left alone.

**mcp-auth-8: Use `Buffer.concat` and `URL.parse`**

- `src/boundary/auth-fetch.ts:130-134,161-166`, `src/boundary/auth-callback.ts:47-50`.
- Replace the manual byte join and the throwing URL wrappers.
- src 10 / test 0 · risk none · effort S.
- Behavior: the bytes are identical. `URL.parse` returns null exactly where `new URL` throws, and it exists on every supported engine.

**mcp-auth-5: Remove the test-only `McpAuthFlow.snapshot` and its `latest` Ref**

- `src/auth/flow.ts:38,67,118-127,282,371`, `tests/auth/flow.test.ts:24-37`, and the stubs in the settings, application and lifecycle tests.
- Delete the contract member and the Ref. Keep a notify gate on the existing `counter` Ref (`Ref.getUnsafe(counter) === attemptId`). The flow.test harness subscribes instead (+4 lines), and three stub lines go away.
- src 8 / test −4 · risk low · effort S.
- Behavior: the admission permit serializes attempts, and the gate stays as defense in depth.

**mcp-auth-6: Merge `completeLogin` and `finalizationFailed` into `finishLogin(server, receipt, succeeded)`**

- `src/auth/model.ts:79-87`, `src/auth/service.ts:359,380-383,391-392`, `src/tools/service.ts:405-407`, and 10 test stub pairs.
- Expose the existing private function on the contract and delete the two forwards.
- src 6 / test 10 · risk none · effort S.
- Behavior: the same function runs. The trade-off is a boolean flag in place of two method names.

### Structural notes (unverified)

- **Owned-overlay lifecycle, ~80–150 lines.** It is reimplemented in 4 places: `openMcpOverlay` (host-ui.ts, ~125 lines), host-auth-panel.ts, pi-cosmic-ui host-activity.ts, and pi-ask-user host-tui/host-form-tui. A shared pi-cosmic-ui primitive needs a dedicated pass because cancellation ordering differs by site. mcp-ui-manager-7/mcp-auth-9 extract only the finish guard.
- **Bounded JSON walkers, ~230 lines.** checkConfigBounds, chargeMetadata, results/normalize copy(), schema-policy snapshotJson and mcpCodeModeJsonFits, plus the keyword sets in invocation/parameter-headers, each have their own node, depth and byte budgets. The budgets are observable, so merging would change what is accepted. Only the string counter (mcp-tools-results-1) is proposed.
- **Parallel Code Mode projections, ~120 lines.** code-mode/presentation.ts (notices) and code-mode/issues.ts (CompactIssues) project the same evidence. Unifying them would change strings that pi-code-mode consumes.
- **Transport connection shell, ~40 lines.** openSdkHttp and openSdkStdio repeat one shell (deadline budget, owner scope, cached close, forkIn/join, observe-with-timeout, makeConnection). Differences in cleanup ordering, the `protocol` publish and the messages block a mechanical merge.
- **Parallel discovery pipelines, ~40 lines.** discovery/service.ts `page()` and discovery/cached.ts `queryCached()` both rank, collect, sort and build `len:part` cursor signatures. A shared collector needs care with the cursor-binding strings.
- **Hostile-protocol helpers across packages, ~40 lines workspace-wide beyond mcp-tools-results-7.** decodeSafely, containThenable and normalize\*CodeModeQuery/Capability are duplicated across pi-mcp, pi-background-task and pi-cosmic-ui.
- **Code Mode capability hosts, ~40 lines.** The hosts in pi-mcp and pi-background-task share an activate/deactivate/dispose skeleton. Production activates once, and deactivate followed by dispose is redundant. The provider tests would need restructuring.
- **Settings command path, ~20 lines.** The TUI server-action path in settings/controller.ts repeats `runMcpManager`'s capture, confirm, gate and dispatch flow, and commandFailureAction re-parses the `/mcp` grammar. Merging them touches admission ordering.
- **Nested credential-store semaphore, ~20 lines.** The per-identity semaphore never contends in production, because the authority permit is always held first. Tests and ARCHITECTURE rely on it, so removing it is a design change.
- **activity/service.ts transitions, ~15 lines.** `update()` and `finish()` share find, terminal-guard, revision-bump and commit scaffolding.
- **connection/registry.ts size, 0 net.** At 716 lines it exceeds the 400–500 split guidance. The natural split point is openOwner's acquisition, event pump and terminal watcher (~135 lines).
- **Optional `McpLoginUi` members, ~12 lines.** `progress` and `waitForCallback` are optional only for tests, so the sdk-auth.ts fallback branch is dead in production. Removing them reworks the sdk-auth tests.
- **Transport micro-cleanups, ~12 lines.** Use `Exit` directly as an Effect at 4 sites, return early from the sdk-http-request cleanup ladder (~6), hoist `getNegotiatedProtocolVersion()`, and drop unused default params.
- **Unused result and activity limit options, ~12 lines.** Production never passes them, but tests use them as legitimate seams.
- **Hand-rebuilt card details, ~10 lines.** code-mode/issues.ts rebuilds `Pick<McpCardDetails>` by hand, duplicating the recoveryHint and notice-completeness logic in tool-render-details.
- **Remaining optional operation members, ~10 lines, net neutral.** `checkContinuation`, `exchange` and `operationId` stay optional after mcp-tools-results-8, and the test fakes would need stubs.
- **Duplicated authority predicate, ~8 lines.** The McpAuth `check` in layer.ts re-implements part of the registry's `serverLocked` predicate. A shared pure predicate could serve both.
- **auth-panel phase ternaries, ~8 lines.** They could become a table, but it may conflict with `no-known-value-widening`.
- **Auth candidates below threshold, ~8 lines.** A shared withTransaction plus permit wrapper (~0), merged keychain settle branches (4), deduplicated error factories (~3), narrowing the authJson union (lint-blocked), and an always-false resource check at sdk-auth.ts:103 (1).
- **Capability guards, ~6 lines.** The guards in completion/prompts/resources operations could share a `requireAdvertised` helper, but it has no natural home module.
- **Other transport sharing, ~5 lines each.** SdkErrorCode mapping is split across three sites with different messages. Legacy unsubscribe and modern listen close share a cleanup shape. The Transport forwarding boilerplate appears 3 times, but a helper nets only ~2.
- **Small tool and result items, ~4 lines each.** `McpToolControllerOptions.execute` takes constant maxOutputBytes and images and an ignored callId. `McpRetentionOutcome.reason` is read only by tests. `exchange`/`subscribeResource` could share an `admitted()` frame (~3).

### Needs a decision

- **mcp-auth-4: Drop the test-only flat `read`/`write`/`remove` methods from `McpCredentialStoreContract`** (`src/boundary/credential-store.ts:12,23-32,144-149`; src 17 / test −20).
  - For: it narrows the production contract to `withTransaction` and `mutation`, the only members auth/service.ts uses.
  - Against: about 47 test call sites need a local flat type and a `flat()` wrapper, so workspace LOC stays flat or grows slightly. Treat it as contract tidying, not a line-count reduction.
- **mcp-ui-manager-2: Collapse three `matchEffect` deliver branches into one generic `deliver(load, callback)` helper** (`src/manager/controller.ts:104-144`; claimed 10).
  - For: `orElseSucceed` and `matchEffect`'s onFailure both handle only typed failures, and the gating is unchanged.
  - Against: an oxfmt run at the real nesting depth measured a net of 4 (252 → 248), which is below the threshold.
- mcp-ui-manager-15 (the `credentialMutationBlocked` and retained-missing predicate extraction, 1–5 lines) is left out as trivial.
