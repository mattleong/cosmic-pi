## pi-better-openai

pi-better-openai has 4,862 source LOC and 4,459 test LOC (`wc -l` over `src/` and `tests/`). Verification confirmed 34 findings: 15 in source and 19 in tests. None are disputed and none were dropped. After deduplication the removable total is **152 source LOC and 447 test LOC**. The test findings sum to 448 on their own. Two overlaps of 2 lines each are subtracted once (see the dedup notes), and better-openai-14 adds 3 test lines. Source savings are spread thinly across small local cleanups. The largest are the CodexAuthError factory (better-openai-1, 18), the table-driven settings groups (better-openai-2, 15) and the compaction boundary error and usage type (better-openai-5, 13). Most of the value is in the tests. compaction-service.test.ts (973 lines) repeats full AssistantMessage literals, appendCompaction blocks, Responses-input conversions and recording clients, and together those account for 198 test LOC. I spot-checked the 8 largest findings (T-openai-5, T-openai-1, T-openai-8, T-openai-10, T-openai-9, T-openai-4, T-openai-2, T-openai-6) against the code, and all of them hold. None were demoted. Paths below are relative to `packages/pi-better-openai/`.

| Category                 | Src LOC | Test LOC | Findings |
| ------------------------ | ------: | -------: | -------: |
| test-fixture-duplication |       0 |      238 |        9 |
| test-redundancy          |       0 |      124 |        6 |
| verbose-code             |      62 |       58 |        8 |
| duplication              |      52 |        0 |        5 |
| test-policy-violation    |       0 |       24 |        2 |
| redundant-validation     |      12 |        0 |        1 |
| dead-code                |      11 |        3 |        1 |
| indirection              |       8 |        0 |        1 |
| over-generalization      |       7 |        0 |        1 |
| **Total**                | **152** |  **447** |   **34** |

Dedup notes: each overlap below is subtracted once, and the table uses the reduced counts.

- **T-openai-3 with T-openai-6:** both count removing the SAFETY cast at `tests/compaction-service.test.ts:205-206`. T-openai-3's verifier puts it at "2 more", conditional on T-openai-6. The cast stays under T-openai-6, and T-openai-3 drops from 12 to 10.
- **T-openai-8 with T-openai-17:** T-openai-8's site at `tests/sharp-process.test.ts:58-60` sits inside the SVG test that T-openai-17 deletes (55-62). T-openai-8 drops from 40 to 38. The deduction is my estimate: that site's 3-line `Effect.result` block would collapse to 1 line.

Apply these pairs together, because they touch the same code: better-openai-3 and better-openai-14(c) both edit the `registerSettingsController` options (`src/application.ts:344-353`). better-openai-6 and better-openai-9 both add exports to `src/image/types.ts`. T-openai-5 relies on T-openai-6's `testModel` default id, or on an explicit `model` override.

### Tests: compaction suites (198 test)

- **T-openai-5: Share one assistant-message and zero-usage builder across the compaction tests**
  - Where: `tests/compaction-projection.test.ts:18-34`; `tests/compaction-context.test.ts:51-72, 236-252`; `tests/compaction-service.test.ts:329-351, 435-442, 471-481, 658-679, 766-787`; `tests/helpers.ts:1-23`
  - Proposal: Export `zeroUsage` and `assistantMessage(content, overrides?: Partial<AssistantMessage>)` from tests/helpers.ts, defaulting to openai / openai-responses / gpt-5.5 with stopReason "stop". Use them to replace the three local builders and four inline literals, each of which carries an 8-line usage/cost block. Also use `zeroUsage` for `appendUsage` at compaction-service.test.ts:470.
  - Size: 0 src / 70 test (verifier recount was about 80 net). Risk: low. Effort: M.
  - Why behavior holds: message contents, stop reasons, ids and models are unchanged. The retry and native-summary messages move from 1/1/2 usage to zero, but no assertion reads assistant usage: tokensBefore comes from the fixed compactEvent, and the summary is asserted by its content.
  - Spot-check: confirmed seven full literals or builders of 17-23 lines each.
- **T-openai-1: Add one commit helper for the "expect result, then appendCompaction" blocks, plus fixture setters**
  - Where: `tests/compaction-service.test.ts:261-284, 483-494, 696-736, 802-876, 926-937`
  - Proposal: Add `commit(manager, result)`, which throws on undefined, calls `appendCompaction(..., true, result.usage)` and returns the result. The nine sites become `const result = commit(manager, yield* service.compact(event))`. Give `fixture()` `setEnabled`/`setModel` methods to replace the open-coded `MutableRef.set` blocks at 706-718 and 934-937.
  - Size: 0 / 46 (the verifier called 46 conservative). Risk: low. Effort: S.
  - Why behavior holds: every scenario keeps the same compaction sequence and assertions, and the moved assertions read only `result` or the client captures. The native-fallback and fail-closed entries would now store `result.usage`, but nothing asserts it and the service never reads entry usage.
  - Spot-check: confirmed nine `if (!x) throw` plus 7-8-line appendCompaction sites (262/277, 483/487, 696, 724/730, 802, 822/826, 837/844, 866/870, 926).
- **T-openai-4: Drop the post-loop ineligible-state block in the repeated-compactions test**
  - Where: `tests/compaction-service.test.ts:389-414`
  - Proposal: Delete the `for (const state of ["disabled", "model", "provider"])` block. Keep the ordinary-summary tail at 415-419.
  - Size: 0 / 26. Risk: low. Effort: S.
  - Why behavior holds: `filterContext` (`src/compaction/service.ts:191-206`) never reads config or model, so all three iterations run identical code. Chained repair stays covered by compaction-context.test.ts:192-232 and the native-fallback test (643-745), and ineligible inject no-ops by 525-559.
  - Spot-check: confirmed that filterContext uses only the branch and observed omissions.
- **T-openai-2: Share the Responses-input conversion and the recording compaction client**
  - Where: `tests/compaction-service.test.ts:247-255, 296-301, 360-368, 445-453, 495-502, 788-798, 855-860, 885-890`
  - Proposal: Add `responsesInput(model, messages)`, which wraps `convertResponsesMessages(model, normalizeContext(...), new Set(["openai"]), model.compat)`, and `recordingClient(prefix, usage = zeroTokens)`, which returns `{ requests, client }`. Use them at the five conversion sites and the three hand-rolled clients.
  - Size: 0 / 24. Risk: none. Effort: S.
  - Why behavior holds: `requestModel.compat` equals `{ supportsMidConvoSystemMessages }` at every site. The first test must pass its asserted 12/5/3/15 usage explicitly.
  - Spot-check: confirmed five 5-6-line conversions (296, 362, 497, 855, 885) and three 9-11-line clients (247, 445, 788).
- **T-openai-6 (adjusted): Share the test Model fixture in tests/helpers.ts**
  - Where: `tests/compaction-projection.test.ts:6-17`; `tests/fast-service.test.ts:18-29`; `tests/compaction-service.test.ts:45-60, 174, 205-206, 226-228, 430-432, 626, 752-754`
  - Proposal: Export only `testModel(id = "gpt-5.5", provider = "openai", api = "openai-responses")`. Replace the three local Model literals, the `{ ...model(), api: "openai-responses" }` narrowing spreads and the SAFETY cast. Keep each file's own preparation literal.
  - Size: 0 / 22. Risk: low. Effort: S.
  - Why behavior holds: the fixture values are identical, and projection's `target-model` id is only ever read through `model.id`. The verifier rejected sharing the preparation fixture because prepareOpenAIFallback's cut depends on `keepRecentTokens`, which is 100 in one file and 1000 in the other.
  - Spot-check: confirmed identical 12-16-line literals in all three files.
- **T-openai-3 (adjusted): Build the OpenAICompactionClient test layer once**
  - Where: `tests/compaction-service.test.ts:148-218`
  - Proposal: Add `clientLayer(body)`, which wraps `OpenAICompactionClient.layer(...)` over `jsonHttpTestLayer(() => Effect.succeed({ status: 200, body }))`. Keep each response body inline.
  - Size: 0 / 10 (12 in the input, less 2 for the cast that T-openai-6 already counts). Risk: none. Effort: S.
  - Why behavior holds: cached-token decoding and the fractional-usage `decode` failure stay covered.

### Tests: shared utilities and failure assertions (95 test)

- **T-openai-8: Use `Effect.flip` instead of `Effect.result` plus `_tag` narrowing for expected failures**
  - Where: about 19 sites: `tests/compaction-service.test.ts:205-215, 941-946, 963-970`; `tests/domain.test.ts:97-104, 116-122, 186-191`; `tests/image-protocol.test.ts:86-93, 100-119, 125-139, 158-166, 184-196`; `tests/image-resources.test.ts:64-72, 128-139, 168-177`; `tests/sharp.test.ts:54-58, 81-83`; `tests/sharp-process.test.ts:35-37, 66-70`
  - Proposal: `const failure = yield* effect.pipe(Effect.flip)`, then one `toMatchObject({ _tag, operation })` check. Leak checks serialize or `inspect` the flipped failure. Keep `Effect.result` at sharp-process.test.ts:76-92, where success is acceptable.
  - Size: 0 / 38 (40 in the input, less the sharp-process 58-60 site that T-openai-17 deletes). Risk: none. Effort: S.
  - Why behavior holds: the check is stricter, because an unexpected success now fails the test. The same tags, messages and secret-absence checks remain. The package already uses this pattern (config.test.ts:149, image-service.test.ts:183).
  - Spot-check: confirmed the nested `if (r._tag === "Failure")` narrowing at the cited sites.
- **T-openai-7: Share one ExtensionContext builder for the credential, image and fast-mode tests**
  - Where: `tests/domain.test.ts:23-36, 94-96, 112-114, 219-221`; `tests/image-service.test.ts:74-89, 159-171`; `tests/fast-service.test.ts:31-52`
  - Proposal: Export `testContext({ model?: () => unknown, token?: string | Error, oauth?: boolean })` with a getter-backed `model` and a single SAFETY cast. An Error token yields a rejected promise.
  - Size: 0 / 30. Risk: none. Effort: M.
  - Why behavior holds: model-read counting (image-service:142), dynamic model switching (fast-service) and the in-place `getApiKeyForProvider` mutation (domain:134) all keep working as long as the helper returns a plain mutable object.
- **T-openai-12: Move the small duplicated utilities into tests/helpers.ts**
  - Where: `tests/extension.test.ts:140-158`; `tests/settings-controller.test.ts:38-49, 115-119, 172-176, 205-209`; `tests/compaction-service.test.ts:62-64`; `tests/domain.test.ts:37-39`; `tests/compaction-context.test.ts:45`; `tests/image-protocol.test.ts:13-20`; `tests/image-resources.test.ts:16-21`
  - Proposal: Export a generic `deferred<Value>()`, `waitUntil(predicate)`, `serializedSnapshot` and `bytes`/`pngSharp`. Replace the three settings `Effect.promise(() => vi.waitFor(...))` blocks with `yield* waitUntil(...)`.
  - Size: 0 / 20. Risk: none. Effort: S.
  - Why behavior holds: the helpers run the same code, and the waits keep their polling semantics.
- **T-openai-19 (adjusted): Remove meaningless or copy-coupled micro assertions**
  - Where: `tests/compaction-service.test.ts:542, 549, 555-556`; `tests/extension.test.ts:224, 389`; `tests/domain.test.ts:192-197`; `tests/image-service.test.ts:193`; `tests/config.test.ts:151`; `tests/image-compact-summary.test.ts:54-59`
  - Proposal: Drop the void-result bindings, the redundant `not.toHaveProperty("data")` that follows `toEqual`, and the stale SAFETY comment. Merge the two domain leak checks into one regex. Loosen the timeout, invalid-setting and Saved-path copy checks to their semantic fields.
  - Size: 0 / 7. Risk: none. Effort: S.
  - Why behavior holds: the same outcomes stay asserted. Keep the per-status regexes at image-presentation-conformance.test.ts:161-165, which enforce the tool-presentation contract (the verifier excluded them).

### Tests: extension harness (77 test)

- **T-openai-10: Delete the inactive Cosmic UI host test**
  - Where: `tests/extension.test.ts:447-474`
  - Proposal: Delete the test.
  - Size: 0 / 29. Risk: low. Effort: S.
  - Why behavior holds: the package never calls `ctx.ui.setFooter`; only pi-cosmic-ui's footer installation does. The test's config rewrite equals the harness default. The visibility-policy test (402-445) covers the inactive-host status fallback, and 476-491 covers the failing-capability path.
  - Spot-check: confirmed that `grep setFooter src` is empty and that the rewritten config matches the harness default.
- **T-openai-9: Remove the render comparison that the image conformance suite already covers**
  - Where: `tests/extension.test.ts:7, 34-37, 176, 182-184, 242-265`
  - Proposal: Delete the setCapabilities/renderer string-inequality block, the renderer capture (keep a no-op `registerMessageRenderer() {}`), the pi-tui import and the `resetCapabilitiesCache()` afterEach call. Keep the payload assertions (207-240).
  - Size: 0 / 28. Risk: low. Effort: S.
  - Why behavior holds: image-presentation-conformance.test.ts:204-225 gets its renderer from the real registration and counts Image components for current and legacy messages in both modes, which is a stronger check.
  - Spot-check: confirmed.
- **T-openai-11: Let the extension harness take config overrides**
  - Where: `tests/extension.test.ts:39-67, 342-355, 369-383`
  - Proposal: Change the signature to `harness(dependencies?, config: Partial<TestConfigDocument> = {})` and spread the overrides over the default document. Delete the two per-test file rewrites.
  - Size: 0 / 20. Risk: none. Effort: S.
  - Why behavior holds: config is read at `session_start`, so writing it in the harness produces the same state.

### Source: image feature (`src/image/`) (47 src)

- **better-openai-6 (adjusted): Reuse the image-details guard in compact-summary and share the action/subject base**
  - Where: `src/image/compact-summary.ts:11, 50-69, 81-132`; `src/image/register.ts:27, 43-57`; `src/image/types.ts:81-98`
  - Proposal: Move `CodexImageDetails`, `isOptionalString` and `isCodexImageDetails` to types.ts. Importing them from register.ts would be circular. compact-summary becomes the guard plus the id-length and enum checks, and `optionalString` is deleted. Spread `base = { action, subject }` into the four returns. Update the ARCHITECTURE.md source map to say types.ts owns the shared guard.
  - Size: 12 / 0. Risk: none. Effort: S.
  - Why behavior holds: the acceptance predicate is the union of the same checks, and key order is kept.
- **better-openai-7: Collapse the three inode-identity comparisons into one `isOwned` predicate**
  - Where: `src/image/output.ts:127-157, 221-231`
  - Proposal: Add `isOwned(info)`, which checks type File plus ino and dev against `ownedIdentity`, and use it in removeOwnedTemporary, verifyPublicationSource and the post-link check. Keep the early `if (!ownedIdentity)` returns.
  - Size: 10 / 0. Risk: none. Effort: S.
  - Why behavior holds: because `ownedIdentity.ino` is a number, the equality already rejects an undefined inode. Syscall order, messages, the uninterruptible regions and the commit point are unchanged.
- **better-openai-10: Collapse the image renderer's image-source branching**
  - Where: `src/image/register.ts:96-109, 164-174`
  - Proposal: `const image = (content.find(isImageContent)) ?? (isLegacyCodexImageResult(details) ? details : undefined)`, with the filename read from `details?.savedPath`. Keep the ternary that omits `filename` (required by exactOptionalPropertyTypes).
  - Size: 10 / 0. Risk: none. Effort: S.
  - Why behavior holds: isLegacyCodexImageResult implies isCodexImageDetails, so the savedPath source is the same in both branches.
- **better-openai-9 (adjusted): Tidy the image service result assembly and share an error-thunk factory**
  - Where: `src/image/service.ts:22-32, 77, 105-108, 175-199`; `src/image/input.ts:35`; `src/image/output.ts:49`; `src/image/types.ts:104-105`
  - Proposal: Write `const savedPath = saveDir ? yield* persistImage(...) : undefined` and build a single result literal with `...(savedPath !== undefined && { savedPath })`. Do not use `? {} :`, which trips the oxlint rule anti-slop/no-conditional-empty-object-spread. Drop three redundant annotations and their imports, and export `failWith` from types.ts.
  - Size: 9 / 0. Risk: none. Effort: S.
  - Why behavior holds: the result has the same keys and key order, and inference produces the same literal unions.
- **better-openai-8 (adjusted): Make the image input reader accumulate its final shape directly**
  - Where: `src/image/input.ts:74-79, 90-120`
  - Proposal: Drop `size` in favour of `data.byteLength`, type the accumulator as `ImageInput[]`, and push `{ mimeType, data: base64 }` in the loop.
  - Size: 6 / 0. Risk: none. Effort: S.
  - Why behavior holds: validation order, limits, dedupe and messages are unchanged. Encoding each input to base64 inside the loop is not observable.

### Source: settings and application wiring (42 src)

- **better-openai-2: Build every settings picker group from one table**
  - Where: `src/settings/controller.ts:144-148, 196-276, 298-308`
  - Proposal: Give each table entry `{ id, label, description, submenuTitle, items: () => SettingItem[], summary }`. Add fast mode as the first entry and diagnostics as the last. `sections()` becomes a single `groups.map(...)` that calls createSettingsGroupSubmenu inline. The header class becomes an object literal.
  - Size: 15 / 0 (verifiers estimated 15-24). Risk: low. Effort: M.
  - Why behavior holds: ids, labels, submenu titles, summaries, row order and the `diagnostics` id are all kept, and `items` still reads the mutable `cfg` lazily.
- **better-openai-3 (adjusted): Give the settings controller a non-throwing config accessor**
  - Where: `src/application.ts:79-86, 108, 344-353`; `src/settings/controller.ts:39, 79-86, 103-106, 134-140, 278-280, 350-355`
  - Proposal: Pass `config: () => MutableRef.get(projection).config` (possibly undefined) to the controller, and delete `pickerConfig` and the three try/catch shims. Keep a throwing zero-arg accessor in application.ts for startup and formatDebugStatus. Add `if (!cfg && descriptor) return;` in applySetting, and delete the stale comment at controller.ts:131-133.
  - Size: 12 / 0. Risk: low. Effort: S.
  - Why behavior holds: all three shims only guard the `requiredConfig` throw. The applySetting guard keeps the current silent result when config is cleared mid-write.
- **better-openai-4 (adjusted): Share one contained host-command runner**
  - Where: `src/application.ts:7, 243-262, 269-286`; `src/image/register.ts:7, 189-211`; `src/boundary/host-ui.ts:1-20`
  - Proposal: Move `containCommandFailure(effect, ctx, { failed, unexpected, defect })` into `boundary/host-ui.ts` (asSome, catch to none, catchCause), constrained to `E extends { readonly message: string }`. runHostCommand must discard the Option with `Effect.asVoid`, because Pi's command handler type is `Promise<void>` and the verifier's tsc probe rejected `Promise<Option|void>`. The image command uses the Option to decide whether to send.
  - Size: 8 / 0. Risk: low. Effort: M.
  - Why behavior holds: notification text, severity, logs and interrupt handling are unchanged.
- **better-openai-15: Reuse refreshFooter and isUsageVisible in the event handlers**
  - Where: `src/application.ts:111-120, 380-395, 420-423`
  - Proposal: Define refreshFooter before the handlers and call it from agent_start and turn_end. Use `isUsageVisible()` in updateFooter, and a ternary in the session_before_compact `.then`.
  - Size: 7 / 0. Risk: none. Effort: S.
  - Why behavior holds: the same host calls run in the same order.

### Tests: image and sharp (38 test)

- **T-openai-14: Delete the parse-level stream-finalization test**
  - Where: `tests/image-resources.test.ts:24-43`
  - Proposal: Delete the test.
  - Size: 0 / 20. Risk: low. Effort: S.
  - Why behavior holds: image-service.test.ts:146-197 interrupts parseImageSse, whose only consumer is the service, through the real deadline, and asserts both the typed timeout and exactly one finalization.
- **T-openai-13 (adjusted): Add a temp-image-dir helper**
  - Where: `tests/image-resources.test.ts:47-50, 82-84, 106-119, 149-152, 191-194, 201-212, 231-234`
  - Proposal: Add only `tempImages`, which returns `{ fs, path, root, directory }`. The verifier judged the proposed `fileWith` File wrapper break-even and advised skipping it.
  - Size: 0 / 9. Risk: none. Effort: S.
  - Why behavior holds: the fault injection is unchanged.
- **T-openai-17: Delete the real-process SVG rejection test**
  - Where: `tests/sharp-process.test.ts:55-62`
  - Proposal: Delete the test.
  - Size: 0 / 9. Risk: low. Effort: S.
  - Why behavior holds: sharp.test.ts:41-61 proves the parent rejects a `{"format":"svg"}` decoder result, so the real-process test cannot tell which layer rejected. Real decoding (25-40) and native-error sanitization (64-72) stay covered.

### Source: auth and compaction boundary (37 src)

- **better-openai-1: Replace five hand-built CodexAuthError constructions with a local factory**
  - Where: `src/auth/codex-auth.ts:74-82, 86-100, 105-120`
  - Proposal: Add `const authError = (operation, message) => new CodexAuthError({ operation, message })`, which makes each site a one-liner. Inline `accessToken: entry.access`.
  - Size: 18 / 0. Risk: none. Effort: S.
  - Why behavior holds: the same tagged errors are built with the same strings, and the getCodexCredentials precedence is untouched. This matches the package's existing `boundaryError`/`compactionError`/`fail` factories.
- **better-openai-5 (adjusted): Simplify the compaction boundary errors and derive the usage type**
  - Where: `src/boundary/openai-compaction.ts:56-70, 79-87, 166-171`; `src/compaction/protocol.ts:10-15`
  - Proposal: Delete `BoundaryErrorArgs`, make `boundaryError` two-argument, and construct the single status-bearing error directly. Type the usage as `NonNullable<OpenAICompactionCheckpoint["usage"]>`.
  - Size: 13 / 0. Risk: none. Effort: S.
  - Why behavior holds: fields and messages are identical, and `status` stays absent elsewhere. The derived type is slightly wider (`cachedInputTokens?: number | undefined` under exactOptionalPropertyTypes), which is harmless because the consumer uses `?? 0`. The combined import wraps to multiple lines.
- **better-openai-11 (adjusted): Shorten findActiveOpenAICompactionCheckpoint**
  - Where: `src/compaction/projection.ts:48-68`
  - Proposal: Rewrite the body as three statements: findLast, a decode ternary, and the provider/api/model match. Keep `entry?.type` in the findLast callback so a malformed host branch is tolerated.
  - Size: 6 / 0. Risk: none. Effort: S.
  - Why behavior holds: selection, decode and the model match are identical.

### Tests: config, usage format and settings (36 test)

- **T-openai-16: Remove the usage-line layout test**
  - Where: `tests/usage-format.test.ts:61-76`
  - Proposal: Delete the test.
  - Size: 0 / 17. Risk: low. Effort: S.
  - Why behavior holds: formatUsageSnapshot only delegates to core's `formatWindowedUsageLine`, which pi-cosmic-core's subscription-format test covers. Percent and reset projection stay covered at 11-29. The deleted assertions pin exact copy and layout, which the testing policy excludes.
- **T-openai-15: Delete config.test's sibling-fallback test**
  - Where: `tests/config.test.ts:55-65`
  - Proposal: Delete the test.
  - Size: 0 / 12. Risk: low. Effort: S.
  - Why behavior holds: domain.test.ts:49-76 covers per-field independent decoding through readConfig/resolveConfig, and real-filesystem I/O stays covered at 21-36.
- **T-openai-18: Share the optimistic-refresh preamble**
  - Where: `tests/settings-controller.test.ts:142-146, 153-168, 185-198`
  - Proposal: Add `beginRefreshWrite`, which returns `{ h, write, closed, component }`, and inline `openUsageSubmenu` into it.
  - Size: 0 / 7. Risk: none. Effort: S.
  - Why behavior holds: both tests still check reconciliation and rollback.

### Source: usage and fast mode (26 src, 3 test)

- **better-openai-14: Remove dead optional parameters and option seams**
  - Where: `src/usage/projection.ts:48-59, 119-128`; `src/usage/controller.ts:51, 76`; `src/image/service.ts:54, 68`; `src/settings/controller.ts:42, 56`; `src/application.ts:348`; `tests/fast-service.test.ts:75`; `tests/image-service.test.ts:61`; `tests/settings-controller.test.ts:101`
  - Proposal: (a) Drop the never-passed `isUsingOAuth` parameters. (b) Drop the test-only `agentDir` options, since tests already provide `AgentDirectory.layer("/agent")`. (c) Import core `hasTerminalUI` in the settings controller and delete its option and stub.
  - Size: 11 / 3. Risk: none. Effort: S.
  - Why behavior holds: production already uses the host OAuth check, the AgentDirectory service and core hasTerminalUI, and the test ctx has `mode: "tui"`.
- **better-openai-12: Return the usage decision in core's shape**
  - Where: `src/usage/projection.ts:64-117`; `src/application.ts:460`
  - Proposal: Rename `clear` to `clearUsage` and reduce synchronizeProjectionContext to `(projection, ctx)`, dropping the always-true `{ clearUsage: true }` bag. Keep the local interface, because it needs a non-optional hiddenStatusText.
  - Size: 8 / 0. Risk: none. Effort: S.
  - Why behavior holds: eligibility, clearing and texts are the same. The single caller always passed `true`.
- **better-openai-13: Stop threading the constant FAST_SERVICE_TIER through the helpers**
  - Where: `src/fast/controller.ts:45-70`; `src/fast/routing.ts:31-45`; `src/boundary/host-provider-routing.ts:8-16`; `src/application.ts:49, 333, 507, 511-517`
  - Proposal: Read FAST_SERVICE_TIER from `./models.ts` inside the four helpers and drop the parameter. Leave `models.ts` unchanged, since it is the public `./fast-models` export that pi-subagents uses.
  - Size: 7 / 0. Risk: none. Effort: S.
  - Why behavior holds: every caller passes the same constant, and no test or other package calls these helpers.

### Structural notes (unverified)

- **Footer binding duplicated with pi-better-xai.** Both packages carry the same usage-visibility query, the installed/active checks, the upsert/remove, the setStatus fallback, the visibility-change refresh and the onHostStateChange watch/stop (`src/application.ts:107-158` vs `pi-better-xai/src/application.ts:51-95`). A shared provider-footer binding in `pi-cosmic-ui/client` would save about 30-35 lines per package (rough 50). This is a cross-package change.
- **Settings-dialog test harness copied almost line for line into pi-better-xai.** The copied parts are TestCustomFactory, the host double, deferred and the open/select/setRefreshInterval helpers (`tests/settings-controller.test.ts:21-134` vs `pi-better-xai/tests/settings-controller.test.ts:19-150`). A `pi-cosmic-ui/testing` settings kit would save about 60 lines per package. testing.md's "second consumer" condition is met. This is a cross-package change.
- **Usage-service options and config decode duplicated with pi-better-xai.** The duplicated parts are the options interface, the tolerant decode of refreshIntervalMs/showOnlyOnSubscriptionModels/showResetTimes and the interval clamp (`src/usage/controller.ts:44-83`, `src/config/store.ts:46-54, 100-106`). Core could export both next to makeUsageSettingDescriptors (rough 30).
- **Image details validated three ways.** They are the register.ts guard, the compact-summary guard (mostly captured by better-openai-6) and a subset schema in presentation.ts. A single `CodexImageDetails` Effect Schema with `Schema.is` guards could back all three (rough 10).
- **latestOwnedCompaction decodes owned details and discards them.** Callers decode again at `src/compaction/context.ts:64-68, 99-100` and in projection. Returning `{ entry, details }` would save a few lines, but it touches five call sites in delicate repair logic (rough 8).
- **compaction-context.test.ts:96-118 builds its own partial ExtensionAPI registration.** It could fold into the extension.test.ts harness with a sessionManager override (rough 10).
- **application.ts is about 527 lines, above the rough split threshold.** Splitting it would not reduce line count (0).
- **The compaction-service anchor matrix runs 4 anchors x 2 mid-conversation modes** (`tests/compaction-service.test.ts:424-523`). Limiting the mode parameter to the `system` anchor would cut runtime, but not lines (0).

### Needs a decision

None. No findings were disputed, and all 8 spot-checks held. The verifiers narrowed five proposals, and the counts above already exclude the rejected parts:

- T-openai-6 no longer shares the preparation fixture, because keepRecentTokens changes the fallback cut.
- T-openai-13 skips `fileWith`, which saves nothing.
- T-openai-19 keeps the conformance status regexes, because the presentation contract requires them.
- better-openai-9 does not use the `? {} :` spread, which trips an oxlint rule.
- better-openai-4 does not let runHostCommand return an Option, which breaks Pi's `Promise<void>` handler type.

The only intentional semantic deltas are all in tests: T-openai-1 stores usage on fallback entries, and T-openai-5 zeroes the assistant usage in two tests. No assertion reads either value.
