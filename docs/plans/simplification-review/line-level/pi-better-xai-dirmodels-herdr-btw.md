## pi-better-xai, pi-directory-models, pi-herdr-btw

This shard covers three packages. By `wc -l` over `src/` and `tests/`, they hold 4,022 source LOC and 5,010 test LOC: pi-better-xai 1,508/1,735, pi-directory-models 497/787 and pi-herdr-btw 2,017/2,488. Verification confirmed 40 findings: 21 in source (herdr-btw-1..13, better-xai-dirmodels-1..8) and 19 in tests (T-small-\*). One finding is disputed (herdr-btw-14) and one was dropped (T-small-17). No two confirmed findings target the same mechanism, so none were merged. Where findings touch neighboring lines, each figure is already net of its neighbors (see the overlap notes), so the removable total is **304 source LOC and 348 test LOC**. By package, source splits as herdr-btw 188, better-xai 110 and directory-models 6. Test LOC splits as better-xai 133 + 2, herdr-btw 114 + 7, directory-models 30, and 62 in two idiom sweeps that span packages. The finders applied every source finding to scratch copies. The xAI and directory-models copies were tsc-clean with 48/48 and 28/28 tests passing. The herdr-btw findings were applied one at a time with tsc, oxlint, effect-tsgo and 102/102 tests after each step. All 14 herdr-btw findings together, including the disputed one, measured -211 source and -11 test, above the conservative 188 + 7 summed here. The largest source items are herdr-btw-1 (a HerdrBtwError factory), better-xai-dirmodels-1 (one synchronous OAuth-eligibility check) and herdr-btw-2 (link-shaped predicates). Most test savings come from table-driving redundant fail-closed cases and from sharing xAI auth fixtures. I spot-checked the 9 largest findings against the code (the eighth place was a three-way tie at 22): T-small-1, T-small-2, better-xai-dirmodels-1, herdr-btw-1, herdr-btw-2, T-small-4, herdr-btw-4, T-small-5 and T-small-6. All of them hold, and none were demoted.

| Category                 | Src LOC | Test LOC | Findings |
| ------------------------ | ------: | -------: | -------: |
| verbose-code             |      96 |       92 |       13 |
| test-redundancy          |       0 |      114 |        6 |
| indirection              |      60 |       14 |        6 |
| test-fixture-duplication |       0 |       73 |        3 |
| duplication              |      59 |        2 |        3 |
| redundant-validation     |      36 |       22 |        4 |
| boilerplate              |      38 |       18 |        3 |
| dead-code                |      15 |        7 |        1 |
| test-policy-violation    |       0 |        6 |        1 |
| **Total**                | **304** |  **348** |   **40** |

T-small findings live entirely in tests, so their `net_loc_removed` is counted as test LOC.

Overlap notes: each figure below is already net of its neighbors, so nothing is subtracted twice.

- **herdr-btw-2, -5 and -6** touch the same `launch` and predicate lines. 2+5 measured -43 together, reported as 27 + 15. herdr-btw-6's 15 is its standalone figure; after herdr-btw-2 it measured -19.
- **herdr-btw-1 and herdr-btw-8** share the `freshChildSessionId` block. The 12 for herdr-btw-8 is its figure after herdr-btw-1.
- **better-xai-dirmodels-3 and -4** measured together: auth.ts went from 315 to 289 lines and request.ts lost 2, which matches 14 + 14.
- **T-small-9 and T-small-15** are counted on top of T-small-2. **T-small-13** leaves out the sites that T-small-3 and T-small-12 rewrite. **T-small-1** leaves out the sites that T-small-5, T-small-7 and T-small-16 remove.

### pi-herdr-btw source: btw/service.ts and btw/validation.ts (122 src, 7 test)

- **herdr-btw-1: Add a `confirmedFailure(operation, code, message)` helper for the 19 hand-built confirmed `HerdrBtwError` literals**
  - Where: `pi-herdr-btw/src/btw/errors.ts:1-12`; `src/btw/service.ts:68-91,120-165,206-211,251-257,295-301`; `src/btw/validation.ts:48-136,158-186`
  - Proposal: Export `confirmedFailure` from btw/errors.ts and use `return yield* confirmedFailure(op, code, msg)` at every confirmed site. Build `failClosedLink` on it. Define one `parentUnavailable` thunk for the `parent_session_unavailable` error, which validateBtwInput currently writes out twice, without reordering the checks. The uncertain literals stay hand-built.
  - Size: 32 src / 0 test (measured -33). Risk: none. Effort: S.
  - Why behavior holds: every operation, code, message and outcome string is carried over verbatim, the check order is unchanged, and the thunk keeps construction lazy.
  - Spot-check: confirmed. There are 19 `outcome: "confirmed"` literals (10 in validation.ts, 9 in service.ts including failClosedLink), each 6-7 lines, and `parent_session_unavailable` is duplicated at validation.ts:91-98 and 107-115.
- **herdr-btw-2: Pass the recorded `HerdrBtwLink` to the linked-agent predicates instead of 4-5 positional fields**
  - Where: `src/btw/validation.ts:246-299`; `src/btw/service.ts:259-267,343-355,398-406`
  - Proposal: Change the signatures of `linkedAgentSessionIdentity`, `isLinkedAgentConflictCandidate` and `isExactLinkedAgent` to `(agent, link, compareSessionFileIdentity)` and read `link.*` inside. Each call site shrinks from 7-9 lines to 1-3.
  - Size: 27 src / 0 test (measured -30 standalone). Risk: none. Effort: S.
  - Why behavior holds: this only reshapes parameters. The same fields are read in the same order, and the only callers are three sites in service.ts.
  - Spot-check: confirmed. All three call sites pass fields of a single link (`preparedTarget.link` or `link`).
- **herdr-btw-5: Share one Pi agent-session guard between `validateStartedAgent` and `linkedAgentSessionIdentity`**
  - Where: `src/btw/validation.ts:200-244,246-262`
  - Proposal: Add `piAgentSession(agent)`, which returns the session when `source === "herdr:pi" && agent === "pi"`. Fold `hasPathEvidence`, `childMatchesLaunch` and `childDiffersFromParent` into the existing `||` chain. `!hasPathEvidence` is redundant because `childMatchesLaunch` implies it.
  - Size: 15 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: the booleans are identical. The comparator and distinctness probes now run only after the field checks pass, so failure paths make fewer read-only stat calls. Error code, message and the `uncertain` outcome are unchanged.
- **herdr-btw-6: Remove `PreparedCreateTarget` and the repeated create/resume ternaries in `launch`**
  - Where: `src/btw/service.ts:93-101,132-165,235-247,258-266,282-283,315`
  - Proposal: Have `prepareFreshLaunchTarget` return `Pick<HerdrBtwLink, "childSessionId" | "childSessionPath">`. Destructure `{ childSessionId, childSessionPath }` from it or from `target.link`, and branch on `target.mode` directly.
  - Size: 15 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: the same values reach the same calls in the same order. The child file is still created only after `waitForAvailableShell`, as ARCHITECTURE.md requires.
- **herdr-btw-4: Remove the unused `HerdrBtwResult` fields `prompted` and `direction`**
  - Where: `src/btw/service.ts:49-57,315-322,362-368`; `tests/open-pane-btw.test.ts:54-59,106-108`; `tests/btw-reuse.test.ts:118-124,143-144,263`; `tests/controller.test.ts:14-20`
  - Proposal: Reduce the result to `{ agentName, paneId, mode }` and drop the `HerdrBtwResultMode` alias. Keep one `const mode: HerdrBtwResult["mode"]` local in `launch`, because a bare literal widens inside Effect.gen. Tests assert the down split through `operationInputs(test.calls, "split BTW pane")[0]`.
  - Size: 15 src / 7 test. Risk: none. Effort: S.
  - Why behavior holds: the only production reader is `controller.successMessage`, which reads mode, agentName and paneId. The package exports only the extension default, and direction and prompt remain covered through operation inputs.
  - Spot-check: confirmed. grep finds `prompted` and `direction` read only in tests.
- **herdr-btw-8: Stop re-validating the `crypto.randomUUID` child ID in the service** (verifier-adjusted)
  - Where: `src/btw/service.ts:19,120-130,332`; `tests/btw-reuse.test.ts:359-369`
  - Proposal: Delete `freshChildSessionId` and the `parseHerdrBtwSessionId` import, and call `createChildSessionId()` directly. Reduce the "rejects malformed parent and child IDs" test to its parent half. Per the adjustment, add about 4-5 lines to session-file.test.ts asserting that `createBlankChildSessionFile` returns `invalid` for `../escape` and for an ID over 128 characters. That test guards path traversal and argv markers, and it would otherwise lose its only coverage.
  - Size: 12 src / 0 test (net test change about 0). Risk: low. Effort: S.
  - Why behavior holds: `randomUUID` output always matches the grammar, and the boundary still checks it before any file or argv use. Only an ID injected through the test seam behaves differently: it now fails as `herdr_btw_child_create_failed`, after the pane split.
- **herdr-btw-13: Derive the service's test-seam options from the session-file boundary defaults**
  - Where: `src/btw/service.ts:7-16,59-66,113-118`
  - Proposal: Declare `const sessionFileBoundary = { probeSessionHeader, compareSessionFileIdentity, createChildSessionId, createBlankChildSessionFile }`. Type options as `Partial<typeof sessionFileBoundary>` and destructure from `{ ...sessionFileBoundary, ...options }`. This drops the `*AtBoundary` aliases and the restated signatures.
  - Size: 6 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: defaults and overrides are the same. Under exactOptionalPropertyTypes, Partial rules out an explicit-undefined override, the one case where `??` and the spread differ. There is a minor readability cost: the destructured locals shadow the imports.

### pi-herdr-btw source: boundary/ and application.ts (66 src)

- **herdr-btw-3: Inline the three single-use owner helpers into `revalidateOwner`**
  - Where: `src/boundary/host-link-store.ts:31-51,66-75`
  - Proposal: In one try/catch, compare the live `getSessionId()` and `getSessionFile()` with the captured owner, then require `probe(path)` to be valid with a matching header ID. Delete `readOwner`, `isSameOwner` and `hasOwnerHeader`.
  - Size: 16 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: an empty captured owner still fails closed, because `probe("")` is invalid and the header schema requires an ID of at least 1 character. The only change is that `getSessionFile` is skipped once the ID already mismatches.
- **herdr-btw-7: Compute the uncertain flag once in the Herdr exit and transport failure builders, and drop `HerdrBtwErrorOutcome`**
  - Where: `src/boundary/herdr-client.ts:12,146-181,209-228`; `src/btw/errors.ts:3`
  - Proposal: In the transport builder, use `const uncertain = request.mutation && failure?.operation !== "spawn"`. In the exit builder, precompute `detail` with its leading space, inline the single-use `parseHerdrCliError` as `Option.getOrUndefined(...)?.error.code`, and derive `rejected` and `uncertain` once. Delete the duplicate outcome type.
  - Size: 12 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: suffix, message, outcome and herdrCode are identical for every combination of mutation, rejection code and detail. The spawn-only confirmed rule is kept.
- **herdr-btw-9: Drop redundant guards in the identity comparator, candidate policy, prompt hook and notifier**
  - Where: `src/boundary/session-file.ts:91-96`; `src/parent-link/policy.ts:36-39`; `src/boundary/host-parent-reference.ts:102`; `src/boundary/host-notifier.ts:9-13`
  - Proposal: (a) Drop the second `isBoundedSessionPath` check after `normalize`. (b) Use `!input.sessionFile`. (c) Delete `activeReference = current`. (d) Use `if (invokeHostCallback(() => ctx.hasUI, false)) notifyAtHostBoundary(...)`.
  - Size: 11 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: (a) `withRegularSessionDescriptor` re-checks the bounds anyway. (b) is exact. (c) only `id` and `path` are read, and they were just proven equal. (d) keeps fail-closed behavior on a throwing `hasUI` getter. After (a), the comparator's doc comment is slightly stale.
- **herdr-btw-10: Inline the single-use `makeHerdrCommandRunner` into `makeHerdrClient` and delete the dead `HerdrPaneLayout` export**
  - Where: `src/boundary/herdr-client.ts:94,131,230-263,297-301`
  - Proposal: Compute `environment` and `processRunner` inside `makeHerdrClient` and define `run` locally. Delete `makeHerdrCommandRunner`, `HerdrCommandRunner` and `HerdrPaneLayout`, which has no importers.
  - Size: 10 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: the environment is still selected once per client, and the `processRunner` test seam and the request mapping are unchanged.
- **herdr-btw-11: Remove the `runCommand` wrapper in application.ts**
  - Where: `src/application.ts:12-18,45-52`
  - Proposal: Use `open: (prompt) => slot.run(HerdrBtwService.use((s) => s.open(prompt)))`, and the same for `openNew`. Drop the wrapper and three type-only imports.
  - Size: 9 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: `slot.run` is generic and infers `Promise<HerdrBtwResult>`, and it is the same call.
- **herdr-btw-12: Fold `captureParentReference` into the registration closure**
  - Where: `src/boundary/host-parent-reference.ts:32-58,88-89`
  - Proposal: Move the try/catch body into the `capture` closure, which already has `pi`, `probe` and `compareIdentity` in scope, and delete the four-parameter helper.
  - Size: 8 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: the logic and the fail-closed catch are identical. This composes cleanly with herdr-btw-9(c) in the same file.

### pi-better-xai source (110 src, 2 test)

- **better-xai-dirmodels-1: Replace the Effect-wrapped `ModelRegistryAuth.isUsingOAuth` eligibility path with the synchronous check that projection.ts already uses**
  - Where: `pi-better-xai/src/usage/controller.ts:51-64,90`; `src/usage/projection.ts:37-64`; `src/boundary/model-registry-auth.ts:10-16,32-40`; `src/application.ts:193`; `tests/support/fixtures.ts:14`
  - Proposal: Make `isXaiSubscriptionModel(ctx, cfg)` self-contained: check the provider, then `!showOnly || invokeHostCallback(() => ctx.modelRegistry.isUsingOAuth(model), false)`. Wire it as `eligibility: (ctx, cfg) => Effect.sync(...)`, the better-openai pattern, and delete `subscriptionEligibility`. Reduce `synchronizeProjectionContext` to an arrow that returns `clearUsage: true`, since its only caller passes true. Remove `isUsingOAuth`, the `Model` alias, the `oauth-status` literal and the test stub.
  - Size: 33 src / 1 test (measured -34/-1). Risk: low. Effort: S.
  - Why behavior holds: `eligible` is identical in every branch, including a throwing registry, which gives false. The only loss is the `oauth_status_unavailable` host-log warning, which nothing references. Guarding the `ctx.modelRegistry` getter also makes the model_select path fail closed where it used to throw.
  - Spot-check: confirmed. `isUsingOAuth` and `oauth-status` are used only on this path, application.ts:193 is the sole caller and passes `{ clearUsage: true }`, and projection.ts already calls `isUsingOAuthAtHostBoundary` synchronously.
- **better-xai-dirmodels-2: Stop layer.ts from re-declaring and re-mapping `XaiUsageService` options field by field** (verifier-adjusted)
  - Where: `src/layer.ts:1-39`; `src/usage/controller.ts:32`
  - Proposal: Export `XaiUsageServiceOptions` and type the parameter as `Required<Pick<XaiUsageServiceOptions, "projection" | "onChange" | "isUsageVisible">>`. `Required` keeps `isUsageVisible` mandatory, as it was. The body becomes `XaiUsageService.layer({ ...options, cwd, context, projectTrusted }).pipe(Layer.provide(Layer.merge(nodePlatformLayer, AgentDirectory.layerFromHost(getAgentDir))))`. Delete `XaiApplicationLayerOptions` and the `XaiProjection` import.
  - Size: 17 src / 0 test (layer.ts goes from 43 to 26 lines). Risk: none. Effort: S.
  - Why behavior holds: the service receives the same option values and the same Layer graph. `getAgentDir` takes no arguments, so passing it directly is equivalent.
- **better-xai-dirmodels-3: Remove the conditional-spread credential construction and the `withTeamId` helper**
  - Where: `src/auth/auth.ts:66-67,82-90,162,171,194-207,218-224`; `src/usage/request.ts:43-46,104-107`
  - Proposal: Build each `XaiCredentials` as one annotated literal with `?? undefined` fields. Destructure `response.body` in `refreshXaiToken` and pass one literal to `commitXaiRefresh`. Delete `withTeamId`. In request.ts, widen `teamId?: string | undefined` and use `{ snapshot, teamId: credentials.teamId }`.
  - Size: 14 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: keys that are present but undefined behave like absent keys for every consumer, which all use `=== undefined` or truthiness. `JSON.stringify` drops them, so leak checks are unaffected. The persisted auth entry is still built from explicit fields, and this satisfies the anti-slop no-conditional-empty-object-spread rule.
- **better-xai-dirmodels-4: Use Redacted's built-in `Equal` and one usable-replacement check in rejected-token recovery**
  - Where: `src/auth/auth.ts:106-117,228-231,244,250-276`
  - Proposal: Replace `equalRedactedTokens` and `hasDifferentAccessToken` with `Equal.equals`. In `recoverRejectedXaiCredentials`, add a local `usable(c)` and use `Result.getOrUndefined(refreshAttempt)`, `Effect.orElseSucceed(() => undefined)` for the registry, and `if (Result.isFailure(refreshAttempt)) return yield* refreshAttempt.failure`.
  - Size: 14 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: in the pinned effect@4.0.0-rc.112, Redacted implements Equal over its value and handles undefined the same way. Recovery order is unchanged (refreshed token, then registry token, then re-raise). Registry failures are still ignored, and defects still propagate.
- **better-xai-dirmodels-5: Collapse the duplicate xAI config type declarations onto core types and the decoder's inferred type**
  - Where: `src/config/schema.ts:7-18`; `src/config/store.ts:8,27-31,59-63`
  - Proposal: Declare `interface ResolvedConfig extends ScopedConfigMetadata { usage: UsageControllerConfigFields & { showResetTimes: boolean } }`. Delete `DecodedConfig` and the return annotation, and type project and global as `ReturnType<typeof decodeConfig> | undefined`, as better-openai does.
  - Size: 13 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: the change is type-only. Decode, defaults and the 5-second clamp are untouched.
- **better-xai-dirmodels-6: De-duplicate the application.ts footer/resync wiring and drop the pass-through `run` and `captureSignal` seams**
  - Where: `src/application.ts:54-66,75-82,129-153,191-202`; `src/settings/controller.ts:12-13,31-35,92,196`; `tests/settings-controller.test.ts:116`
  - Proposal: Hoist `const resynchronizeUsage = XaiUsageService.use(...)` and fork it from both sites. `updateFooter` uses `config()` and `isUsageVisible()`. Use `const { run } = slot`. The settings controller calls `captureHostSignal` directly, which removes the option and the test stub.
  - Size: 11 src / 1 test. Risk: none. Effort: S.
  - Why behavior holds: an Effect is a reusable description, `slot.run` does not depend on `this`, and the real `captureHostSignal` returns the stub's value for the test ctx.
- **better-xai-dirmodels-7: Replace the Created/Failed tagged union in the guarded settings-surface factory with an undefined fallback**
  - Where: `src/boundary/host-ui.ts:38-52`
  - Proposal: Write `guardedDone` as a one-line arrow. Use `invokeHostCallback<Component | undefined>(() => factory(...), undefined)` and `if (component) return component;`, then keep the existing failure tail.
  - Size: 8 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: the factory type returns a Component, and its only producer returns `createSettingsListSurface(...).surface`, so undefined means the factory threw.

### pi-directory-models source (6 src)

- **better-xai-dirmodels-8: Stop `applyHostPreference` from rebuilding the preference field by field to replace `thinkingLevel`**
  - Where: `pi-directory-models/src/boundary/host-model.ts:97-103`
  - Proposal: Use `return { ...preference, thinkingLevel: yield* readThinkingLevel(pi) };`.
  - Size: 6 src / 0 test. Risk: none. Effort: S.
  - Why behavior holds: `preference` is Struct-decoded, which drops excess keys, so the spread yields the same five keys with `version: 1`. `makeDirectoryModelPreference` is still used at line 59.

### pi-better-xai tests (133 test)

- **T-small-2: Share the xAI auth-document fixture and credential assertion helpers** (verifier-adjusted)
  - Where: `pi-better-xai/tests/support/fixtures.ts:1-18`; `tests/auth.test.ts:28-53,55-56,72-121,123-137,170-210,212-274,276-286,301-315`; `tests/usage-request.test.ts:17,27-37,83-91,131-138,176-184`
  - Proposal: Add `AUTH_PATH`, `xaiAuthDocuments(entry, root)` and `revealed(value?)` to fixtures.ts. `xaiAuthDocuments` fills in `type: "oauth"` and omits absent fields, because the in-memory store rejects undefined. Add `refreshWhile(update, extraLayers?)` to `pausedRefresh`. It must merge the caller's logger and tracer layers into `h.layer`, or the keep-new-login leak check becomes vacuous. Delete the duplicated comment.
  - Size: 0 src / 40 test. Risk: none. Effort: M.
  - Why behavior holds: every scenario keeps its inputs, assertions and leak checks, and `revealed(undefined)` still fails on a missing credential.
  - Spot-check: confirmed. In auth.test.ts, `authPath` is redeclared in 4 tests and in the `pausedRefresh` helper, inline `{ xai: { type: "oauth", ... } }` document builders repeat across both files, and the `toBeDefined`/`if`/`Redacted.value` triple appears at 6 sites (auth.test.ts:113, 158, 194, 246, 295, 328).
- **T-small-9: Table-drive the three xAI credential-source selection tests**
  - Where: `tests/auth.test.ts:123-168,276-299,301-332`
  - Proposal: Use one `it.effect.each` over `{ refresh?, expires, now, refreshes, expected }` with a counting 503 refresh handler, and run the leak check on every row.
  - Size: 0 src / 20 test (on top of T-small-2). Risk: low. Effort: S.
  - Why behavior holds: all three selection rules become rows. The leak check now covers every row, and "no refresh" is asserted as a count of 0.
- **T-small-10: Extract the hostile-getter and Cosmic UI protocol helpers in extension.test.ts**
  - Where: `tests/extension.test.ts:113-126,159-190,199-204,253-258,277-282,309-314`
  - Proposal: Add `throwOnRead(target, ...keys)`, a harness option `cosmicUi?: { active, hidden? }` that installs the host-query responder, and a local `publish(active)` closure. The counting getters at 223-240 stay hand-written.
  - Size: 0 src / 18 test. Risk: none. Effort: S.
  - Why behavior holds: the same hostile getters and protocol messages reach the extension, and no test asserts the thrown messages.
- **T-small-11: Share one `UsageSnapshot` builder across the xAI tests**
  - Where: `tests/usage-service.test.ts:45-56`; `tests/usage-format.test.ts:60-71`; `tests/extension.test.ts:142-157`; `tests/support/fixtures.ts:1-18`
  - Proposal: Move `usageSnapshot(monthlyUsed, weeklyUsedPercent)` to fixtures.ts. The format tests spread it and override `onDemandUsed` with null or 0.
  - Size: 0 src / 18 test. Risk: none. Effort: S.
  - Why behavior holds: the On-demand line depends only on `onDemandCap` (500) and `onDemandUsed`, and the extension test needs only a non-empty status line.
- **T-small-15: Share one rejected-usage HTTP and registry fixture in usage-request.test.ts**
  - Where: `tests/usage-request.test.ts:77-127,129-169,171-235`
  - Proposal: Add `rejectedUsage({ registryTokens, refreshStatus?, monthly? })`, which returns counts and `layer(documents)`. `monthly` can be overridden for the Bearer-200 case and the Deferred-gated case.
  - Size: 0 src / 15 test (on top of T-small-2). Risk: none. Effort: S.
  - Why behavior holds: the provider responses, refresh, registry and monthly counts, and leak checks are unchanged. Deferreds are created before the helper is called.
- **T-small-14: Inline the single-consumer tests/support/host.ts casts**
  - Where: `tests/support/host.ts:1-21`; `tests/extension.test.ts:23,66-86`
  - Proposal: Cast inline in extension.test.ts with SAFETY comments, as pi-directory-models does, and delete host.ts.
  - Size: 0 src / 14 test. Risk: none. Effort: S.
  - Why behavior holds: the change is type-only. The same helper exists in pi-code-mode, pi-cosmic-ui and pi-subagents, so inlining it here breaks that convention. The structural note below proposes moving it to pi-cosmic-core/testing instead, which would replace this finding.
- **T-small-20: Add an `eventually` (waitFor) helper in the xAI settings-controller test**
  - Where: `tests/settings-controller.test.ts:124-132,184-188,203-211,234-242`
  - Proposal: `const eventually = (assertion) => Effect.promise(() => vi.waitFor(assertion));`.
  - Size: 0 src / 8 test. Risk: none. Effort: S.
  - Why behavior holds: the polling semantics and assertions are unchanged.

### pi-herdr-btw tests (114 test)

- **T-small-4: Merge the four link-store fail-closed revalidation tests into one table**
  - Where: `pi-herdr-btw/tests/link-store.test.ts:43-47,57-58,125-144,159-174,176-185,187-199`
  - Proposal: Use one `it.each` over change callbacks: owner id or path changed or undefined, probe invalid or replaced, and throwing sessionId, sessionFile or probe. Each case records and restores successfully, clears the mocks, applies the change, then asserts malformed, getEntries not called, refused, no append and entries unchanged. Drop `initialProbe`.
  - Size: 0 src / 25 test. Risk: low. Effort: S.
  - Why behavior holds: all nine inputs go through the same `revalidateOwner()` branch, and running them after a successful record still proves there is no caching. The only lost case is failing closed on a store's first call, which matters only for a contrived regression.
  - Spot-check: confirmed. The four tests at 125-144 and 159-199 loop over the same kinds of mutation with the same assertions (about 62 lines). herdr-btw-3 rewrites the code under test.
- **T-small-5: Fold duplicate linked-child validation tests into one fail-closed table**
  - Where: `tests/btw-reuse.test.ts:174-187,320-333,335-357`
  - Proposal: Loop over fixture options: invalid, different-id and reparented probes, plus `compareSessionFileIdentity: aliasIdentity([CHILD_FILE, SESSION_FILE])`. Assert `test.calls` is `[]`, and delete the tests at 174-187 and 320-333.
  - Size: 0 src / 22 test. Risk: low. Effort: S.
  - Why behavior holds: every input fails at openInner's pre-Herdr check with `herdr_btw_link_child_invalid` and outcome confirmed. The empty-calls assertion is stricter than today's check.
  - Spot-check: confirmed. All three tests assert the same code, and two already assert that `calls` is `[]`.
- **T-small-8: Collapse the inactive-marker and rejected-evidence parent-reference tests into tables**
  - Where: `tests/parent-reference.test.ts:188-201,245-277`
  - Proposal: Add `undefined` to the flag list with `probe` not called, and delete 188-193. Add the invalid and mismatched-header probe rows to the hostile loop at 265, and delete 245-263.
  - Size: 0 src / 20 test. Risk: none. Effort: S.
  - Why behavior holds: every input still yields an undefined section. The not-probed check now also covers malformed markers, and per-run revalidation stays covered at 166-186.
- **T-small-7: Delete the handoff-failure test duplicated across the open and openNew paths** (verifier-adjusted)
  - Where: `tests/open-pane-btw.test.ts:324-337`; `tests/btw-reuse.test.ts:431-446`
  - Proposal: Delete open-pane 324-337 and add `expect(error).toMatchObject({ outcome: "uncertain", paneId: "w1:p2" })` to the btw-reuse 431-446 loop. Keep btw-reuse 448-462, which is the only test of the reuse (focusLiveAgent) path when prompt delivery fails.
  - Size: 0 src / 13 test. Risk: low. Effort: S.
  - Why behavior holds: `open()` without a link and `openNew()` share openFreshCreate, launch and deliverAndFocus, and the retained-link and error-shape coverage moves into the loop.
- **T-small-16: Stop the open-pane tests from hand-building the service, and trim the harness surface**
  - Where: `tests/open-pane-btw.test.ts:4-6,207-250`; `tests/fixtures/herdr-btw-harness.ts:53-74,101-102,118-142,237-248,299-311`
  - Proposal: Use `fixture({ probes: { [SESSION_FILE]: parentProbe } })` and a new `environment?` option. Drop `client`, `input` and `serviceOptions` from the harness return, inline `makeHerdrBtwCallRecorder`, and import `HerdrPane` instead of its alias.
  - Size: 0 src / 12 test. Risk: none. Effort: S.
  - Why behavior holds: the harness already consults `options.probes` first, and the same environment and probe reach the service.
- **T-small-18: Add a session-header writer helper to session-file tests**
  - Where: `tests/session-file.test.ts:63-72,78-81,119-122,132-139,145-148`
  - Proposal: `const writeHeader = (name, id) => writeSession(name, JSON.stringify({ type: "session", id, timestamp: "t", cwd: "/project" }));`.
  - Size: 0 src / 12 test. Risk: none. Effort: S.
  - Why behavior holds: the files written are byte-identical.
- **T-small-19: Add an `operationCount` helper to the Herdr BTW harness**
  - Where: `tests/fixtures/herdr-btw-harness.ts:76-85`; `tests/btw-reuse.test.ts:312-314,425-427,486-488,511-516`; `tests/open-pane-btw.test.ts:118-119,144-146,170-172`
  - Proposal: Replace `expect(operationNames(calls).filter(...)).toHaveLength(n)` with `expect(operationCount(calls, op)).toBe(n)`.
  - Size: 0 src / 10 test. Risk: none. Effort: S.
  - Why behavior holds: the assertions are equivalent.

### Cross-package test idioms (62 test)

- **T-small-1: Replace `Effect.result` + `_tag` check + `if` narrowing with `Effect.flip`**
  - Where: `pi-herdr-btw/tests/btw-reuse.test.ts:181-184,246-252,303-311,326-330,347-353,374-380,421-422,436-438,455-456,476-481`; `pi-herdr-btw/tests/open-pane-btw.test.ts:137-140,179-186,194-201,214-217,237-246,255-257,265-271,279-284,292-299,307-316,327-334,345-353`; `pi-herdr-btw/tests/herdr-client.test.ts:229-241,252-268,282-299,314-329,350-356`; `pi-better-xai/tests/auth.test.ts:101-107`; `pi-better-xai/tests/usage-request.test.ts:161-163,227-228`
  - Proposal: Use `const error = yield* Effect.flip(x); expect(error).toMatchObject({...})`, or a bare `yield* Effect.flip(x)` where only failure matters. pi-ask-user and pi-directory-models tests already use this.
  - Size: 0 src / 40 test (the verifier recounted 60-70; 40 is kept as conservative and leaves out sites that T-small-5, T-small-7 and T-small-16 remove). Risk: none. Effort: M.
  - Why behavior holds: an unexpected success still fails, because flip turns it into a failure. The typed-error assertions and leak checks still run, now on the error value.
  - Spot-check: confirmed. grep finds 34 `Effect.result` uses across these files, most followed by the `_tag`/`if` narrowing pair.
- **T-small-6: Remove the redundant `.not.toThrow()` wrappers around handler calls**
  - Where: `pi-better-xai/tests/extension.test.ts:260-264,285-289,293-297,317-321,353-357`; `pi-herdr-btw/tests/application.test.ts:118-122`; `pi-directory-models/tests/host-model.test.ts:24`
  - Proposal: Call the handler directly inside `invoke(...)` or `Effect.promise(() => h.start())`, and delete host-model.test.ts:24.
  - Size: 0 src / 22 test. Risk: none. Effort: S.
  - Why behavior holds: a synchronous throw inside Effect.gen or the Effect.promise thunk still fails the test. The xAI lines 300-301 stay, because they are not wrapped around `invoke`.
  - Spot-check: confirmed. All 7 wrapper sites exist as cited.

### pi-directory-models tests (30 test)

- **T-small-12: Merge the three restore-suppression tests into one `it.effect.each`**
  - Where: `pi-directory-models/tests/application.test.ts:503-515,517-529,630-640`
  - Proposal: Use rows for setModel denied, model getter failure and explicit CLI preference, with warning counts 1, 1 and 0. Assert the initial model, low thinking, setThinkingLevel not called and the preference intact.
  - Size: 0 src / 14 test. Risk: low. Effort: S.
  - Why behavior holds: each path still proves that session and preference stay intact. The explicit-preference row gains a no-warning check, and "setModel not called" becomes its observable effect: the model is unchanged.
- **T-small-13: Add preference read/exists helpers to the harness and trim redundant assertions** (verifier-adjusted)
  - Where: `tests/application.test.ts:229-265,339-349,366,384-386,394-400,412-413,429-430,546-547,553-559`
  - Proposal: Return `readPreference()` and `preferenceExists()` from the harness, and collapse each warning pair to `expect(h.notify.mock.calls).toEqual([[expect.any(String), "warning"]])`. The getEntries and getLeafId not-called lines are deleted in the counted proposal. The verifier suggests keeping them (4 lines) to state the hostile-manager guarantee directly.
  - Size: 0 src / 10 test (sites also touched by T-small-3 and T-small-12 are excluded). Risk: low. Effort: S.
  - Why behavior holds: persistence, restore and warning assertions are the same. "Not read" now rests on the warn-on-throw path.
- **T-small-3: Merge the resumed-session loop into the freshness table** (verifier-adjusted; the original proposal to delete rows was rejected)
  - Where: `tests/application.test.ts:50-71,337-362`
  - Proposal: Keep every entry builder and freshness row. Move only the resumed-session loop (352-360) into the table as `initializes: false` rows, add `expect(h.setModel).not.toHaveBeenCalled()` to the table loop, and shrink test 337 to its explicit-CLI half.
  - Size: 0 src / 6 test. Risk: low. Effort: S.
  - Why behavior holds: the compaction, branch_summary and custom_message rows guard against regressing to a naive `type === "message"` walk (commit ab656ef), so they stay. No preference is seeded, so the setModel assertion holds on every row.

### Structural notes (unverified)

- Herdr transport duplication: pi-herdr-btw `herdr-client.ts:140-295` re-implements the Herdr env allowlist, operationCode, mutation-outcome classification with confirmed rejection codes, integration-status parsing and the pane schemas from pi-subagents `herdr-cli.ts` and `herdr-environment.ts`. A shared bounded transport needs an ownership decision, and the policies differ (`dispatched` vs the spawn-only rule). About 130 LOC (100-150).
- The settings-controller test harness (testDouble, deferred, custom-factory capture fake) is cloned between pi-better-xai and pi-better-openai, with a third testDouble in pi-herdr-btw `controller.test.ts`. A shared custom-surface test double without Vitest, for example as a pi-cosmic-ui testing subpath, would help. About 100 LOC.
- The `extensionApiFixture`/`extensionContextFixture` identity casts are copied in pi-better-xai, pi-code-mode, pi-cosmic-ui and pi-subagents. A type-only helper in pi-cosmic-core/testing would replace T-small-14's local inline, provided the testing-surface rule on multiple proven consumers is met. About 60 LOC.
- Footer publishing wiring is duplicated in the better-xai and better-openai application.ts files: the visibility query, upsert/remove with setStatus fallback, visibility-edge resync, and an idempotent host-state watcher, which pi-cosmic-ui `host-status.ts:72-83` repeats too. A pi-cosmic-ui `makeUsageFooterPublisher` or an idempotent `client.watch()` would help. About 40 LOC.
- The "materializes cwd and signal once" reread-getter tests are near-identical in pi-better-xai, pi-herdr-btw and pi-cosmic-ui, and all three go through core's `captureSessionHost`. A shared hostile-getter builder, or one core-level test plus minimal wiring checks, would help. About 30 LOC.
- Host-guarded settings surfaces are hand-rolled: better-xai `host-ui.ts` and code-mode `host-ui.ts` share the guarded factory/done/neutral logic, and four settings controllers rewrite the `createSettingsListSurface` guard options. A pi-cosmic-ui helper would save 6-8 lines per caller. About 25 LOC.
- The Herdr shell-readiness predicate (15-name shell set, single foreground process) is copied between pi-herdr-btw `validation.ts:21-37,138-156` and pi-subagents `herdr-shell-readiness.ts`. Core has no Herdr module to hold it. About 25 LOC.
- The usage-config wire decode, `DEFAULT_USAGE_CONFIG` and `FiniteNumberSchema` are identical in better-xai and better-openai apart from the clamps. Core `UsageConfigFieldSchemas` plus defaults could live next to `makeUsageSettingDescriptors`. About 15 LOC.
- `JsonDocumentStoreContract.modifyObject` is optional even though both layers implement it. Making it required removes guards in better-xai `auth.ts`, pi-code-previews, pi-subagents, pi-mcp and core's scoped-config-store, but the hand-built test doubles would need updating. This is a core-level change. About 12 LOC.
- pi-herdr-btw `session-file.ts:9-19` has its own `process.getBuiltinModule` guard block, parallel to core's non-exported `node-builtins.ts`, which lacks readSync and statSync. About 8 LOC.
- Verification method (finders): better-xai findings 1-7 and directory-models finding 8 were applied to scratch copies. tsc was clean, oxfmt ran before counting, and 48/48 and 28/28 tests passed. The finder could not run effect-tsgo on the xAI copy, but a verifier later reported its diagnostics unchanged. The herdr-btw findings were applied stepwise with tsc, oxlint, effect-tsgo and 102/102 tests. All 14 together gave -211 src (about 10% of the unit) and -11 test.

### Needs a decision

- **herdr-btw-14: Remove duplicated schema, regex and input-type declarations** (4 src as proposed; the verifiers split rejected/adjusted)
  - Where: `pi-herdr-btw/src/boundary/session-file.ts:151-154`; `src/btw/marker.ts:17-21`; `src/layer.ts:2-12`; `src/btw/service.ts:103-104`; `src/btw/link.ts:8-9`; `src/boundary/herdr-client.ts:21-22`
  - The proposal has three parts. (i) Reuse `parseHerdrBtwSessionId` in `createBlankChildSessionFileAt`. (ii) Share one service-input type in layer.ts. (iii) Import `BoundedId` and `BoundedPath` from btw/link.ts into herdr-client.ts.
  - Against: the saving is at the threshold, about 4 lines without (iii). Part (iii) couples the Herdr wire-protocol bounds to the persisted-link bounds, which match only by coincidence.
  - For, adjusted: keep (i), which makes session-file.ts use the single session-ID grammar at about 0 LOC; pair it with the boundary test from herdr-btw-8. Keep (ii) as `Parameters<typeof makeHerdrBtwService>[0]`, for about -4 to -5. Drop (iii), because ARCHITECTURE.md says herdr-client.ts alone owns Herdr decoding.
  - Decision needed: whether a single source of truth for the session-ID grammar is worth doing below the LOC bar.
