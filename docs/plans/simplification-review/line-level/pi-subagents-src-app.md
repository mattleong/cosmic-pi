## pi-subagents: settings, config/profiles, run, tools/ui, application (shard pi-subagents-src-app)

Seven review units (sub-settings-rest, sub-settings-workspace, sub-config-profiles, sub-run-core, sub-run-rest, sub-tools-exec-ui, sub-tools-render) produced 116 confirmed findings, 1 disputed and 0 dropped. After deduplication there are **111 entries removing about 1,803 source LOC and 114 test LOC**. The raw sum was 1,865 src; 62 lines were removed as double counts (see Dedup notes). Negative test figures mean the tests grow. Most of the savings come from four places: unreachable settings-editor branches and exports, per-method boilerplate in `profiles/resolve.ts` and `config/store.ts`, repeated lock-and-mutate blocks across `run/*` factories, and dead fallbacks in `tools/render*.ts` for fields the schema already requires. Two finders ran their whole batch in a scratch mirror with tsc, oxlint, oxfmt, effect-tsgo and the full 1,273-test suite all passing. The 11 tools-render findings together measured net −128 lines. Twenty-one of the 22 settings-workspace findings, applied cumulatively, measured −407 src and −12 test lines (about 388 of those inside that unit). I spot-checked the 8 largest entries against HEAD `1a866fa`: sub-settings-rest-1, sub-config-profiles-1, sub-settings-workspace-1, sub-config-profiles-2, sub-config-profiles-3, sub-settings-rest-11+sub-settings-workspace-4, sub-run-rest-1 and sub-tools-exec-ui-1. All claims and estimates held, and none were demoted. Two findings need a new export from `pi-cosmic-ui` first (sub-settings-rest-12 and sub-settings-workspace-22).

| Category             | Entries |   Src LOC | Test LOC |
| -------------------- | ------: | --------: | -------: |
| duplication          |      40 |       492 |       −3 |
| dead-code            |      18 |       407 |      112 |
| verbose-code         |      17 |       308 |        0 |
| indirection          |      11 |       208 |       −2 |
| redundant-validation |      12 |       171 |        0 |
| boilerplate          |       8 |       163 |        0 |
| over-generalization  |       3 |        36 |        7 |
| shared-helper-reuse  |       2 |        18 |        0 |
| **Total**            | **111** | **1,803** |  **114** |

| Area                                                                                              | Src LOC | Test LOC |
| ------------------------------------------------------------------------------------------------- | ------: | -------: |
| settings/ (workspace editor 340/10; dashboard, set picker, catalog, controllers 363/66)           |     703 |       76 |
| run/, application/, layer.ts, domain/ (lifecycle core 225/0; events, proxy, claims, wiring 206/4) |     431 |        4 |
| config/ and profiles/                                                                             |     362 |       34 |
| tools/ and ui/ (ui 125/0; tools 182/0)                                                            |     307 |        0 |

**Dedup notes.** Each merge is counted once:

- sub-settings-rest-3 and sub-run-rest-4 describe the same receipt-fallback removal. Counted at 22, the smaller of their 24 and 22.
- sub-run-core-5 and sub-run-rest-3 describe the same warning-notice helper. Counted at 20, core-5's figure for the control, settlement and assignment sites. Rest-3's events.ts sites overlap sub-run-rest-1 and are not counted again.
- sub-config-profiles-15 and sub-run-rest-11 are the same `SubagentLayerOptions extends SubagentProfileLayerOptions` change. Counted at 15, config-15's more complete variant (run-rest-11 gives 10).
- sub-settings-rest-11 and sub-settings-workspace-4 share the dead `editorClosed` branches. Counted at 40: rest-11's 24 plus workspace-4's 16 lines in profile-workspace.ts. Workspace-4's 7 dashboard lines are already inside rest-11's 24.
- sub-settings-rest-4 and sub-settings-workspace-14 cover disjoint sites of the same `resolvedSet` change. Counted at 27 (16 + 11).
- sub-settings-rest-15 drops from 14 to 9, because its `inheritProjectDraft` wrapper step (−5) is subsumed by sub-settings-workspace-1, which deletes that function.

Paths below are relative to `packages/pi-subagents/` unless another package is named. The format is **Src / Test** LOC · risk · effort.

### settings/: workspace editor and route editor (340 src / 10 test)

- **sub-settings-workspace-1: Delete the unreachable add/disable/reset branches of applyProfileWorkspaceDraftAction.** **63 / 6** · none · S
  - `src/settings/ui/profile-workspace-actions.ts:1-25,92-164`; `src/settings/profile-workspace-save.ts:3-11,20-59`; `src/settings/profile-route-editor.ts:166-175`; `tests/profile-route-editor.test.ts:18-23,253-254,265-268`
  - Type the action as `Exclude<ProfileWorkspaceDraftAction, "add" | "reset">` and drop `"disable"`. Keep only clone, move and remove. Remove the 4 dead inputs, 7 imports and the `hasOwnProfileRouteDeclaration` argument, then delete `resetGlobalDraft` and `inheritProjectDraft`. Verifier adjustment: rewrite test lines 253-254 as literal-draft `declaredRouteForDraft` assertions instead of deleting them.
  - Why it holds: `performDraftAction` returns for add and reset before the call, and nothing produces `"disable"` (spot-checked).
- **sub-settings-rest-11 + sub-settings-workspace-4: Shrink ProfileWorkspaceCloseResult to `false | { action: "save-session" }`, delete dead editorClosed branches and preferredScope, and inline the single-use input handlers.** **40 / 0** · none · S
  - `src/settings/profile-workspace.ts:42-51,214-224`; `src/settings/profile-dashboard-component.ts:164-183,371-396`; `src/settings/profile-set-picker.ts:35`
  - `saveSession` becomes `close({ action: "save-session" })`. `editorClosed` keeps only the false and save-session arms. Drop `preferredScope` from the save-session `ProfileSetPickerAction`, and fold `handleBlocked` and `handleChildNavigation` into `handleInput`. Update the single call at `tests/profile-dashboard.test.ts:209`.
  - Why it holds: the editor only ever calls `close(false)` or save-session (spot-checked), `preferredScope` is never read, and input order is unchanged.
- **sub-settings-workspace-3: Collapse profileWorkspaceConfirmation to its only live case, remove.** **37 / 1** · none · S
  - `src/settings/ui/profile-workspace-actions.ts:166-216`; `src/settings/profile-workspace.ts:391-406`; `src/settings/ui/profile-workspace-render.ts:34-38,418-431`; `tests/profile-workspace-ui.test.ts:338-341`
  - Take only the remove inputs. Drop the action argument, the `preview` field, its render spread and the fixture's preview line.
  - Why it holds: reset renders inline, so the function is only called with remove, and the remove copy stays byte-identical.
- **sub-settings-workspace-6: Generate RUN_WITH_CHOICES from host × runtime instead of a 46-line literal.** **36 / 0** · none · S
  - `src/settings/ui/profile-workspace-model.ts:272-317`
  - Use a `flatMap` over `["local","herdr"] × ["pi","claude","codex"]` that builds value, label (`runWithLabel`), a templated description, host and runtime. Apply after workspace-7.
  - Why it holds: a scripted comparison produced byte-identical JSON, key order included. The cost is that the UI copy can no longer be grepped verbatim.
- **sub-settings-workspace-2: Remove the unused description/value/label threading and the always-equal optimisticDraft parameter.** **25 / 0** · none · S
  - `src/settings/profile-workspace-save.ts:44,68-79,95-96,152-185`; `src/settings/profile-workspace-pickers.ts:72-88,146-151,184-193`; `src/settings/profile-workspace-state.ts:295-300`; `src/settings/ui/profile-workspace-actions.ts:83-90,118-143`; `src/settings/ui/profile-workspace-selectors.ts:55-56,114-120`
  - Change the signature to `persist(next, preferredCandidateIndex?, successNotice?, restore?)`. Drop the description parameters, and let the field selector's `select(update)` and `cancel()` take no extra arguments. Always merge `priorNotices`.
  - Why it holds: nothing reads these values, and every caller passes `optimisticDraft === next`.
- **sub-settings-workspace-17: Delete the dead exports profileRouteDraftSummary, routeOptionCountLabel, profileDescription and ProfileWorkspaceKeys.** **23 / 0** · none · S
  - `src/settings/ui/profile-workspace-model.ts:62-63,126-139,153-154`; `src/settings/ui/profile-workspace-keys.ts:50`
  - Why it holds: a workspace-wide grep finds no importers.
- **sub-settings-workspace-10: Remove the profilePaneRows pass-through.** **18 / 0** · none · S
  - `src/settings/ui/profile-style.ts:2,16-27`; `src/settings/ui/profile-set-picker-render.ts:18-23,308-317`; `src/settings/ui/profile-workspace-render.ts:30,452-462`
  - Call `framedWideRows(frame, {...})` directly.
  - Why it holds: `listDetailFrame` is pure, and both callers already hold a frame for the same pane.
- **sub-settings-workspace-12: Factor out the repeated selector host plumbing, open/cancel boilerplate and conditional spreads.** **18 / 0** · none · M
  - `src/settings/profile-workspace-pickers.ts:48-101,171-206,216-244`; `src/settings/profile-workspace.ts:95-122`; `src/settings/ui/profile-workspace-selectors.ts:88-124,179-213`
  - Add protected `selectorHost()`, `showSelectPage()` and `closeSelectPage()`. Pass `notice` and `initialQuery` directly and build `SearchableSelectPage` inline.
  - Why it holds: `SearchableSelectPage` treats `""` and undefined the same way. This overlaps workspace-2 in pickers.ts, so apply the two together.
- **sub-settings-workspace-20: Table-drive the candidate menu choices and drop the redundant `destructive` flag.** **16 / 0** · none · S
  - `src/settings/ui/profile-workspace-actions.ts:27-81`; `src/settings/ui/profile-workspace-selectors.ts:132,157-160`; `src/settings/profile-workspace.ts:109-113`
  - Filter a const `ACTION_CHOICES` table through an `available` map (`satisfies Record<CandidateMenuAction, boolean>`), and arm the confirmation on `action === "remove"`. Apply after workspace-1.
  - Why it holds: only remove was destructive, and reset never appears in the menu.
- **sub-settings-workspace-5: Drop dead render-state and options fields and the test-only fallbacks.** **14 / 5** · none · S
  - `src/settings/ui/profile-workspace-render.ts:39-64,85-104,368-371`; `src/settings/profile-workspace.ts:56,87,407-435`; `src/settings/profile-dashboard.ts:267`; `tests/profile-workspace-ui.test.ts:115-133,148-150,335-349`; one line each in `tests/profile-workspace.test.ts:92`, `tests/profile-workspace-navigation.test.ts:69` and `tests/profile-dashboard.test.ts:330`
  - Delete `scope`, `projectTrusted`, `backLabel` and `advancedExpanded`. Make `expandedCandidates` and the theme argument of `workspaceCandidateSummary` required.
  - Why it holds: the renderer never reads these fields, and production always passes `expandedCandidates`.
- **sub-settings-workspace-19: Tighten the profile-workspace-model helpers (fast-mode availability, default effort, dead guards).** **11 / 0** · none · S
  - `src/settings/ui/profile-workspace-model.ts:80-90,101-109,168-218,220-265,325-349`; `src/settings/ui/profile-workspace-rows.ts:28`
  - Add private `candidateFastModeAvailable` and `profileDefaultEffort` helpers, make the Advanced row unconditional, and replace the `position` parameter with `candidateIndex = 0`.
  - Why it holds: 353,808 old-versus-new comparisons showed zero differences.
- **sub-settings-workspace-21: Remove redundant input-handling guards in ProfileWorkspaceComponent.** **11 / 0** · none · S
  - `src/settings/profile-workspace.ts:285-291,317-341,369-372`
  - Pass `matchesKeybinding` directly, return early on any non-Action resolution in help, and delete the no-op switch cases.
  - Why it holds: `configuredMatch` treats an undefined matcher and a false-returning one the same way.
- **sub-settings-rest-15: Tighten the profile route editor.** **9 / 0** · none · S
  - `src/settings/profile-route-editor.ts:109-124,226-235`
  - Delete the redundant range check and loop with `entries()`. If workspace-1 is not applied, also rename `globalReferenceDraft` to the exported `inheritProjectDraft` for the finder's full 14.
  - Why it holds: out-of-range indices already return the same draft reference.
- **sub-settings-workspace-18: Replace the targetProfileRouteDraft pass-through with loadProfileRouteDraft.** **8 / −2** · none · S
  - `src/settings/ui/profile-workspace-model.ts:120-124,145`; `src/settings/profile-workspace-state.ts:17-20,147,172`; `src/settings/ui/profile-workspace-render.ts:26,115`; `tests/profile-workspace-ui.test.ts:9-13`
  - Why it holds: it is a pure alias. The test import grows by 2 lines.
- **sub-settings-workspace-7: Use one runtimeLabel and runWithLabel instead of three copies.** **6 / 0** · none · S
  - `src/settings/profile-route-editor.ts:259-260`; `src/settings/ui/profile-workspace-model.ts:114-118`; `src/settings/ui/model-picker.ts:175-176,199-206`
  - Export `runtimeLabel`. `runWithLabel` takes `Pick<ProfileCandidate, "host" | "runtime">`, and the model-picker subtitle becomes `runWithLabel(context)`.
  - Why it holds: the strings are identical.
- **sub-settings-workspace-13: Reuse qualifiedProfileSetLabel and shortTargetLabel for target labels.** **5 / 0** · none · S
  - `src/settings/profile-workspace-pickers.ts:42-46,179`; `src/settings/ui/profile-workspace-selectors.ts:33-41`; `src/settings/ui/profile-workspace-render.ts:79-82,372-375`; `src/settings/ui/profile-set-picker-model.ts:215-216`
  - Why it holds: the strings are identical.

### settings/: dashboard, set picker, model catalog and controllers (363 src / 66 test)

- **sub-settings-rest-1: Delete the unused ProfileTargetPickerComponent module and its test.** **58 / 66** · none · S
  - `src/settings/profile-target-picker.ts:1-58`; `tests/profile-target-picker.test.ts:1-66`
  - Delete both files. `qualifiedProfileSetLabel` and `profileSetPickerEntries` keep their other callers.
  - Why it holds: grep finds it only in its own module and test (spot-checked).
- **sub-settings-rest-5: Simplify ProfileSetPickerComponent's motion handling, no-op switch cases and render-state assembly.** **36 / 0** · none · S
  - `src/settings/profile-set-picker.ts:195-202,280-290,304-310,316-327,352-360,432-435,458-481`
  - Route both list and menu motion through `nextListMotionIndex`, and delete `move()` and the empty cases. Build the render state as one literal with `...(this.message && { message })`.
  - Why it holds: with `wrapSingleRow=false` the helper computes the same clamp, and the message still clears only on movement. The render-state block also contains workspace-15's `projectTrusted` line.
- **sub-settings-rest-2: Consolidate the Pi model-choice lookups and drop a dead computation and a duplicate lookup.** **28 / 0** · none · M
  - `src/settings/profile-model-catalog.ts:202-210,284-324,333-355,378-395`; `src/settings/profile-dashboard.ts:55-80,298-299`
  - Add `findPiModel`, `findModelChoice` and `choiceFor`, and delete `selectedModelEfforts`. Replace `fastModeAvailable` in `unavailableCurrentChoice` with `false`. Move `supportedPiEfforts` into the catalog and delete `projectedParentModel`.
  - Why it holds: predicates and first-match semantics are unchanged, and the removed fast-mode expression is provably false on that path.
- **sub-settings-rest-4 + sub-settings-workspace-14: Pass `inspection.project` straight to resolveNamedProfileSet through one shared resolvedSet.** **27 / 0** · none · S
  - `src/settings/profile-route-editor.ts:89-101`; `src/settings/profile-set-actions.ts:92-95,134-137`; `src/settings/ui/profile-set-picker-model.ts:56-70,76,87`
  - Export `resolvedSet` (and `decodedAt`) from profile-route-editor.ts, use them in the set actions and the picker model, and delete the picker's local `resolvedSet` and `decodedForScope`.
  - Why it holds: `project` is `?: … | undefined` and is read only for project scope.
- **sub-settings-rest-10: Trim profile-dashboard host boilerplate.** **24 / 0** · none · S
  - `src/settings/profile-dashboard.ts:44-53,195,264-308,343-347`; `src/settings/profile-write-context.ts:1-3,20-25`; `src/settings/profile-model-catalog.ts:242-247`
  - Narrow the position type with `Pick`, pass `parentSelector`, `signal` and `parentModel` directly, and use one `release` closure. Check the error with `Predicate.isTagged(error, "SessionProfileConflictError")` and delete `isSessionProfileConflict`. Call `listNativeModels(runtime, input.signal)`.
  - Why it holds: the parameters accept `| undefined`, and `isTagged` covers both the class instance and the structural case.
- **sub-settings-rest-3 + sub-run-rest-4: Make the \*WithReceipt actions required and remove the receipt-less fallbacks.** **22 / 0** · low · M
  - `src/settings/controller.ts:69-78,90-91`; `src/settings/profile-dashboard.ts:187-191,215-233`; `src/settings/profile-set-actions.ts:117-124`; `src/application/register.ts:398,430-437`
  - Make the four receipt members required. Delete `patchProfile`, `patchSessionProfile` and `replaceSessionProfiles` from `FleetManagerActions` and register.ts. Collapse the ternaries, the undo-unavailable guard and `snapshot ? {...} : next`.
  - Budget a real rework of `tests/profile-settings-controller.test.ts`: about 20 mocks and assertions move to receipt stubs that must return valid documents or snapshots.
  - Why it holds: register.ts is the only producer and always supplies the receipt methods. The fallbacks also skipped `withCurrentActivation`.
- **sub-settings-rest-7: Reuse the store's stableJson and legacy candidate migration in ProfileEditVisit.** **19 / 0** · none · S
  - `src/settings/profile-edit-visit.ts:26-55`; `src/config/store.ts:215-226,262-278`
  - Move `stableJson`, `legacyCandidateJson` and `migrateLegacyRouteJson` (with `isRecord` and its SAFETY comment) into `config/profile-restore.ts`, and build `restoreKey` from them.
  - Why it holds: for JSON input the output strings are identical, since `isJsonObject` and `isRecord` both exclude arrays and null in effect rc.112. Coordinate with config-profiles-8, which rewrites `legacyCandidateJson`.
- **sub-settings-workspace-11: Deduplicate the set-picker render helpers (windowStart, message tone, compact IIFE).** **18 / 0** · none · S
  - `src/settings/ui/profile-set-picker-render.ts:46-47,80,107-118,152,265-302`
  - Use `listWindowStart` from pi-cosmic-ui and add a `messageRows` helper.
  - Why it holds: both callers already pass `Math.max(1, …)`, and the tone mapping is the same for all three message kinds.
- **sub-settings-workspace-9: Flatten the parent-choice IIFE and the single-use compactSelectItem in model-picker.** **18 / 0** · low · S
  - `src/settings/ui/model-picker.ts:45-48,58-96,140-148`
  - Why it holds: the JSON output is identical. The only difference is an explicit `supportedEfforts: undefined` key when there is no parent, and nothing checks for key presence.
- **sub-settings-rest-6: Deduplicate the two bounded nesting-limit prompts and the scope normalization.** **17 / 0** · none · S
  - `src/settings/controller.ts:178-184,199-207,239-279`
  - Add `promptLimit(ctx, label, current, min, max)` and resolve the scope with `.find` over an `as const` list.
  - Why it holds: prompt titles, defaults, error text and the parse rule stay byte-identical.
- **sub-settings-rest-8: Remove the test-only AbortSignal from ProfileModelCatalog.refresh.** **14 / 0** · none · S
  - `src/settings/profile-model-catalog.ts:120-166`; `tests/profile-model-catalog.test.ts:122-131`
  - Drop the parameter, the early abort check and `raceFirst`, and add a `stale()` helper. The test instead uses a registry that resolves `{ aborted: true }`.
  - Why it holds: the only caller passes no signal and cancels through fiber interruption, as ARCHITECTURE.md documents.
- **sub-settings-rest-14: Remove the test-only initialScope and the never-supplied section options.** **13 / 0** · none · M
  - `src/settings/profile-set-picker.ts:44,156,335-338`; `src/settings/ui/profile-set-picker-model.ts:193-210`; `src/settings/profile-set-save-form.ts:16-18,33,70`; `src/settings/ui/profile-set-save-form-render.ts:18`
  - Verifiers adjusted this into two steps. Step 1 cleans up the save form with no test churn. Step 2 removes the picker's `initialScope` and `preferred` block, which means rewriting the `makePicker` tests (all 17 constructions default to `'global'`), so expect test LOC to grow.
  - Why it holds: production never supplies these options.
- **sub-settings-rest-9: Map proxy run cards directly and share the refresh-slot cleanup.** **12 / 0** · low · S
  - `src/settings/proxy-controller.ts:17-68,113-120`
  - Why it holds: every target field is `?: T | undefined`, and absent fields now become explicit undefined keys that nothing enumerates. No tests cover this module.
- **sub-settings-rest-12: Add one shared host-keybinding adapter.** **12 / 0** · none · S · cross-package
  - `src/settings/controller.ts:126-134`; `src/settings/profile-dashboard.ts:274-282`; `src/settings/proxy-controller.ts:152-156`; `packages/pi-cosmic-ui/src/manager/key-labels.ts:37-41`
  - Export `hostKeybindings(keybindings)` from pi-cosmic-ui and spread it at the three sites. pi-mcp (2 sites), pi-background-task and pi-cosmic-ui host-activity would save about 25 more lines, which are not counted here.
  - Why it holds: labels and matching are identical. The proxy site gains a harmless `isFunction` guard.
- **sub-settings-workspace-8: Delete the ignored description override in createProfileModelChoices.** **12 / 0** · none · S
  - `src/settings/ui/model-picker.ts:97-120`
  - Why it holds: pi-cosmic-ui `modelItem` reads `description` only when `label` is set, and it is never set. See the latent-UX note below.
- **sub-settings-workspace-16: Build the empty scope notes with one helper.** **11 / 0** · none · S
  - `src/settings/ui/profile-set-picker-model.ts:147-191`
  - Add `emptyScopeNote(scope)`. Apply after workspace-15.
  - Why it holds: a script showed identical entries.
- **sub-settings-workspace-15: Remove never-read picker entry and render-state fields.** **10 / 0** · none · S
  - `src/settings/ui/profile-set-picker-model.ts:31-32,51,111-112,160-186`; `src/settings/ui/profile-set-picker-render.ts:30`; `src/settings/profile-set-picker.ts:463`; `tests/profile-set-picker.test.ts:297`
  - Delete `profileCount`, `unavailable` and `invalidProfileCount`, plus the render-state `projectTrusted`. Optionally keep coverage by asserting exactly one invalid preview entry.
  - Why it holds: grep finds no readers.
- **sub-settings-rest-13: Let finish() take a post-refresh callback in runProfileSetAction.** **6 / 0** · none · S
  - `src/settings/profile-set-actions.ts:46-52,120-129,179-190`
  - This saves 6 only if `finish` drops its explicit `Promise<void>` annotation; with it, about 3.
  - Why it holds: the guard, refresh, guard, callback, notify order is unchanged.
- **sub-settings-workspace-22: Share boundedMiddle with pi-cosmic-ui instead of keeping an exact local clone.** **6 / 0** · none · S · cross-package
  - `src/settings/ui/model-picker.ts:38-43`; `packages/pi-cosmic-ui/src/manager/model-picker.ts:40-45`
  - Add one export to the existing subpath.
  - Why it holds: the bodies are identical. This one was not compiled in scratch.

### run/: lifecycle core (launch, resume, control, settlement, service, internal) (225 src / 0 test)

- **sub-run-core-2: Derive the settle, failRun, submitPrompt, retain and initialize dependency types from their producers.** **30 / 0** · none · S
  - `src/run/control.ts:38-48,60-64`; `src/run/launch.ts:123-136`; `src/run/resume.ts:50-74`; `src/run/service.ts:568-569`; `src/run/settlement.ts:121`; `src/run/assignment.ts:37`; `src/run/process-lifecycle.ts:73`
  - Export `RunSettlement`, `RunAssignment` and `RunProcessInitializer` as `ReturnType<typeof make…>` and declare the dependencies as `RunSettlement["settle"]` and so on. Replace control's `beginAssignmentBackend` with `submitPrompt(record, normalized, "resume", token)`.
  - Why it holds: the change is type-only apart from inlining a lambda that forwarded a constant, and it adds no import cycle.
- **sub-run-core-3: Have completeRunInitialization return the pending settlement, and share one startup-state commit.** **20 / 0** · none · S
  - `src/run/internal.ts:129-134`; `src/run/launch.ts:624-645,688-693`; `src/run/resume.ts:367-381,428-435,453-458`
  - Add `commitRunInitialization(record, state)` for launch and resume.
  - Why it holds: the same writes happen under the same lock, and only launch and resume write `view.model`.
- **sub-run-core-5 + sub-run-rest-3: Use one helper for "set warning slot, project it, append a warning notice".** **20 / 0** · none · M
  - `src/run/internal.ts:120-127` or `src/run/warnings.ts:13-23`; `src/run/control.ts:89-110`; `src/run/settlement.ts:319-338`; `src/run/assignment.ts:108-119`; also `src/run/events.ts:134-143,338-360,412-425` and `src/run/record-cleanup.ts:134-153`
  - Add `recordRunWarning(record, sessionEvents, source, warning, now, notice = warning)` and fold `rejectReportLocked` into `rejectReportAndPublishLocked`. The events `warning` case passes `Extension error: …` as the notice.
  - Why it holds: sanitize, slot update, projection and notice order are unchanged, and there is no import cycle.
- **sub-run-core-1: Delete the dead launch.startSessionOwned and the two dependencies only it uses.** **18 / 0** · none · S
  - `src/run/launch.ts:26,97,108,150,158,720-728,735-736`; `src/run/service.ts:720,728`
  - Why it holds: nothing calls it. The public `startSessionOwned` is the service's `startWorkspaceSessionOwned`.
- **sub-run-core-4: Share one assignment-closing block between settle and commitRetainedReportLocked.** **18 / 0** · none · M
  - `src/run/settlement.ts:74-112,241-272,357-378`
  - Add `closeAssignmentLocked(record, outcome?)`.
  - Why it holds: the same synchronous mutations run under the lock, `completionGeneration` matches even at full capacity, and a stopped run still records no completion.
- **sub-run-core-6: Inline the single-use, seven-argument buildRunRecord.** **15 / 0** · low · S
  - `src/run/launch.ts:410-452,478-494`
  - Verifier adjustment: keep `const assignmentAttemptToken = allocateAssignmentAttemptToken()` before `writerPoolForAdmissionLocked` so the allocation order stays the same. The recount was about 22.
  - Why it holds: the record literal stays inside the admission-lock transaction.
- **sub-run-core-7: Replace the eviction reservation's verbatim copy of validateCapacityLocked.** **13 / 0** · none · S
  - `src/run/launch.ts:533-549` (helper at 296-318)
  - Call `validateCapacityLocked(undefined, predecessor)`.
  - Why it holds: the arguments, check order and errors are the same.
- **sub-run-core-8: Import requireCapability directly instead of injecting it through the service.** **10 / 0** · none · S
  - `src/run/service.ts:200-233,566,759`; `src/run/control.ts:33-36,72`; `src/run/resume.ts:44-47,95`
  - Move `requireCapability` and its message helper to internal.ts.
  - Why it holds: the functions are pure and no test substitutes them.
- **sub-run-core-9: Add a local helper for the repeated parent-notice view update in control.ts.** **10 / 0** · none · S
  - `src/run/control.ts:132-141,383-392`
  - Leave `resume.ts:405-413` out, because it does not set `lastActivityAt`.
- **sub-run-core-19: Add an invalidRequest(code, message) factory next to processError.** **8 / 0** · none · S
  - `src/run/errors.ts:44-48`; `src/run/launch.ts:56-71`; `src/run/control.ts:528-531`; `src/run/resume.ts:223-229`; `src/run/workspace-control.ts:77-78`
  - All of the saving is formatting at short-message sites. It has a soft dependency on core-18.
- **sub-run-core-10: Share the next-assignment rollover between retained send and resume.** **7 / 0** · none · S
  - `src/run/control.ts:183-205`; `src/run/resume.ts:284,295-316`
  - Add `beginNextAssignmentLocked(record, token, now, viewPatch)` in assignment.ts. Keep each caller's patch separate, because resume keeps `finalText`.
- **sub-run-core-11: Attach the eviction-failure compensation once instead of twice.** **7 / 0** · none · S
  - `src/run/launch.ts:593-607`
  - Put a single `Effect.onError` around reclaim and admit.
  - Why it holds: the compensation still runs exactly once, and both steps stay uninterruptible.
- **sub-run-core-13: Share the pause commit between interrupt and pauseFromEvent.** **7 / 0** · none · S
  - `src/run/control.ts:504-516`; `src/run/settlement.ts:201-212`
  - Add `commitRunPauseLocked(record, now)`.
  - Why it holds: the guard already establishes that the epochs are equal.
- **sub-run-core-14: Use one predicate for the ancestor-notification scan and its locked recheck.** **7 / 0** · none · S
  - `src/run/service.ts:411-418,429-436`
- **sub-run-core-15: Create the initial projection with frozenProjection(0) and drop the unreachable mode default.** **7 / 0** · none · S
  - `src/run/service.ts:252-258,272-274,323-330`
  - Why it holds: an empty projection is identical, and `writerWorkspaceMode` is always resolved upstream.
- **sub-run-core-12: Build the running view once in runStartedFromBackend.** **6 / 0** · none · S
  - `src/run/settlement.ts:576-596`
- **sub-run-core-16: Inline the one-line failPendingResponses wrapper.** **6 / 0** · none · S
  - `src/run/settlement.ts:220-221,300-303,664`; `src/run/control.ts:58,84,611`; `src/run/service.ts:579,895-898`
  - Call `record.process?.cancelPending(error)` directly.
- **sub-run-core-20: Spread `retry` and `observations` into the service literal.** **6 / 0** · low · S
  - `src/run/service.ts:860-873`
  - Verifier adjustment: spread only `...retry, ...observations` and keep send, reply, interrupt, rename and the subtree-aware `stop` explicit. Spreading `controls` would depend on literal ordering.
  - Why it holds: the only change is an extra, pure `redactCompletionReport` key, and nothing enumerates the service's keys.
- **sub-run-core-17: Merge the two reply-rollback lock blocks in control.reply.** **5 / 0** · none · S
  - `src/run/control.ts:405-432`
- **sub-run-core-18: Share the writer-cwd canonicalization error mapping between launch and resume.** **5 / 0** · none · S
  - `src/run/launch.ts:186-199`; `src/run/resume.ts:176-186`
  - Add `canonicalizeWriterCwd` to admission.ts.
  - Why it holds: the code and message are the same.

### run/: events, proxy, claims, retry, cleanup; application/, layer.ts, domain/ (206 src / 4 test)

- **sub-run-rest-1: Fold the repeated clock, mutateView, asVoid wrapper in events.ts into one helper and flatten the tool_started bookkeeping.** **40 / 0** · none · M
  - `src/run/events.ts:91,108-173,175-202,222-437`
  - Add `mutateAt(record, epoch, update(view, now))` and apply `asVoid` once in the exported handler. Merge the `handleContact` branches, inline `handleInactiveEvent` and `protocolError`, and wrap `handleToolStarted` in `Effect.suspend`. A scratch draft went from 438 to 393 lines.
  - Why it holds: the mutateView calls, epochs and clock-before-lock order are the same, and path observation stays lazy (spot-checked). Apply together with core-5/rest-3 and rest-10, which touch the same file.
- **sub-run-rest-2: Add one reject helper for the five repeated error responses in proxy-execution.ts.** **22 / 0** · none · S
  - `src/run/proxy-execution.ts:43-115`
  - A scratch draft went from 119 to 95 lines.
  - Why it holds: payloads and order are the same, and the pipe already ends in `Effect.ignore`.
- **sub-run-rest-5: Share a changeClaims skeleton and claim-equality helpers between grant and revoke in write-claim-control.ts.** **15 / 0** · none · S
  - `src/run/write-claim-control.ts:83-177`
  - Add `changeClaims`, `sameClaim` and `includesClaim`.
  - Why it holds: validation order and error codes are unchanged, and peer notices still go out after the lock.
- **sub-config-profiles-15 + sub-run-rest-11: Let SubagentLayerOptions extend SubagentProfileLayerOptions.** **15 / 0** · none · S
  - `src/layer.ts:24,27,50-74`; `src/profiles/service.ts:56-64,141-145`; `src/application/register.ts:157-159`
  - Either rename the service options to `sessionBaseConfig` and `publishSessionBaseConfig` (config-15, also drops a redundant `if`, 15 lines, touches `tests/profiles.test.ts:954`) or have register.ts supply `baseConfig` and `publishBaseConfig` directly (run-rest-11, 10 lines).
  - Why it holds: the same values reach the profile layer under the same keys.
- **sub-run-rest-6: Merge exhaustRetryClaim and blockRetryClaim in retry.ts, and reuse the service's requireRecord.** **14 / 0** · none · S
  - `src/run/retry.ts:70-75,183-225`; `src/run/service.ts:198-199,499-503,522-527`
  - Add `finishRetryClaim(id, token, outcome)`.
  - Why it holds: the not-found text is identical, and the call is still evaluated inside the locked gen.
- **sub-run-rest-9: Dedupe the quarantine tails and the reclaimed commit in record-cleanup.ts, and build the writer preparation in service.ts.** **14 / −3** · none · S
  - `src/run/record-cleanup.ts:6,11,18,28-30,41-45,74,278-293,321-323`; `src/run/service.ts:529-536`; `tests/run/writer-preparation.test.ts:114-130`
  - The test must share its custom `withLock`, which adds 2 to 4 lines.
  - Why it holds: the same quarantine, log text and state order.
- **sub-run-rest-8: Derive SUBAGENT_TOOL_NAMES from SUBAGENT_TOOL_NAME.** **12 / 0** · none · S
  - `src/run/tool-policy.ts:21-33`
  - Verifier adjustment: use `Object.freeze(Object.values(SUBAGENT_TOOL_NAME))` and change the three `SUBAGENT_TOOL_NAMES[2]` uses in `tests/host-child.test.ts` (315, 416, 495) to `SUBAGENT_TOOL_NAME.list`. Without that, typecheck fails under `noUncheckedIndexedAccess`. Test LOC stays neutral.
- **sub-run-rest-7: Reuse one attachment check in writer-preparation.ts.** **11 / 0** · none · S
  - `src/run/writer-preparation.ts:77-91,149-157`
  - Why it holds: `Effect.sync` re-evaluates on each run, and restore/mask placement is unchanged.
- **sub-run-rest-12: Deduplicate asObject/asRecord and stringField between claims-observation.ts and session-events.ts.** **11 / 0** · none · S
  - `src/run/claims-observation.ts:14-23`; `src/run/session-events.ts:1-3,26-35`
  - Why it holds: the two copies are semantically identical, and the import adds no cycle.
- **sub-run-rest-10: Have observeFileWrite return the paths directly and check names against a Set.** **10 / 7** · none · S
  - `src/run/claims-observation.ts:9-12,57-70`; `src/run/events.ts:288-295`; `tests/run/claims-observation.test.ts:10-32`
  - Why it holds: only tests read `toolName`, and the empty-array versus undefined distinction is kept.
- **sub-run-rest-13: Drop the hand-rolled Option unwrapping and the redundant inner try/catch in profile-reload-handoff.ts.** **7 / 0** · none · S
  - `src/application/profile-reload-handoff.ts:46-57,99-101`
  - Hoist `Schema.decodeUnknownOption(…, { onExcessProperty: "error" })`.
  - Why it holds: the outer catch already deletes the slot and returns undefined.
- **sub-run-rest-14: Remove the duplicated replaced-session check in register.ts and build CapturedActivation directly.** **7 / 0** · none · S
  - `src/application/register.ts:349-367,472-484`
  - Why it holds: `withCurrentActivation` repeats the same check with the same error.
- **sub-run-rest-15: Derive SubagentCapability from PI_SUBAGENT_CAPABILITIES.** **7 / 0** · none · S
  - `src/run/model.ts:32-49`
  - Why it holds: it is a type-only change with the same seven members.
- **sub-run-rest-17: Remove the unreachable post-loop empty-claims failure.** **6 / 0** · none · S
  - `src/domain/write-claims.ts:96-101`
  - Why it holds: the first input either fails or pushes a claim.
- **sub-run-rest-16: Use Effect.Success for RunNotificationDelivery.** **5 / 0** · none · S
  - `src/run/notification-delivery.ts:271-278`
  - This uses the 3-line form oxfmt produces.
- **sub-run-rest-18: Replace the manual reverse search in session-events.ts with findLastIndex.** **5 / 0** · none · S
  - `src/run/session-events.ts:155-162`
  - Why it holds: the lib is ES2023, and it returns the same −1.
- **sub-run-rest-19: Drop the always-inverse allowMissing parameter and a redundant re-read.** **5 / 0** · none · S
  - `src/run/completion-observations.ts:128,145-160,221-233,301,328`

### config/ and profiles/ (362 src / 34 test)

- **sub-config-profiles-1: Collapse resolve.ts's single-use candidate helpers into closures inside resolveCandidate.** **70 / 0** · none · M
  - `src/profiles/resolve.ts:76-258,286-292`
  - Inline `skip`, `unsupportedPiEffort`, `softEffort`, `baseAttempt` and `piModelTail` as local `accept` and `resolvePiModel` closures, and keep the PARENT/LOCAL skip tables. The attempt type omits `reason`, `routeSource` and `skippedBefore`, which are pushed in that order. A draft came to about 100 to 104 lines against the current 183.
  - Why it holds: skip codes, messages, key order and check order are unchanged, and the overwritten `reason` was never observable (spot-checked).
- **sub-config-profiles-2: Collapse the per-method boilerplate in the SubagentConfigStore contract and layer wiring.** **55 / 0** · none · M
  - `src/config/store.ts:113-175,714-816`
  - Add `type ConfigPatch<Patch, A = void>`, a curried `patchWithReceipt(apply, missingIsNoop)` and a `patchVoid` wrapper, then wire each method on one line. The draft takes the contract from 63 to 29 lines and the wiring from 103 to about 75.
  - Why it holds: each method keeps its apply function and no-op predicate, and the types are structurally identical, so the stubs still compile (spot-checked).
- **sub-config-profiles-8: Simplify the legacy migration gate and helpers, and share the config-version predicates.** **32 / 0** · low · M
  - `src/config/store.ts:262-269,280-338,359-361`; `src/config/profile-restore.ts:11`; `src/config/schema.ts:210-211,387-391`
  - Replace `ensureMigratableLegacy` with `diagnostics.length > 0`. Rewrite `legacyCandidateJson` with a rest destructure and inline `migrateLegacyProfiles`. Export `isSupportedConfigVersion = Schema.is(ConfigVersionSchema)` and use it everywhere.
  - Why it holds: every diagnostic a v4 or v5 document can emit was already fatal, which the verifiers traced, and key order is kept.
- **sub-config-profiles-4: Add one mapProfileIds helper for the full-profile record loops.** **26 / 0** · none · S
  - `src/profiles/model.ts:23-29`; `src/profiles/definitions.ts:90-98`; `src/config/options.ts:88-112`; `src/profiles/session-overrides.ts:206-216,384-397`
  - Verifier adjustment: also rewrite the loop in `resolveNamedProfileLayer` (`options.ts:130-148`), which saves about 7 more lines that are not counted here.
  - Why it holds: every site already iterates `PROFILE_IDS` in canonical order.
- **sub-config-profiles-6: Remove the nextSeed/sessionProfileSeed plumbing and reuse the conflict helper in the profile service.** **25 / 0** · none · S
  - `src/profiles/session-overrides.ts:425-444,460-470,491-496,555-560,579-584`; `src/profiles/service.ts:106-114`
  - Why it holds: `cloneSessionProfileOverrideSeed` copies only the seed fields, so the published seeds are identical.
- **sub-config-profiles-5: Unify SessionProfileOrigin with ResolvedProfileSetSelection and drop both converters.** **24 / 0** · low · S
  - `src/config/options.ts:19-25,199-218`; `src/profiles/session-overrides.ts:30-37,218-232,370-377,395`
  - The only shape change is that `currentProfileSet` leaves out `invalid: false`. Nothing in production reads it, and tests assert only the `invalid: true` case. It overlaps config-11 in `selectedSet` by a couple of lines.
- **sub-config-profiles-7: Trim the redundant validation and double normalization in decodeSessionProfileOverrideSeed.** **22 / 0** · none · S
  - `src/profiles/session-overrides.ts:121-132,247-260,310-368`
  - Hoist the decoder, drop `isFinite` and the post-decode integer check, and replace `decodeOrigin` with an `isValidOrigin` predicate. The length preflight, exact decode and try/catch stay.
  - Why it holds: in rc.112 `isInt` is `isSafeInteger`, so the removed checks were redundant.
- **sub-config-profiles-9: Remove redundant decode bookkeeping in schema.ts and derive the nesting type from its Schema.** **22 / 0** · none · M
  - `src/config/schema.ts:50-58,88-107,432-448,473-477,501-517`
  - Inline the five unused `Profile*Schema` constants, use `Predicate.isString`, drop the two `isFinite` filters, and write `SubagentNestingPolicy = typeof NestingContractSchema.Type`. Keep the typed null-prototype annotation.
- **sub-config-profiles-3: Remove the write-only ResolvedSubagentConfig fields nestingSource, projectTrusted, globalConfigExists and projectConfigExists.** **18 / 24** · none · S
  - `src/config/options.ts:30-32,37,47-48,228-238,246`; `src/config/store.ts:697-698`; `src/profiles/session-overrides.ts:399`; tests in config-store, session-profile-overrides, application, profiles and config, plus three fixtures
  - Keep the `projectTrusted` input, because it gates the project layer.
  - Why it holds: nothing in src reads these fields (spot-checked with grep).
- **sub-config-profiles-10: Merge the three own-data-property readers into one.** **18 / 0** · none · S
  - `src/config/schema.ts:183-208`; `src/profiles/session-overrides.ts:134-150`; `src/config/store.ts:443-525`
  - Export `ownDataProperty` from schema.ts. At array elements check `!p.valid || !p.present`, so holes are still rejected.
  - Why it holds: accessors are still never invoked, and the hostile-input tests at `config-store.test.ts:848-918` still pin that.
- **sub-config-profiles-13: Deduplicate the global and project decode checks in store.ts inspect, and collapse the error factories.** **15 / 0** · none · S
  - `src/config/store.ts:184-213,654-709`
  - Add `decodeDocument(raw, scope, path)` and a single `configError`. Messages stay verbatim, because profile-dashboard compares the conflict text.
- **sub-config-profiles-12: Share the candidate field list and the route-source literal list.** **14 / 0** · none · S
  - `src/profiles/model.ts:188-215`; `src/config/schema.ts:124-132`; `src/profiles/session-overrides.ts:96-107`
  - Export `PROFILE_CANDIDATE_BASE_KEYS` and `PROFILE_ROUTE_SOURCES` as const arrays. `tools/details-schema.ts` could save about 6 more lines, not counted here.
- **sub-config-profiles-11: Deduplicate the default-set selection branches and the invalid-source spellings in options.ts.** **13 / 0** · none · S
  - `src/config/options.ts:114-197,199-218`
  - Add `declaredSelection(scope, decoded)` chained with `??`, use `` `${scope}-invalid` as const ``, and test with `endsWith("-invalid")`.
- **sub-config-profiles-14: Drop the unused `paths` member from the SubagentConfigStore contract.** **8 / 10** · none · S
  - `src/config/store.ts:41-44,114,648-652,775`; `tests/profiles.test.ts:928-932,973-977`
  - Keep a local synchronous helper.

### ui/ (125 src / 0 test)

- **sub-tools-exec-ui-1: Replace three parallel run-state switches with one presentation table.** **39 / 0** · none · S
  - `src/ui/run-state.ts:1-75`
  - Use a `RUN_STATE_PRESENTATION` table that `satisfies Record<SubagentRunState, …>`. Its 3 exports become lookups, and `animatedRunStateGlyph` stays. A draft took the file from 75 to 36 lines.
  - Why it holds: the pi-cosmic-ui glyph helpers are pure constant lookups, and exhaustiveness is kept (spot-checked).
- **sub-tools-exec-ui-7: Move fleet heading and subtitle styling into session-output and remove the unused default path.** **20 / 0** · low · S
  - `src/ui/session-output.ts:26-38,363-389`; `src/ui/fleet.ts:729-750`
  - Replace the two hooks with `detailFocused?: boolean`, and update the ARCHITECTURE.md sentence that records the hooks as a deliberate design.
  - Why it holds: fleet is the only production caller it has ever had.
- **sub-tools-exec-ui-10: Make formatRunRoute take the route object instead of five positional arguments.** **18 / 0** · none · S
  - `src/ui/run-presentation.ts:51-66`; `src/tools/render-start.ts:85-95`; `src/tools/render-management.ts:122-128`; `src/tools/format.ts:324`; `src/boundary/host-activity.ts:99-103`
  - Why it holds: `profile` does not affect the output text.
- **sub-tools-exec-ui-9: Replace formatUsage with aggregateUsage.** **16 / 0** · low · S
  - `src/ui/metrics.ts:31-48`; `src/ui/session-output.ts:265`; `src/tools/format.ts:290`; `src/tools/render-run-rows.ts:54`
  - Why it holds: the two differ only for non-finite usage, which `isValidUsage` and `UsageSchema` rule out.
- **sub-tools-exec-ui-2: Add a fleet listPane helper instead of building the list pane three times.** **13 / 0** · none · S
  - `src/ui/fleet.ts:632-647,760-837`
  - The narrow path uses `.slice(height <= 1 ? 1 : 0)`. Folding in `visibleRows` would make it about 15.
- **sub-tools-exec-ui-3: Simplify the fleet performAction settlement.** **8 / 0** · low · S
  - `src/ui/fleet.ts:273-298`
  - Verifier adjustment: `settle` must assign `this.notice`; the drafted version assigned the parameter to itself. The change adds about 2 microtask ticks before settlement, which no test observes.
- **sub-tools-exec-ui-11: Share the wide `profile → host/runtime · model` route line.** **6 / 0** · none · S
  - `src/ui/activity-panel.ts:219-246`; `src/tools/render-run-rows.ts:34-45`
  - Add `formatRunRouteLine(run, theme?)` to run-presentation.ts.
- **sub-tools-exec-ui-8: Route notice rows and live-field rows through one styled-row helper.** **5 / 0** · none · S
  - `src/ui/session-output.ts:148-152,180-213`
  - Why it holds: the output is byte-identical.

### tools/ (182 src / 0 test)

- **sub-tools-render-3: Remove dead fallbacks for schema-required card fields and the unreachable `undefined` renderer returns.** **28 / 0** · none · S
  - `src/tools/render.ts:55-62,150-156,384-388,490-508,523,594-601,609-638,655,687-694,822-833`; `src/tools/render-management.ts:148,221,282-283,307-312`; `src/tools/render-run-rows.ts:96,129-137,151-155`
  - Why it holds: every guarded field is required by the strict schemas applied through `safeDecode`, and the mirror suite passes.
- **sub-tools-render-1: Drop the unused `skipped` count from compactRunNotices and inline the single-use appendRunHistory.** **19 / 0** · none · S
  - `src/tools/compact-run-notices.ts:25-32,107-115`; `src/tools/compact-summary.ts:428-444,498`
- **sub-tools-exec-ui-4: Forward the unchanged execute arguments with a rest parameter.** **17 / 0** · none · S
  - `src/tools/subagent.ts:105-110,155-163,214-215,252-260,289-297`
  - Write `execute: (_id, input, ...rest) => executeSubagentAction(pi, runtime, input, ...rest)`.
  - Why it holds: a scratch tsc run confirmed the contextual tuple typing.
- **sub-tools-render-5: Collapse the partial and settled wrapper exports in render-start into one component.** **13 / 0** · none · S
  - `src/tools/render-start.ts:201-208,300-314`; `src/tools/render.ts:42,616-622,782-789`
  - Verifier adjustment: order the parameters `(…, theme, partial = false, contentOnly = false)`.
- **sub-tools-render-6: Flatten the density-limit tables in details.ts and remove duplicated or identical limit keys.** **13 / 0** · none · S
  - `src/tools/details.ts:81-166,356,400,449`
  - Why it holds: every cap is numerically identical at every density.
- **sub-tools-exec-ui-13: Stop restating in schema.ts what the TypeBox schemas already give.** **12 / 0** · none · S
  - `src/tools/schema.ts:268-275,299-305,308-319`
  - Use `Static<typeof XParameters>` inline and derive `WORKSPACE_FIELDS` from `Object.keys`, which keeps insertion order.
- **sub-tools-render-7: Replace the hand-written RunDetailsCandidate interface with the schema-derived details type.** **10 / 0** · none · S
  - `src/tools/details.ts:627-641`
  - Use `Exclude<CompactSubagentToolDetails, { action: "models" }>`.
- **sub-tools-render-8: Inline the single-use exports projectSubagentStartEntries and formatStartResultDetails.** **10 / 0** · none · S
  - `src/tools/details.ts:454-459,543`; `src/tools/format.ts:417-431`
- **sub-tools-exec-ui-15: Remove profile normalization that changes nothing.** **9 / 0** · none · S
  - `src/tools/execute-start.ts:12,66-69`; `src/tools/execute-models.ts:9-14,54-55`
  - Why it holds: both fields are already `StringEnum(PROFILE_IDS)`.
- **sub-tools-render-2: Remove the redundant `summary.metadata = []` resets and the unused `_phase` parameter.** **8 / 0** · none · S
  - `src/tools/compact-summary.ts:161-165,242,297,303-305,422,480,496`
- **sub-tools-render-10: Unify the three identical run-hierarchy option types.** **8 / 0** · none · S
  - `src/tools/render.ts:44-47`; `src/tools/render-await.ts:134-137`; `src/tools/render-run-rows.ts:94-103`
- **sub-tools-exec-ui-14: Remove unused tool-runtime parameters.** **7 / 0** · none · S
  - `src/tools/execute.ts:61-69,149-157,452-460`; `src/application/register.ts:188-196`; `src/boundary/host-pi-supervisor-extension.ts:346-347`; `src/boundary/host-child.ts:493-494`
- **sub-tools-render-4: Drop the redundant `showReportAffordance` option and the no-op `showReportOutcomes` arguments.** **6 / 0** · none · S
  - `src/tools/render.ts:261,400,465,469,483,671,806`
- **sub-tools-render-9: Share one await outcome-color helper between the settled banner and the live await card.** **6 / 0** · none · S
  - `src/tools/render.ts:490-534`; `src/tools/render-await.ts:43-52,212-224`
  - Add `awaitSummaryColor(runs, until, outcome)`. Apply after render-3.
- **sub-tools-exec-ui-5: Share the live-hierarchy and ticker logic between the two result renderers.** **6 / 0** · none · S
  - `src/tools/subagent.ts:52-72,329-337`
  - Add `panelOwnsHierarchy(details, isPartial, context)`.
- **sub-tools-exec-ui-12: Inline the single-use decodeWorkspaceArguments.** **5 / 0** · low · S
  - `src/tools/proxy-protocol.ts:106-125,137-167`
  - Verifier adjustment: keep the typed `decodeTaggedArguments` and the switch. The proposed Map lookup table would need unchecked assertions on the authenticated proxy boundary (TS2698).
- **sub-tools-render-11: Drop the redundant seenFailures set in start-detail relationship validation.** **5 / 0** · none · S
  - `src/tools/details-schema.ts:565-592`
  - Why it holds: the strictly increasing index check already rejects duplicates.

**Ordering and overlaps.**

- Apply these after the finding they depend on:
  - workspace-7 before workspace-6.
  - workspace-1 before workspace-20.
  - workspace-15 before workspace-16.
  - render-3 before render-9.
  - core-18 before core-19 (soft dependency).
- run-rest-1, core-5/rest-3 and run-rest-10 all edit `src/run/events.ts`.
- workspace-2 and workspace-12 both edit `profile-workspace-pickers.ts`.
- rest-5 and workspace-15 both edit the set-picker render state.
- rest-2 and rest-10 both edit the dashboard's parent-model code.
- rest-7 moves `legacyCandidateJson`, which config-8 rewrites.
- config-5 and config-11 both edit `selectedSet`.

### Structural notes (unverified)

- ~90-150: run/ factories re-declare shared dependencies (withLock, publish, records, writerPools, requireRecord and others) about 55 times, and `service.ts:505-781` passes them through one by one. A shared `RunCore` context would remove most of it. About 20 more would come from typing events.ts and process-lifecycle.ts through `RunSettlement[...]`. This touches every run module and fixture.
- ~100: fleet.ts, pi-background-task, pi-mcp and pi-cosmic-ui activity each repeat the wide/stacked/narrow ListDetailShell composition. A shared composer in `pi-cosmic-ui/manager/list-detail-shell` could absorb 25-35 lines per manager.
- ~70: four hostile-input route and array readers (schema.ts, session-overrides, store.ts, profile-restore) each apply different acceptance rules. Unifying them would change which shapes are accepted, so it should be a security-reviewed follow-up.
- ~30: tools execute re-validates targets, specs and workspace bounds already enforced by TypeBox and the proxy decoder. The finder kept these as defense in depth, because direct `tool.execute` paths are tested.
- ~30: `runOverviewComponent` takes nine optional flags across six call sites. Explicit section builders would need snapshot-parity work.
- ~20: `selectCandidateField` could apply a per-choice update thunk instead of re-narrowing each field. That would be a moderate redesign.
- ~20: after the receipt merge (settings-rest-3/run-rest-4), `store.patchProfile` loses its last src caller and can go with its test uses.
- ~18: `SubagentServiceContract.awaitTerminal` has no production caller. It has 25 test call sites, which could move to a test helper.
- ~15: controller.ts and proxy-controller.ts duplicate the fleet-overlay host scaffolding. A shared opener would need a neutral boundary home so the child proxy does not import the root graph.
- ~15: compact-summary.ts resolves the subject across four helpers. Many tests pin its edge cases.
- ~14: small fleet.ts and activity-panel.ts items are each under the threshold: `shortRunId` re-implemented, duplicated state strings, a `promptInstruction` pass-through, a nested-ternary reason, a `FleetKeybindingId` alias, `fitPanelHeader`, and run-ID dedupe repeated 3 times.
- ~12: the shallow plain-object guard is re-implemented across config and tools. A shared `asPlainObject` could live in `pi-cosmic-core/runtime-values.ts`.
- ~10: two copies of the authoritative inspection live in profile-dashboard, the closure and the component, kept in sync through `onInspection`.
- ~10: the "choice matches candidate model" predicate is written 5 times. settings-rest-2 covers the catalog and dashboard sites, leaving the `profile-workspace-pickers.ts:116-120` site.
- ~10: repeated small helpers include the target key (3 copies), runtime labels in profile-model-catalog, and rebuilt `${provider}/${id}` selectors where `canonicalPiModelId` exists.
- ~10: `freezeSnapshot` already deep-clones, so the `cloneProfileRoute`/`cloneOrigin` passes before it are partly redundant. Each input source needs an audit first.
- ~5-10: several cycle-safe ancestor walks could share one `ancestorIds` generator.
- ~6-12: `openProfileDashboard` could return `Promise<void>` once the close result is narrowed, because the controller discards it.
- ~8: tools/model.ts `SubagentProfileView` and `ProfileCandidateDiscovery` are derivable from details-schema types.
- ~8: details.ts `awaitCandidate` and `runDetailsCandidate` share slice and flag logic, but differ in how `reportsOnlyOmitted` interacts, which risks the persisted contract.
- ~8: `SubagentProfileService.definition` and `.resolve` are stateless pass-throughs that consumers could import directly.
- ~6: `(code, message) => new InvalidSubagentRequestError(...)` factories also exist in write-claim-control and 4 boundary files. This extends run-core-19.
- ~6: after config-8, `DecodedSubagentConfig.invalidProfileRoutes` has no production reader. Only about 12 test assertions use it.
- ~6: after run-core-3, resume's two-branch `tapError` could run the locked completion once.
- ~6: `joinTextContent` duplicates pi-code-previews `getTextContent`, which is not exported publicly.
- ~5-6: the working/waiting/paused/retained count filters are repeated 3 times and could share a `countRunStates` helper.
- ~0: latent UX mismatch behind workspace-8. The intended "· fast mode available" and "reasoning levels: none" model-picker copy never renders. Deleting the override keeps current behavior, and restoring the copy would be a deliberate UI change.
- ~0: fleet.ts (843), launch.ts (738, with a ~545-line `start` closure) and service.ts (929) exceed the split guidance. Splitting them helps layout but not line count.
- Measured and rejected by the finders:
  - compact-workspace-summary inlining, ~12: it breaks the oxlint complexity limit of 20.
  - Session-transition helper, ~7: error precedence.
  - withOwnedWorkspace and mergeUsage merge, ~5.
  - Themed wrap helper and ticker try/catch, ~2 each.
  - Store `withField`, ~2.
  - Catalog-load skeleton, ~0.

### Needs a decision

- **sub-tools-exec-ui-6: Write settlePresentation as a small async try/finally.** 7 claimed · low · S
  - `src/tools/subagent.ts:35-51`
  - For: an async body runs synchronously up to its first await, release happens after the operation settles, release errors are still swallowed, and Pi awaits `execute`, so the change is unobservable.
  - Against: oxfmt expands the one-liner to about 14 lines, so it nets about 3, below the threshold. It also turns a synchronous throw into a rejection.
  - Low value either way. Take it only when the file is already being edited.

None of the 8 spot-checked findings were demoted.
