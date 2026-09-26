## pi-subagents: test suite (shard pi-subagents-tests)

Five review units (T-sub-run, T-sub-profiles-config, T-sub-tools-ui-ws, T-sub-herdr-supervisor, T-sub-rest) produced 110 confirmed findings, 0 disputed and 1 dropped. After deduplication there are **103 entries removing about 4,041 LOC, all of it in `packages/pi-subagents/tests/**`**. Every cited location is a test or test-fixture file. The input's `net_loc_removed`therefore counts test-file lines, and its`test_loc_removed` is 0 throughout. Below those lines appear as **Test LOC**, and Src LOC is 0. The raw sum was 4,285. Six merged entries (absorbing seven findings) and 13 overlap deductions removed 244 lines of double counting (see Dedup notes). The savings come from four patterns. First, the run-service harness (`tests/run/fixtures/service-harness.ts`, 795 lines) lacks a few helpers: `withService`, `settle`/`completeLocalRun`, always-on notification capture, and a retained `report()`. Second, fixtures are copied between files: plain Theme, ProfileCandidate, temp directories, process liveness, promise gates, and the Herdr host Layer. Third, near-identical scenarios can become tables. Fourth, some tests repeat stronger neighbors or assert copy that the testing policy excludes. By LOC, 65 entries (2,232) carry no behavior risk and 38 (1,809) carry low risk. 86 entries are effort S. I spot-checked the 9 largest entries against HEAD `1a866fa`: run-3, ws-1, run-2+run-5, herdr-supervisor-2, run-4, profiles-config-2, run-1, profiles-config-4 and ws-3 (two tied at 80). Every count and claim held, and none were demoted. The one dropped finding, herdr-supervisor-19, would have deleted the installed-Pi RPC input-hook test. That test is the only real-Pi guard for U+2028/U+2029 steer payloads.

| Category                 | Entries | Src LOC |  Test LOC |
| ------------------------ | ------: | ------: | --------: |
| test-fixture-duplication |      29 |       0 |     1,410 |
| verbose-code             |      30 |       0 |     1,148 |
| test-redundancy          |      27 |       0 |       785 |
| shared-helper-reuse      |       5 |       0 |       245 |
| boilerplate              |       3 |       0 |       193 |
| duplication              |       5 |       0 |       107 |
| test-policy-violation    |       2 |       0 |        85 |
| dead-code                |       2 |       0 |        68 |
| **Total**                | **103** |   **0** | **4,041** |

Entry counts use each entry's primary category. LOC is split by each constituent finding's category, so run-5's 38 dead-code lines count under dead-code even though the merged run-2+run-5 entry is listed as fixture duplication.

| Area                                                          | Entries | Test LOC |
| ------------------------------------------------------------- | ------: | -------: |
| tests/run/ (SubagentService harness and run tests)            |      21 |      940 |
| tests/tools/, tests/ui/, tests/workspace/, herdr-host fixture |      23 |      890 |
| Profiles, config and settings UI tests                        |      20 |      781 |
| Host, local backends and other top-level tests                |      17 |      633 |
| Herdr host, harness and supervisor tests                      |      18 |      585 |
| Shared test support (cross-cutting merges)                    |       4 |      212 |

**Dedup notes.** Each merge is counted once:

- run-2 + run-5 both remove `retainedServiceFixture`'s `capture` parameter. The run-2 verifier already excluded run-5's sites, so the two are additive: 80 + 38 = 118.
- profiles-config-1 + run-22 are the same ProfileCandidate builder. Four of run-22's five copies are in profiles-config-1. Counted at 60, profiles-config-1's figure. run-22's `run/retry.test.ts` copy adds a few lines that are not counted.
- ws-5 + profiles-config-3 + rest-13 are one plainTheme fixture. ws-5's roughly 20 stubs include profiles-config-3's 8 and rest-13's 6 files, except notification-presentation. Counted at 50: ws-5's 65 less 15 for the three stubs that ws-1 deletes (compact-expansion ×2, compact-summary:160-165). rest-13's selectKeybindings and projectionOf add lines that are not counted.
- herdr-supervisor-14 + rest-10 are the same temp-directory registry. Counted at 64: supervisor-14's in-unit 30 plus rest-10's 38, less 4 for the four supervisor-channel staging sites that supervisor-16's `stageAgentHome` absorbs.
- herdr-supervisor-13 + rest-9 are the same process-liveness module. Counted at 63: supervisor-13's in-unit 25 (herdr-codex-hooks and pi-supervisor-bridge) plus rest-9's 38 (probe-interruption, rpc-session, process-tree, the module).
- rest-12 + run-23 are the same promiseGate, eventBus and pick-questionnaire fixtures. Counted at 35, rest-12's figure.
- Range overlaps were deducted from the dependent finding:
  - run-3: −14, one line for each test that run-7/8/9/10/11/12/15/20/21 delete or merge.
  - run-1: −2, lifecycle:664-665 and one observations pair inside tests that run-20 and run-7 remove.
  - run-24: −6, four wait sites inside tests that run-8 and run-9 merge.
  - run-6: −2, observations:708-714, which run-7 merges.
  - ws-18: −5, five spreads inside ws-7's awaitSingle tests.
  - ws-9: −2, start:235-237, inside the test ws-16 deletes.
  - herdr-supervisor-3: −4, the second hostLayer block that supervisor-1 already shrinks.
  - herdr-supervisor-6: −3, the harness build at 801-807 counted by supervisor-5.
  - herdr-supervisor-12: −4, pi-supervisor-bridge:143-148, which the shared waitForPid replaces.
  - herdr-supervisor-15: −1, a trailing close inside the peer-close tests that supervisor-16 folds.
  - rest-14: −14, two rpc contexts in application:278-340 that rest-8 already shortens.

Paths below are relative to `packages/pi-subagents/` unless another package is named. The format is **Src / Test** LOC · risk · effort. Ids drop the `T-sub-` prefix.

### tests/run/: SubagentService harness and run tests (0 src / 940 test)

- **run-3: A generator-bodied `withService` helper replaces the per-test `const service = yield* SubagentService` and `.pipe(Effect.scoped, provideBuiltLayer(layer))` wrapper.** **0 / 136** · low · M
  - `tests/run/fixtures/service-harness.ts`. The wrapper appears in 204 sites across `tests/run/{controls,lifecycle,observations,reports,writer-ownership,launch,retry,write-claims-control,workspace,question-notification,proxy,startup-deadline,lifecycle-stress,questionnaire-lifecycle}.test.ts`.
  - Export `withService(layer, function* (service) {...})` with a generic signature that mirrors `Effect.gen`. Typed errors and requirements must survive, so do not copy `effectTest`'s never-error typing. Convert nested scoped blocks mechanically. Keep `tree.test.ts` `withFixture`, optionally reimplemented on top of the helper.
  - Why it holds: each test still gets the same layer, Scope and service instance. The helper saves about 1 line per test (spot-checked: 204 service lines, 205 pipe lines).
- **run-2 + run-5: Make fixture notification capture always on, and delete dead fixture options.** **0 / 118** · none · M
  - `service-harness.ts:459,533,704-734`. About 18 hand-built `notifications`/`projections` + `serviceLayer` setups in controls, lifecycle, observations, question-notification, launch, writer-ownership, tree, reports, native-activity and usage-events. 11 `{ publishReturnsCount: true }` sites (reports.test.ts ×10, write-claims-control.test.ts:359).
  - `localServiceFixture` and `retainedServiceFixture` always record notifications, and the wrapper returns `options.notify`'s result. Delete `publishReturnsCount`, the `capture` parameter and `fakeWriterLeaseLayer.markGate`. Leave the custom-publish sites alone: writer-ownership:141 and the lifecycle-stress last-projection capture. Also update `tests/tools/await-cancellation.test.ts:25`.
  - Why it holds: `notifyRoot` treats a non-object return as no callback (service.ts:371-382). The publish result is ignored (service.ts:343-344). markGate has no callers (spot-checked).
- **run-4: `control.report(...)` on FakeRetainedControl, `emptyUsage`, and `retainedRequest` for herdr/claude requests.** **0 / 90** · low · S
  - `service-harness.ts:574-584`. `reports.test.ts`: 17 report literals between 439 and 1441, plus 193-205, 285-297, 263-270 and 362-369. `usage-events.test.ts:68-96`, `native-activity.test.ts:19-24`.
  - Replace each 7-8 line report literal with `control.report(runId, sequence, deliveryId, text, extra?)`, letting offer normalization fill the epoch. Use `usage: { ...emptyUsage(), cost: 0 }` to keep the known-zero cost. Use `retainedRequest({ closeOnReport: true })` at reports:263 and 362.
  - Why it holds: the frames are identical, and the effort fields that change are never asserted (spot-checked: 17 literals).
- **run-1: Add `settle()` to FakeChildControl and a `completeLocalRun` helper.** **0 / 83** · low · M
  - `service-harness.ts:60-85,391-413`. 61 message_end + agent_settled pairs across launch (including five 50-run loops), lifecycle, observations, controls, tree, writer-ownership, lifecycle-stress and reports.
  - `control.settle(text = "Assignment complete.")`. `completeLocalRun(service, control, runId, text?)` runs settle, then waitForCompleted, then waits for `released() === 1`. Optionally add `fillCompletedHistory` for launch. Gate-release sites (launch:198) use only settle().
  - Why it holds: the frames and wait conditions are the same. waitForCompleted polls the authoritative list, so a test that immediately reads `projections.at(-1)` could in theory race (spot-checked: 61 pairs).
- **run-14: Tighten service-harness internals.** **0 / 60** · none · M
  - `service-harness.ts:145-210,284-314,329-357,376-386,391-413,564-572,651-661,695-702`
  - Build the control as one object literal of one-line methods, replacing 12 setter closures that are listed twice. Add `forSpawn` and `takeFirst` helpers for 3 filter-map chains and 6 findIndex-splice sites. Replace the get_state and start-failure IIFEs with ordered conditional spreads. Give serviceLayer an optional registry layer so retainedServiceLayer becomes one call.
  - Why it holds: the fake keeps the same FIFO matching, payloads and error-field order.
- **run-6: A shared `acknowledgeCompletions` notify policy.** **0 / 53** · none · S
  - `launch.test.ts:322-334,392-404,475-487,522-531`; `tree.test.ts:132-143,190-201,240-251`; `reports.test.ts:1289-1295`; `observations.test.ts:708-714`
  - Export the policy from service-harness for tree and reports. Delete the four launch callbacks outright, because they equal the root-run default (completion.ts:115-125).
  - Why it holds: it returns the same keys. The tree nested fallback still reads `rootDelivery.deliveredCompletionKeys` (service.ts:486-489).
- **run-8: Table-drive the four 'interrupt failure keeps the run running' tests.** **0 / 40** · low · M
  - `controls.test.ts:212-315`
  - Use `it.effect.each` rows `{ inject (effectful), waitFor, advanceClock, code?, operation, suppressed }`. Keep the message substrings and the natural-completion tail per row.
  - Why it holds: every fault still asserts its code or operation, the suppressed follow-up command, the running state, and a working follow-up send.
- **run-13: A counting option on fakeWriterLeaseLayer.** **0 / 38** · none · S
  - `service-harness.ts:446-555`; `writer-ownership.test.ts` (11 tests, 29-775)
  - Pass a `counts` object that the fake increments internally, in place of `let n = 0` plus `onX` counter callbacks. Keep the `onX` callbacks for the ordering tests.
  - Why it holds: the counters increment at the same points, before the failure branches.
- **run-7: Collapse the completion-retry tests in observations.** **0 / 35** · low · S
  - `observations.test.ts:668-858`
  - Add a local `completedRunWithDelivery(policy)` that can run inside a nested scope. Merge the unacknowledged and throwing cases into one `it.each`, keeping the notifications-length check and the 30 s tail on both rows. Keep the backoff-cap, claim-removes-retry and scope-close tests.
  - Why it holds: notifyRoot maps a throw to `deliveredCompletionKeys: []`.
- **run-15: retry.test.ts helpers and it.each.** **0 / 35** · none · S
  - `retry.test.ts:80-161,283-310,352-400,433-479`
  - Add `rejectedPrompt(extra?)` and `startFailedReviewer(...)`. Merge the eligible and exhausted recovery tests. Each row keeps its own entry point (startSessionOwned or start), and the eligible row keeps `toEqual` plus its claim and release step.
  - Why it holds: every recovery disposition is still asserted.
- **run-24: `sent`, `sentIpc` and `commandTypes` accessors on FakeChildControl.** **0 / 34** · low · S
  - `controls.test.ts:65-1114` (17 sites); `lifecycle:499-501`; `startup-deadline:22-89`; `tree:153-275`; `observations:66-68`; `question-notification:111-113`; `write-claims-control:212-214`; `reports:141-143`
  - Replace the 3-5 line `commands.some(...)` waits and `flatMap` type projections. In `yieldUntil` predicates, keep `fake.controls[0]?.sent("steer") === true` wherever the child may not exist yet, because `!` would throw.
  - Why it holds: the predicates and ordered sequences are unchanged.
- **run-9: Table-drive the in-flight RPC termination tests.** **0 / 30** · low · S
  - `controls.test.ts:448-481,1083-1121`
  - Use one `it.effect.each` over `{ inject: gate|drop, terminate: stop|protocol|clock }`. Replace the 1103 test with a dropped-response + protocol-error row driven through rename, which keeps the name-unchanged check.
  - Why it holds: both correlatedRequest phases stay covered, and rename rollback is also covered at startup-deadline:95.
- **run-10: Remove the duplicate 'question delivery retries once after a throwing callback' test.** **0 / 30** · none · S
  - `controls.test.ts:949-987` (delete); `question-notification.test.ts:198-227` (extend)
  - Add the warning offer, an attempts===1 check after the warning and the waiting_for_parent assertion to the question-notification test.
  - Why it holds: SubagentNotification has only two variants, so the two filters are equivalent.
- **run-19: reports.test.ts `awaitAndConsume` helper and uncertain-resume prelude.** **0 / 30** · none · S
  - `reports.test.ts:226-238,320-332,510-520` (awaitAndConsume); `255-279,354-378` (prelude, which diverges after epoch 2)
  - Why it holds: only plumbing is shared, and the exactly-once, precedence and duplicate-suppression assertions stay in each test.
- **run-20: Remove the redundant stopped-run rename and resume-clears-report tests.** **0 / 27** · low · S
  - `lifecycle.test.ts:512-525` (delete); `659-673` (fold into 339-361 with finalText "Assignment complete." before resume and undefined after)
  - Why it holds: control.ts:541-551 renames every non-live state through the same local branch.
- **run-21: Table-drive the canonical-alias and filesystem-identity writer-guard tests.** **0 / 20** · none · S
  - `writer-ownership.test.ts:303-378`. Keep the unrelated-cwd admission in both rows. Apply after run-13.
- **run-11: Parametrize the stale-idle and sleeping-retry question wake tests.** **0 / 18** · none · S
  - `controls.test.ts:989-1043`, as `for (const idle of [true, false])`.
- **run-17: writer-preparation.test.ts reuses `view()` and `testBackendDriver`.** **0 / 18** · none · S
  - `writer-preparation.test.ts:38-68` (fixtures at `tests/tools/fixtures/tool-harness.ts:62-96,143-150`)
  - Why it holds: record-cleanup never calls the driver and reads no asserted field that differs.
- **run-12: Delete the redundant explicit-effort mismatch test.** **0 / 15** · none · S
  - `launch.test.ts:162-178` (delete). Add `code: "pi_effort_unsupported"` at :131.
  - Why it holds: src/run/launch.ts has a single branch for this case.
- **run-16: A shared 'interrupt waiter before use while a gate is held' probe.** **0 / 15** · none · S
  - `observations.test.ts:69-99` and `question-notification.test.ts:114-137` only. Leave completion-admission.test.ts:58-91 inline, because it differs.
- **run-18: workspace.test.ts `record()` builder and `expectModeSwitchBlocked` helper.** **0 / 15** · none · S
  - `workspace.test.ts:206-219,232-244,268-285,295-307`

### tests/tools/, tests/ui/, tests/workspace/ and the herdr-host fixture (0 src / 890 test)

- **ws-1: Fold compact-expansion.test.ts and the compact-summary animation test into presentation-conformance via `createToolPresentationHarness`.** **0 / 130** · low · M
  - `tests/tools/compact-expansion.test.ts:1-156` (delete); `presentation-conformance.test.ts:21-48`; `compact-summary.test.ts:1-15,133-200`
  - Move `registered()` (with theme and settings restore) into `tests/tools/fixtures/`, with runtime overrides for `startUiTicker` and `scheduleAnimation`. Drive the tests with `harness.call/result({ expanded, isPartial, executionStarted, isError, invalidate })`, and build await details with `makeAwaitDetails`. This follows the CLAUDE.md rule to exercise registered definitions through `pi-code-previews/testing`.
  - Why it holds: the harness keeps `context.state` across calls and forwards `invalidate`, so the ticker and invalidation counts keep their meaning. The harness now passes `lastComponent` as Pi does, so rerun the ticker assertions once (spot-checked).
- **ws-3: `exists`, `fails` and `readText` helpers in git-worktree tests.** **0 / 80** · none · S
  - `tests/workspace/git-worktree.test.ts:167-569` (7 eight-line fs.access probes, 7 Exit.isFailure blocks, about 13 readFile expects); `git-worktree-recovery.test.ts:113-123`
  - Why it holds: only call syntax changes. The verifier counted about 95 lines, and the spot-check confirmed the probes.
- **ws-4: A Promise-returning `executeTool` helper and an options-object `captureSubagentTools`.** **0 / 65** · none · M
  - `tests/tools/fixtures/tool-harness.ts:172-181,277-298`; `management.test.ts:246-1043` (10 raw execute sites); `start.test.ts:95-104,829-850,1018-1028`; `await-cancellation.test.ts:26-168`
  - `executeTool(tool, params, { callID, signal, update, context })` must accept a plain ToolDefinition, and `invokeOptionalTool` is rebuilt on top of it. Change `captureSubagentTools` to `(service, { activeTools, profiles, registry, environment, thinkingLevel, startUiTicker, toolPresentation })`. Use `extensionApiFixture` in await-cancellation.
  - Why it holds: tools run with the same arguments, signals and update callbacks.
- **ws-2: A `route()` candidate builder in start.test.ts.** **0 / 60** · none · S
  - `tests/tools/start.test.ts:165-789` (about 16 literals). Defaults are local/pi/parent/default/fresh/read-only. Its defaults differ from profiles-config-5's `declared()`.
  - Why it holds: the decoded documents are identical.
- **ws-6: `entry()`/`selected` builders and a file-scope `workspace()` helper in compact-summary.** **0 / 55** · none · S
  - `compact-summary.test.ts:265-343,465-496,643-736,926-941,1070-1090`
- **ws-7: `awaitSingle`, `violationAudit`, `contained` and `expectInOrder` for the management writer-containment await tests.** **0 / 45** · low · S
  - `management.test.ts:822-1003,1169-1182`; `details-schema.test.ts:46-57`
  - `expectInOrder` must take each index with `indexOf` from 0 (first-occurrence semantics) and keep the explicit search after resume for the final await.
- **ws-8: `makeAwaitDetails` or a local `awaitReceipt` in place of hand-built await details.** **0 / 45** · low · S
  - `compact-summary.test.ts:434-878` (5 sites; local helper with no default awaitedRunIds); `presentation-conformance.test.ts:71-100,222-251` (`makeAwaitDetails`)
- **ws-9: A `preflightRegistry` builder, a `HERDR_PROTOCOL_21` constant and a `startTool` helper in start.test.ts.** **0 / 43** · low · S
  - `start.test.ts:448-731` (5 registries) and about 10 capture chains. The figure is 45 less 2 for the chain at 235-237 inside the test ws-16 deletes.
  - Why it holds: resolving to `{...testBackendDriver, runtime: selection.runtime}` matches every path the tests reach.
- **ws-10: One faults object for the Herdr fixture's 16 one-shot boolean setters.** **0 / 40** · low · M
  - `tests/fixtures/herdr-host-fixture.ts:69-99,612-720`; about 17 call sites in `herdr-host(-ownership).test.ts`. Keep the parameterized and multi-flag setters, including the `block*Snapshot` gates. The cost is readability, because callers then name internal flags.
- **ws-11: Simplify tool-harness internals.** **0 / 40** · none · S
  - `tool-harness.ts:114-326`: drop the IIFEs, hoist `parentModel`, use one `fixtureBackend` for resolve and preflight, and reuse `extensionContextFixture`/`extensionApiFixture`. Spread on `input.profile !== undefined`.
- **ws-12: Widen render-hierarchy's `render()` helper to `{ partial, expanded, width, panel }` and add `text()`.** **0 / 35** · none · S
  - `render-hierarchy.test.ts:35-303`. Pass `panelOwnsLiveHierarchy` only when it is set. Leave the content-only test at 309-325 unchanged.
- **ws-13: Herdr fixture literal builders.** **0 / 32** · none · S
  - `herdr-host-fixture.ts:124-547`: `foreignPane`, `foreignAgent` and `fixtureFailure`, with inline spreads in place of object IIFEs.
- **ws-14: One `snapshotGate()` factory for the pre-split, post-split and post-close gates, dropping two uncalled release APIs.** **0 / 30** · low · S
  - `herdr-host-fixture.ts:98-110,336-359,669-707`
  - Why it holds: the only behavioral difference, closing a pane before any split, is unreachable in the tests.
- **ws-15: Use `SubagentStartDetails` (or its decoder) instead of inline structural casts.** **0 / 28** · none · S
  - `start.test.ts:941-964,1190-1201`, narrowing `runId`; `management.test.ts:113-117`, using `not.toHaveProperty("cards.0.finalText")`.
- **ws-16: Delete the short-form generalist start test and the redundant page-inclusion check.** **0 / 27** · low · S
  - `start.test.ts:231-254` (delete, and fold `profile`, `selection` and `profileGuidance: stringContaining("Act as a generalist")` into the first test at 77-84); `tests/tools/workspace.test.ts:54-61`
  - Why it holds: the guidance-identity check survives, and the display-span loop proves exact slices.
- **ws-17: A `prepareIntegration(service, handle)` helper.** **0 / 25** · none · S
  - `git-worktree.test.ts:60-411` (5 freeze/prepare sequences). Only the order in which a regression reports failures changes.
- **ws-20: Loop the forged-field rejections and use Deferred directly.** **0 / 20** · none · S
  - `start.test.ts:35-42,1116-1177`
- **ws-19: session-output's `baseRun` via the shared `view()`.** **0 / 18** · low · S
  - `tests/ui/session-output.test.ts:13-39`. Move `view()` to `tests/fixtures/run-view.ts` and re-export it from tool-harness.
  - Why it holds: no asserted string depends on the fields that differ.
- **ws-18: Remove the no-op `startCapturingService([])` spreads from management doubles.** **0 / 17** · none · S
  - `management.test.ts` (about 20 sites, 208-1238); `start.test.ts:791-806`. The figure is 22 less 5 for sites that ws-7 absorbs.
  - Why it holds: the root tools never call `visibleList` or `startSessionOwnedFrom`.
- **ws-21: Remove the unused renderResult typing from CapturedTool.** **0 / 15** · none · S
  - `tool-harness.ts:29-60`. This is a type-only change.
- **ws-22: A shared temporary git-repository fixture that reuses `workspaceIO`.** **0 / 15** · none · S
  - New `tests/workspace/fixtures/repository.ts` replacing `git-worktree:13-44`, `git-worktree-recovery:11-34`, `listing:22-49,216-221` and `store:15-22`. Related to the temp-directory merge below.
- **ws-23: Delete the never-written `focusOperations` probe and its 14 vacuous assertions.** **0 / 15** · none · S
  - `herdr-host-fixture.ts:65,599`; `herdr-host-ownership.test.ts` (6); `herdr-host.test.ts` (8)
- **ws-24: Let `summarize()` accept several content parts.** **0 / 10** · none · S
  - `tests/tools/compact-parent-summary.test.ts:11-20,87-104`

### Profiles, config and settings UI tests (0 src / 781 test)

- **profiles-config-2: One inherited-invalid-route inspection fixture.** **0 / 85** · none · S
  - Replaces builders at `profile-route-editor.test.ts:71-104`, `profile-workspace-ui.test.ts:84-111`, `profile-workspace.test.ts:32-58` and `profile-set-picker.test.ts:37-91`
  - Add `INVALID_ROUTE` and `inheritedInvalidInspection({ profile, ownInvalid })` to `tests/fixtures/profile-settings-inspection.ts`. Drop the unused `"valid"` branch. The picker's `invalidInspection` keeps the set name "broken" and `projectTrusted: false`.
  - Why it holds: the only set name asserted is the Project "partial" target (spot-checked: about 143 builder lines).
- **profiles-config-4: Bound mutation methods plus `readGlobal`/`readProject`/`rejects` helpers on the config-store fixture.** **0 / 80** · none · M
  - `config-store.test.ts:27-46` and about 31 call sites (191-1033). Use `{ projectTrusted: true, ...patch }` so the explicit `false` at 284 and 928 still wins.
  - Why it holds: the real store Layer still runs on real files (spot-checked: 34 withStore, 21 rejects, 17 reads).
- **profiles-config-14: Delete UI-flow tests that neighbors already cover.** **0 / 70** · low · S
  - Delete `profile-workspace.test.ts:273-283,307-316`, `profile-dashboard.test.ts:631-640`, `profile-set-picker.test.ts:324-333`, `profile-workspace-navigation.test.ts:87-98` and `profile-workspace-ui.test.ts:313-324`. Drop `withRepairOverride` from `invalidBaselineInspection` (profile-workspace:60-78).
  - First add a stray "x" no-confirm step to 207-243. Fold the gg→model assertion from navigation 320-333 into 288-318, or keep that test.
  - Why it holds: only the guard for the removed 1/2/3 keys is lost.
- **profiles-config-5: A typed raw `declared(model, overrides)` route builder for the config-store literals.** **0 / 65** · low · S
  - `config-store.test.ts:57-990` (14 literals); `profile-set-picker.test.ts:155-163`
  - Give it no openaiFastMode default, so v4/v5 documents stay valid. Type the overrides as `Partial<DeclaredProfileCandidate> & JsonObject`, and never pass `closeOnReport: undefined`. Keep the legacy `fastMode` literal at 513-522 inline.
- **profiles-config-13: Remove copy- and icon-only UI assertions that the testing policy excludes.** **0 / 65** · low · S
  - Delete `profile-dashboard.test.ts:127-184` and `profile-workspace.test.ts:690-704`. Loosen `profile-route-editor.test.ts:344` to `{ valid: false }`. In `profile-workspace.test.ts:369-379`, keep the saveDraft-not-called check and drop only `toContain("Advanced")`.
  - Why it holds: the underlying behaviors are covered at dashboard 99-126, config-store 153-228, profiles 382-442, controller 591-604 and route-editor 329-336.
- **profiles-config-1 + run-22: One shared `profileCandidate(model = "parent", overrides)` fixture.** **0 / 60** · none · S
  - `profile-model-catalog:25-35`, `profile-override-handoff:5-14`, `profile-reload-handoff:19-28`, `profile-route-editor:32-43`, `profile-workspace-ui:29-43`, `profile-workspace-navigation:21-31`, `profile-workspace:143-152,566-575`, `session-profile-overrides:20-29`, `run/retry.test.ts:13-22`
  - Place it in `tests/fixtures/`. Do not use it for raw v4/v5 declarations.
- **profiles-config-12: Simplify the profile-settings-controller fixtures and drop two subsumed tests.** **0 / 45** · low · S
  - `profile-settings-controller.test.ts:43-101,389-486,657-676`
  - Parameterize `inspection(globalDefault)` and add a `useSelectedSet` helper. Delete 416-427, which profile-dashboard 185-205 and controller 503-523 cover. Delete 668-676 and add `toHaveBeenLastCalledWith("shared-checkout")` to the retry test. Label the loop at 460 explicitly.
- **profiles-config-9: One table for the fast-mode eligibility cases.** **0 / 35** · none · S
  - `profiles.test.ts:382-442`. The "-option" codex row gains an `invalidProfileRoutes` assertion; confirm it when applying.
- **profiles-config-15: Tighten profile-route-editor.** **0 / 35** · low · S
  - Add `setTarget` and `load` helpers (113-144, 189-255). Delete the builtin-constant test at 543-553. Move the boolean `isNativeProfileModelSelector` cases from 506-530 into a `profiles.test.ts` `it.each` that replaces 487-497. Keep the decode integration at 509-520 and 531-540.
- **profiles-config-11: Build seven-profile maps from `PROFILE_IDS` with `everyProfile(value)` and `completeBaseline`.** **0 / 32** · none · S
  - `profile-override-handoff:16-36`, `profile-reload-handoff:29-56`, `session-profile-overrides:33-51`, `profile-dashboard:115-123`, `config-store:821-823`. The cast needs a SAFETY comment. Apply after profiles-config-1.
- **profiles-config-10: One `resolveTestConfig(global, project?, trusted = true)`.** **0 / 30** · none · S
  - `fixtures/profile-settings-inspection.ts:19-30`; `config.test.ts:6-15`; `profiles.test.ts:110-127`; `session-profile-overrides.test.ts:64-92,661-671`. Keep the "global" and "project" scope labels, and return the decoded documents.
- **profiles-config-7: Fold profile-store.test.ts into config-store.test.ts.** **0 / 28** · none · S
  - Create a `describe("writer workspace preference")` block with a bound `patchWriterWorkspace`. The activation test joins profiles-config-6's table. Apply after profiles-config-4.
- **profiles-config-16: `search()` and `fields()` helpers in profile-workspace-ui.** **0 / 28** · none · S
  - `profile-workspace-ui.test.ts:181-310`
- **profiles-config-6: Collapse duplicated config-store scenarios.** **0 / 25** · low · S
  - `config-store.test.ts:93-101,230-244,306-377,467-506,991-1032`; `profile-store.test.ts:99-109`
  - Build one invalid-document table asserting `activate` at the global path; use `effectTest` with a `for` loop if there is no `.each`. Loop the no-op block over project and global, and loop the stale mutations. Delete the v4 nesting-upgrade test at 484-506. The figure is counted after profiles-config-4.
- **profiles-config-18: Drop provenance assertions that the matrix (154-203) already covers.** **0 / 25** · low · S
  - Delete `session-profile-overrides.test.ts:208-210,218-223,243-262`. Keep the positive controls at 233-235 and 279-285, because they anchor the route-mismatch negatives.
- **profiles-config-17: `staticCatalog` and `pick` helpers in profile-model-catalog.** **0 / 22** · none · S
  - Apply `staticCatalog` at 156-160, 184-188, 207-214 and 269-273 only. The registry at 139-143 reassigns `models`. Apply `pick` to all seven `loadCandidateModelPicker` calls.
- **profiles-config-8: A `staticStore(config)` for the two identical SubagentConfigStore stubs.** **0 / 17** · none · S
  - `profiles.test.ts:927-945,972-990`
- **profiles-config-20: A shared `fleetManagerActionsFixture(value, overrides)`.** **0 / 15** · low · S
  - `profile-dashboard.test.ts:37-68`; `profile-settings-controller.test.ts:123-149`. Every member defaults to a rejecting `unused` stub, except `isAvailable` and `captureModelRefresh`, so the dashboard keeps its guard against unexpected persistence calls.
- **profiles-config-19: One stateful workspace harness and one `settleTurn` helper.** **0 / 12** · none · M
  - `profile-workspace-navigation.test.ts:32-84`; `profile-workspace.test.ts:87-118,142-166`
- **profiles-config-21: Merge the redundant session-key test into profile-reload-handoff:236-273.** **0 / 7** · none · S
  - Delete 275-285. The `slotPresent` helper is for readability only.

### Host, local backends and other top-level tests (0 src / 633 test)

- **rest-1: host-notifier `notifier()` and `completion()` builders, `toContain` in place of full-string matches, and one merged batch test.** **0 / 75** · low · S
  - `host-notifier.test.ts:7-348`. Keep the steer/triggerTurn assertion in both the first completion test and the question test, because host-notifier.ts:179-194 and 210-217 are separate send paths.
- **rest-3: writer-lease: delete the redundant live-conflict test and add builders.** **0 / 55** · low · S
  - `writer-lease.test.ts:173-626`. Delete 328-345 and add `ownerPid: process.pid` to the alias test. Add `expectConflict`, `pausedHook` and `deadOwnerPair`. The simultaneous-contender test keeps its own contenders.
- **rest-7: local-cli-events `rpcResponse`, `piDriver` and `withOwnership(capacity, use)`.** **0 / 55** · none · M
  - `local-cli-events.test.ts:25-459`. The spawn override keeps the acquireRelease variant at 232-266.
- **rest-2: local-claude-replay `startBackend` and tables.** **0 / 50** · none · S
  - `local-claude-replay.test.ts:390-672`. Seven start sites. Use `it.effect.each` for the four internal-frame tests, and one table with a single epoch for the rejection tests at 482-551. The foreign-replay no-leak test stays separate.
  - Why it holds: the epoch matters only in the accepted-report scenarios.
- **rest-5: fleet-component reuses `view()`, `makeFleet` options, and a merged pane-navigation pair.** **0 / 50** · low · S
  - `fleet-component.test.ts:19-265`
- **rest-21: Small in-file duplications, as an aggregate.** **0 / 50** · low · S
  - Covers `collect()` in bounded-line-parser, `gatedInputs()` in local-claude, the local-cli-harness fault table, `it.each` in local-cli-interruption, `capability()`/`owner()` in ask-user-proxy, `childStub`/`taskkillHelper` in process-tree, and panel-specific cadence cases in activity-panel.
  - Keep the `proxy-protocol.test.ts:111` round-trip completeness assertion. Only its `Object.isFrozen` line may go.
- **rest-4: details.test: delete the duplicate dense-start-failure test and share builders.** **0 / 45** · none · S
  - Delete `details.test.ts:944-971`, but make the odd entries of the 577-618 dense test unavailable entries with long warnings, keeping entry 0 selected. Add `modelsDetails()` and `readGuarded()`. Use `awaitWire` only where the clone spans several lines.
- **rest-6: local-codex-protocol: delete the lifecycle test that the matrix covers.** **0 / 42** · low · S
  - Delete `local-codex-protocol.test.ts:34-76`. Enrich `collabBase` with model 'gpt-native', reasoningEffort 'high' and `agentsStates` `{ 'native-1': { status: 'running', message: null } }` so the record decode stays exercised. Add `activityId` to the rows, and add a `decode(method, item)` helper.
- **rest-8: application.test `rpcContext()` and `activeToolTracker()` builders, and deletion of 11 stale SAFETY comments.** **0 / 38** · none · S
  - `application.test.ts:227-691`. Keep the getter-based `firstContext` (227-248) as a literal.
- **rest-11: `backendLaunch(overrides)` and `takeBackendEvent` in `tests/fixtures/backend-supervisor.ts`.** **0 / 30** · none · S
  - Apply only at BackendLaunchRequest sites: local-claude-replay, local-cli-events, local-cli-harness, local-codex, and optionally real-smoke. Leave the ChildLaunchRequest literals in process-transport and fork-context, because of exactOptionalPropertyTypes.
- **rest-16: local-claude-debug: generalize `recordTail(env)` and put the three no-ledger tests in one table.** **0 / 30** · none · S
  - `local-claude-debug.test.ts:24-43,58-119`
- **rest-17: local-pi-ipc: an `acks` array used once, `ignoreParent` handlers, shared predicates and `takeUntil`.** **0 / 30** · none · S
  - `local-pi-ipc.test.ts:108-314`
- **rest-15: A host-child `awaitContact(harness, type, match?)` helper.** **0 / 25** · none · S
  - `host-child.test.ts:243-585` (about 12 sites)
- **rest-19: native-model-catalog `selectorAt`.** **0 / 15** · none · S
  - `native-model-catalog.test.ts:83-162`
- **rest-20: Fold activity-provider:115-136 into the 138-203 table.** **0 / 15** · low · S
  - Add the admission-paused and stopping rows to the table.
- **rest-14: Run the root and child activation-lifecycle scenarios over both registration paths.** **0 / 14** · low · M
  - `application.test.ts:71-96,278-340`; `host-child.test.ts:196-219,290-309,605-625`
  - Use per-path adapters `{ start, shutdown, registeredToolCount, activeTools }` with `describe.each`. Drop the sync-throw preview variants, which `pi-cosmic-core/tests/host-bootstrap.test.ts` covers. Keep the child's `['read']` assertion. The figure is 28 less 14 for the overlap with rest-8.
- **rest-18: fork-context: a `toJson` alias and folded `toContain` loops.** **0 / 14** · none · S
  - `fork-context.test.ts:86-288`

### Herdr host, harness and supervisor tests (0 src / 585 test)

- **herdr-supervisor-2: `launchRun` and `launchInRunScope` helpers for 40 hand-written Herdr launches.** **0 / 105** · low · M
  - `herdr-host.test.ts:32-486`; `herdr-host-ownership.test.ts:26-520`; helpers in `tests/fixtures/herdr-host-fixture.ts`. Keep `herdr-host.test.ts:31,146` passing `supervisor` directly (runId mismatch).
  - Why it holds: launch arguments and scope handling are unchanged (spot-checked: 40 spreads, 12 run-scope sites).
- **herdr-supervisor-1: Export `hostLayer(fake)` from the Herdr fixture.** **0 / 70** · none · S
  - Replaces 17 inline `HerdrHost.layer` blocks in `herdr-host-ownership.test.ts` and the local definition at `herdr-host.test.ts:15-20`.
- **herdr-supervisor-10: Merge the three uncertain-explicit-report bridge tests into a loop over `[stop, 2]` and `[aborted, 1]`.** **0 / 58** · low · S
  - `host-pi-supervisor-extension.test.ts:295-367,464-495`
  - The only gap is the explicit retry through the fallback epoch. Fallback identity stays covered for auto-reports.
- **herdr-supervisor-11: Generalize `bridgeHarness`/`startBridgeHarness` and add `finishTurn`, `submitReport` and `reportCall`.** **0 / 40** · low · M
  - `host-pi-supervisor-extension.test.ts:111-649`. The fast-mode and credential tests use the unstarted harness with a flags override.
- **herdr-supervisor-12: `withBridgeChannel` and `readFixturePid` in pi-supervisor-bridge tests.** **0 / 36** · none · S
  - `pi-supervisor-bridge.test.ts:54-364`. The figure is 40 less 4 for the site that the shared `waitForPid` replaces.
- **herdr-supervisor-5: A `harnessWith(overrides)` builder, and a table for the three preflight rejections.** **0 / 35** · none · S
  - `herdr-harness.test.ts:149-807`. The table replaces 411-451.
- **herdr-supervisor-9: One table for the protocol and calling-pane rejection tests, asserting codes only.** **0 / 35** · low · S
  - `herdr-cli-readiness.test.ts:92-162`
- **herdr-supervisor-16: `connectionRefused`, `awaitPeerClosed` and `stageAgentHome` probes.** **0 / 30** · none · S
  - `supervisor-channel.test.ts:403-726`. The malformed-frame row keeps the default auth timeout.
- **herdr-supervisor-15: A `readyHelper(handle)`, and scope close owned by afterEach.** **0 / 27** · low · M
  - `supervisor-channel.test.ts:80-1683`. The single afterEach closes registered scopes first, with an exit check, then kills children, then removes directories. Delete trailing close pairs only where nothing is asserted after them. Keep the closes at 635, 674-690, 1088-1094 and 1726-1732.
- **herdr-supervisor-8: `withSetup` and `prepareOwned` for the eight herdr-harness argv/config tests.** **0 / 25** · low · M
  - `herdr-harness.test.ts:453-942`. prepareOwned uses acquireRelease to authorize cleanup. LIFO order authorizes cleanup before the harness finalizer runs.
- **herdr-supervisor-4: The existing `supervisorMetadata("agent-herdr", {...})` fixture in place of the 30-line literal.** **0 / 22** · none · S
  - `herdr-harness.test.ts:113-142`
- **herdr-supervisor-18: Check tools/list structure without the regex literals.** **0 / 20** · low · S
  - `supervisor-channel.test.ts:825-860`. Assert the tool names in order, `required` and `additionalProperties: false` for submit_report, and `required: ["message"]` for the message tools. Drop the regex literals.
- **herdr-supervisor-6: Merge the two herdr-harness tests that run the same fault configuration.** **0 / 17** · none · S
  - `herdr-harness.test.ts:729-755,797-825`
- **herdr-supervisor-17: Drop the forged-token and oversized-line blocks from the final supervisor-channel test.** **0 / 17** · none · S
  - `supervisor-channel.test.ts:1662-1678,1722-1725`. Keep the loopback host check, and rename the test.
- **herdr-supervisor-21: Small redundancies.** **0 / 16** · none · S
  - Drop the redundant `toMatchObject` after `toBe` at herdr-backend:152. Merge the two codex-hooks `it.each` lists (119-137). Delete the in-repo invalid-input session-hook test (90-94). Keep the delegation-policy prompt assertions.
- **herdr-supervisor-3: Table-drive the two post-attestation drift quarantine tests.** **0 / 11** · none · S
  - `herdr-host-ownership.test.ts:176-232`. The figure shrinks further if supervisor-2 lands first.
- **herdr-supervisor-7: Delete the obsolete-marker test (397-409) and add `[runtime, 6]` rejection rows to the table at 359-395.** **0 / 11** · none · S
- **herdr-supervisor-20: Declare the pinned Herdr environment values once.** **0 / 10** · none · S
  - `herdr-environment.test.ts:7-42`

### Shared test support: cross-cutting merges (0 src / 212 test)

- **ws-5 + profiles-config-3 + rest-13: One `plainTheme` (identity fg, bg, bold, underline, under one SAFETY comment).** **0 / 50** · none · S
  - Replaces about 20 local `as Theme` stubs:
    - profile tests: dashboard, set-picker, set-save-form, target-picker, settings-controller, workspace-navigation, workspace-ui, workspace
    - tools tests: presentation-conformance, render-hierarchy, compact-summary
    - others: ui/session-output, application, host-pi-supervisor-extension, activity-panel, host-ui, fleet-component, host-child, notification-presentation
  - Also share `selectKeybindings`, since `application.test.ts:514-522` is an exact copy of `profile-settings-controller.test.ts:188-196`. Add `projectionOf(runs)` next to `view()`, using activity-panel's root-child count.
  - Why it holds: underline is required by the dashboard and controller, and identity bg is inert.
- **herdr-supervisor-14 + rest-10: One temp-directory helper.** **0 / 64** · none · M
  - Promise style: make, register and afterEach cleanup, for herdr-cli-readiness, herdr-codex-hooks(-real-smoke), herdr-codex-session-hook, herdr-harness, supervisor-channel, local-claude-debug, local-cli-harness, native-model-catalog, probe-interruption and rpc-session.
  - Effect style: `scopedTempDirectory`, for fork-context ×3, writer-lease:145-164 and process-transport:343-354.
  - supervisor-channel keeps one combined afterEach (close scopes, kill children, remove directories). pi-supervisor-bridge's pid cleanup stays custom. See ws-22 for the workspace repository fixture.
- **herdr-supervisor-13 + rest-9: `tests/support/process-liveness.ts`.** **0 / 63** · none · S
  - Exports `processAlive`, `waitForPid` and `waitForDead(pid, attempts = 200)` for herdr-codex-hooks, pi-supervisor-bridge, probe-interruption, rpc-session and process-tree (100 attempts there). Add `expectInterruptKills` in probe-interruption.
  - Treat only ESRCH as dead, and never probe pid ≤ 0 (a process group). See Needs a decision.
- **rest-12 + run-23: `promiseGate<A>()` in `tests/support/effect-test.ts`, plus `eventBus()` and `pickQuestionnaire` in a support module.** **0 / 35** · none · S
  - `application:62-68`; `host-child:40-61,226-239`; `writer-lease:42-50`; `ask-user-proxy:20-56`; `local-cli-harness:21-22`; `run/questionnaire-lifecycle.test.ts:19-40,85-96`

### Structural notes (unverified)

- ~60: service-harness has four overlapping positional fixture entry points. One options-object API returning `{ fake|backend, projections, notifications, layer }` would subsume run-2, run-5 and part of run-14 (`service-harness.ts:564-734`).
- ~80: herdr-host-fixture.ts is 741 lines with about 45 fault knobs. Split topology state from fault injection together with the consumer tests.
- ~60: More ProfileCandidate copies remain in details.test.ts and execute.test.ts. The resolveSubagentConfig input is hand-built in `application.test.ts:155`, `tool-harness.ts:114-140` (paths /project vs /repo) and `service-harness.ts:436`. The `ui.custom` overlay host is cloned between `application.test.ts:505-526` and `profile-settings-controller.test.ts:179-203`.
- ~45: start.test.ts:1056-1097 asserts only internal routing and call counts. Rewrite it to observe cancellation and snapshot consistency, or accept it as a structural guard.
- ~40: Theme, settings save/restore and render-only registration are cloned across the pi-subagents, pi-mcp and pi-background-task conformance tests. Exporting helpers from `pi-code-previews/testing` would be a cross-package change.
- ~40: Backend/ChildLaunchRequest literals remain in herdr-backend, herdr-harness, herdr-codex-real-smoke, pi-transcript-integration and the herdr-host fixture. The saving per site is small.
- ~30: A shared `runRecord(overrides)` builder would serve completion-admission, usage-events and writer-preparation.
- ~30: details.test.ts `claimed`/`auditedRun` could use `view()` once it moves to a neutral module (ws-19).
- ~25: The pi-transcript-integration setup is cloned in pi-mcp/tests/application.test.ts. A shared helper would pull pi-ai and pi-coding-agent into pi-cosmic-core/testing.
- ~25: activity-provider's `host()` fake is an exact 31-line clone of pi-background-task's. Its natural home is a new `pi-cosmic-ui/testing` subpath, which needs a manifest change.
- ~16: Fast-mode keys are asserted at four layers. The candidate-level test at profiles.test.ts:831-846 is the most redundant.
- ~15: Agent-facing prose assertions in host-notifier and host-child could assert semantic details instead. That needs a policy decision.
- ~10: Exact agent-facing copy in run tests (controls, launch, lifecycle, observations) could be loosened to typed codes.
- ~10: `src/settings/profile-set-actions.ts:117-119` has a `replaceSessionProfiles` fallback that only controller tests reach. Production always supplies the receipt variant (register.ts:426).
- ~10: Settle helpers are duplicated: `tick`, `settle`, the controller's 40-step `settleHostPromises`, and support's `eventLoopTurn`. Check whether the 40-step chain is a disguised timing wait.
- ~10: herdr-codex-hooks-real-smoke duplicates `setup()`. It is an opt-in smoke, so leave it.
- ~6: tests/support/node-builtins.ts re-implements src/boundary/node-builtins.ts. It could re-export instead.
- ~5: `targetProfileRouteDraft` (src/settings/ui/profile-workspace-model.ts:120-124) is a pure alias of `loadProfileRouteDraft`.
- 0: reports.test.ts:681-743 generates 24 nested cases. A pairwise subset would be a runtime gain only.
- 0: Exact glyph and counter-string assertions in session-output, management and compact-summary should be loosened while refactoring.
- 0: herdr-real-smoke-safety.ts belongs in tests/support/.
- 0: The animation-revocation test reads `registerSubagentTools` `mock.calls` (host-pi-supervisor-extension:164-179). Expose the scheduler through the bridge harness instead.
- 0: The roughly 310-line supervisor-channel epoch-safety test (789-1097) could be split so failures localize.
- 0: `view()` and `projectionOf` could move to tests/support/run-view.ts for a cleaner dependency direction.

### Needs a decision

No findings were disputed, and no spot-check demoted anything. One design choice came up during dedup:

- **Process-liveness guard for pid ≤ 0 (herdr-supervisor-13 + rest-9).**
  - The supervisor-13 verifier wants `processAlive` to return false for non-positive pids. `herdr-codex-hooks.test.ts:189-215` can call `waitForDead(0)` from a `finally` block, and a throw there would mask the original failure.
  - The rest-9 verifier wants it to throw, as `pi-supervisor-bridge.test.ts:29-31` does today.
  - Both refuse the process-group `kill(0|negative, 0)` probe. Returning false keeps the `finally` path quiet, and throwing surfaces misuse loudly.
