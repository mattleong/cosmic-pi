## pi-code-previews

The reviewers confirmed 101 findings. None were disputed and none were dropped. After deduplication there are 98 entries, removing about **728 source LOC** and **1,355 test LOC**. Two merges produced that count. previews-diff-syntax-1, -3 and -4 edit overlapping line-matching code and save about 6 lines less than their sum, so they count as one entry of 54. T-previews-tools-15 and T-previews-rest-34 propose the same move of `uncaptured-write.test.ts`, so they count once at the lower figure of 15. The source savings sit mainly in four areas: diff/word line matching (225), tool renderers and compact projection (207), config (106) and syntax/terminal-text (82). Most of it comes from removing single-use indirection and redundant local copies of the same logic. Most test savings delete cases that stronger tests already cover, mainly in `compact-summary`, `compact-fallback`, `shiki` and `config/store` tests, and add shared fixtures in `tests/support/render.ts`. Verifiers applied most source findings in scratch copies and ran tsc, oxlint and the 476 package tests. I spot-checked the 10 largest entries, including three tied at 42. All ten held, and none were demoted. All paths below are relative to `packages/pi-code-previews/`. Figures are listed as **src/test** LOC.

| Category                                        | Entries | Src LOC | Test LOC |
| ----------------------------------------------- | ------: | ------: | -------: |
| duplication                                     |      14 |     215 |        0 |
| indirection (includes merged diff-syntax-1/3/4) |       8 |     210 |        0 |
| verbose-code                                    |      17 |     147 |      101 |
| dead-code                                       |       5 |      60 |        6 |
| redundant-validation                            |       4 |      44 |        0 |
| over-generalization                             |       2 |      44 |        0 |
| boilerplate                                     |       3 |       8 |       78 |
| test-redundancy                                 |      31 |       0 |      797 |
| test-fixture-duplication                        |      10 |       0 |      293 |
| test-policy-violation                           |       3 |       0 |       73 |
| shared-helper-reuse                             |       1 |       0 |        7 |
| **Total**                                       |  **98** | **728** | **1355** |

### diff/word matching and word diff (src 225)

- **previews-diff-syntax-1, -3, -4**: Line matching. Keep position pairs internal to the matchers, remove the dead used-set writes, and collapse the positional fallback. `src/diff/word/changed-line.ts:15-18,41-49`, `line-matching.ts:41-42,80-94,99-119,147-154,189-199,242-306`, `sparse-line-matching.ts:29-33,80-127,169-173`.
  - (1) Both matchers return `{removedPosition, addedPosition, confidence}`. `matchChangedLines` sorts once by removed position and maps to block indexes once. Delete `ChangedLinePositions`, `changedLinePositions`, `SparseChangedLinePair`, `ChangedLineIndexPair`, both used-set rebuilds and both final sorts.
  - (3) In the sparse diagonal fallback, use one `let competingScore = 0`, push once, and delete the four dead `.add` calls.
  - (4) Replace `addPositionalFallbackPairs` and its 7-parameter helper `positionPairs` with one loop over `[...similarPairs, [removed.length, added.length]]`. Annotate the array as `ChangedLinePositionPair[]` and push an anchor only when `removedPosition < removed.length`.
  - **54/0** (30, 10 and 20 standalone, minus about 6 of overlap) · risk low · effort M. Spot-checked.
  - Why behavior holds: the index-to-position maps are bijections. Each removed position appears at most once, so a single stable sort gives the same order. Writes at index i are never read again. The sentinel runs exactly the old trailing pass.
- **previews-diff-syntax-10**: Inline single-use and over-parameterized helpers. `line-similarity.ts:68-91` (appendSimilarityShingles, isSimilarityShingleToken), `range-refinement.ts:57-60,77-87`, `token-text-refinement.ts:41-48,104-119` (tokenTextGapRanges), `changed-line.ts:20-33,60-62` (indexedChangedLine, normalizeDiffContent), `change-block.ts:37-42`, `src/diff/parse.ts:9-19`.
  - Inline each helper at its one call site. `change-block` pushes `{ index, line }` literals through `block.entries()`. Keep slice/join for the bigrams so noUncheckedIndexedAccess does not interpolate a possibly-undefined value.
  - **35/0** · none · M.
  - Why behavior holds: pure inlining, with identical bigram strings and evaluation order. The verifiers' recount came to about 50.
- **previews-diff-syntax-2**: One `competingCandidateValues` helper for the three top-two computations. `line-pair-scoring.ts:68-92`, `line-matching.ts:166-240`, `sparse-candidates.ts:68-104`, `sparse-line-matching.ts:142-165`.
  - Add the helper to line-pair-scoring.ts and make `topTwoCandidateValues` and `competingCandidateValue` private. Replace `addCompetingSparseEvidence` and the anchor blocks. Feed line-matching a row-major flatMap of the score cells, then delete `ChangedLineCompetingScores`, `changedLineCompetingScores` and `addCandidateValue`.
  - **26/0** · none · M.
  - Why behavior holds: the same `>=`/`>` update rule applies, and row-major order matches the nested loops. The cost is allocating up to 1024 cell objects.
- **previews-diff-syntax-8**: Export `changedTokenGaps(before, after)` and turn the collectors into closures. `token-alignment.ts:10-141,209-221`, `emphasis.ts:57-66`, `range-refinement.ts:268-277`.
  - The recursive collector, the LCS pass and `uniqueOrderedAnchors` close over before, after and gaps and take only the window bounds. Both external call sites become one line.
  - **20/0** · none · M.
  - Why behavior holds: this is pure parameter threading. Recursion order, gap push order and confidence folding do not change. It composes with -9.
- **previews-diff-syntax-5**: Delete the duplicate helpers `graphemeBoundaryAtOrBefore` and `graphemeBoundaryAtOrAfter`, and use `graphemeStartAtOrBefore` and `graphemeEndAtOrAfter` in the common prefix and suffix functions. `text-boundaries.ts:70-141`.
  - **18/0** · none · S.
  - Why behavior holds: the two pairs give identical results for offsets in [0, len]. This was checked analytically and against combining marks, ZWJ, surrogate pairs and CRLF. Callers never pass an offset above len.
- **previews-diff-syntax-7**: One generic `requiredAt<T>(values: ArrayLike<T>, index, label)` in `diff/word/types.ts` replaces seven index-or-throw helpers. `alignment.ts:82-86`, `line-similarity.ts:211-215`, `tokens.ts:7-11`, `changed-line.ts:51-58`, `token-text-refinement.ts:190-194`, `token-alignment.ts:223-236`.
  - Keep `tokenAt`, `changedLineAt` and `numericAt` as one-line aliases.
  - **15/0** · none · S.
  - Why behavior holds: the same labels produce the same RangeError messages.
- **previews-diff-syntax-6**: Add an `identifierSimilarityParts` helper and replace `tokenDiceSimilarity` with `unorderedTokenSimilarity(a, b, () => 1)` behind the existing empty guard. `tokens.ts:74-92`, `range-refinement.ts:130-144,226-250`, `line-similarity.ts:160-178`.
  - **14/0** · none · S.
  - Why behavior holds: with unit weights the result is exactly 2·shared/(|a|+|b|), and the guard prevents 0/0.
- **previews-diff-syntax-9**: Merge `changedRangesWithConfidence` into one exported function with default token parameters, and inline `emptyWordChangeRanges`. `emphasis.ts:33-83`, `change-block.ts:54-60`.
  - **14/0** · none · S.
  - Why behavior holds: only the test/bench `'off'` path now tokenizes before returning the same empty result, which affects performance only. Production never reaches `'off'` here.
- **previews-diff-syntax-13**: Drop the `syntaxHighlight` flag. `src/diff/render.ts:20-61`.
  - Type `lang` and `invalidate` as `?: … | undefined`, pass the options directly, and make `renderPlainDiff` a single `renderDiff` call.
  - **10/0** · none · S.
  - Why behavior holds: for both callers the flag equals `lang !== undefined`.
- **previews-diff-syntax-19**: Restructure `shouldKeepSmartRange` with an early return, and accumulate `summarizeDiff` into a typed `DiffSummary` literal that keeps the original key order. `smart-filter.ts:32-51`, `src/diff/summary.ts:27-80`.
  - **10/0** · none · S.
  - Why behavior holds: the logic is Boolean-equivalent with the same short-circuit order, and the counter arithmetic is the same.
- **previews-diff-syntax-11**: `rangesForTokenGroup` becomes `mergeRanges(tokens.slice(start, end).map(...))`, and `appendTokenRange` is deleted. `ranges.ts:6-13,33-37`.
  - **9/0** · none · S.
  - Why behavior holds: the same merge rule applies in the same order, and `slice` matches the old `if (token)` skip.

### tools/: renderers and compact projection (src 207)

- **previews-tools-2**: Remove the `renderHiddenPreviewPrelude` pass-through. `renderers/shared/result-prelude.ts:5-6,26-35`, `bash.ts:21,67-73`, `grep.ts:22,53-59`, `read.ts:19,63-69`, `shared/path-list-result.ts:12,49-55`.
  - Each call site becomes `if (!expanded && <cond>) return renderHiddenPreviewExpandHint(renderContext.state, theme)`. Bash must use `renderContext.args`.
  - **29/0** · none · S.
  - Why behavior holds: the same condition returns the same component, and edit.ts already works this way. Skipping the pure `shouldHideBashResult` call when expanded has no visible effect.
- **previews-tools-1**: In `createCodePreviewToolDefinition`, use one local `call`/`result` wrapper per hook and `expandedCall && call(expandedCall)`. Drop the explicit `asPreviewContext` type arguments and keep one SAFETY comment. `src/tools/renderer-adapter.ts:79-135`.
  - **26/0** · none · S.
  - Why behavior holds: renderers are still called unbound with the same arguments, as ARCHITECTURE requires. Verified +12/−38.
- **previews-tools-10**: Remove the never-supplied `lineNumberWidth` option (the option becomes `firstLine?: number | undefined`, with the width computed once) and inline `renderHighlightedPreviewEntries`. `shared/preview-text.ts:12-60`, `content-preview.ts:20,29`, `read.ts:88-90`, `builtin-expanded-content.ts:167`.
  - **24/0** · none · S.
  - Why behavior holds: width, padding and gutter are computed exactly as before. Check `firstLine === undefined`, not truthiness.
- **previews-tools-3**: Replace four status formatters with one exported `formatCodePreviewToolsWithState(state, statuses = getCodePreviewToolStatuses())`. `src/tools/status.ts:36-52,72-79`, `src/commands/health.ts:11-17,25,43-47`.
  - **21/0** · none · S.
  - Why behavior holds: each call still takes a fresh snapshot, so the health output is byte-identical.
- **previews-tools-7**: Inline the two-caller `createPathListPreviewTool` factory into `find.ts` (12-36) and `ls.ts` (11-34) using the grep.ts shape, and delete `shared/path-list-tool.ts` (1-30).
  - **20/0** · none · S.
  - Why behavior holds: the config literal is still built on every render, and `cwd` equals the old `renderCwd`.
- **previews-tools-8**: Derive `CompactIssue`, `CompactIssues` and `CompactIssueClaim` as `typeof …Schema.Type`. `src/tools/compact-issues.ts:4-18,81-88`.
  - Place `CompactIssueClaim` at module scope after its schema.
  - **19/0** · none · S.
  - Why behavior holds: a strict type-identity check passed for all three, including readonly and optional modifiers.
- **previews-tools-6**: Add a local `applied(note)` builder for the four "✓ Write applied" branches. `renderers/write.ts:121-185`.
  - **18/0** · none · S.
  - Why behavior holds: the concatenated strings are identical.
- **previews-tools-9**: Add a local `informational(notices, operation)` for the outer and child expanded-only projections. `compact-issues.ts:285-312`.
  - **10/0** · none · S.
  - Why behavior holds: operation ids, filters and collection order are unchanged.
- **previews-tools-4**: Make the parameters of `secretNotices`, `bashCommandNotices` and `writeDiffProjection` required, drop the settings-singleton imports, and use a type-only import of `BuiltinCompactPolicy`. `compact-notices.ts:2-3,14-15,34,158-167`.
  - **9/0** · none · S.
  - Why behavior holds: every caller already passes explicit values. This also matches ARCHITECTURE's statement that the projector takes all settings as explicit inputs.
- **previews-tools-12**: Pass `tool.renderCall ?? ((_a, theme) => renderFallbackToolCall(tool, theme))` and `tool.renderResult ?? renderFallbackToolResult` directly. `cooperative-tools.ts:82-98`.
  - **9/0** · low · S.
  - Why behavior holds: whether a renderer exists is already fixed at wrap time, and calls stay unbound. The only difference is one fewer stack frame.
- **previews-tools-13**: Remove dead re-exports, an alias, a public guard and an always-empty field. `builtin-projection.ts:22,127`, `builtin-compact-summary.ts:14`, `builtin-failure(-file).ts:1`, `compact-issues.ts:37,203`, `index.ts:44,49`, `src/preview/compact-tool-call.ts:9,85`, `compact-notices.ts:108-155`.
  - Import `BuiltinCompactTool` from `./builtin-subject`, use `subtractCompactIssueClaims` directly, and delete `isCompactIssues`.
  - Leave `outputLimitProjection` without a return annotation and have it return `{notices, counters}`. The anonymous return type in the original proposal fails `anti-slop/no-known-value-widening`. Keep `CompactResultProjection.metadata`, which `writeDiffProjection` uses.
  - **9/0** · low · S.
  - Why behavior holds: runtime output is unchanged. It removes two root exports of the published package (see Needs a decision), and keeping them lowers the saving to about 6. It pairs with T-previews-tools-9.
- **previews-tools-5**: `editResultDetail` reuses `getEditPreviewOperations` (`data/args.ts:22-31`) with a count check, and grep uses `countLabel`. `builtin-result-detail.ts:19-36,59`.
  - **7/0** · none · S.
  - Why behavior holds: the all-or-nothing rule is equivalent, the 64 cap is still checked first, and the strings are identical.
- **previews-tools-11**: Fold `getRequiredCodePreviewTools` into `getEffectiveCodePreviewToolSet`. `src/tools/policy.ts:14-33`.
  - **6/0** · none · S.
  - Why behavior holds: insertion order is the same, and selection.test.ts checks it.

### config/ (src 106)

- **previews-shell-config-1**: Drive the CODE*PREVIEW*\* mapping from two tables. `src/config/env.ts:51-213`.
  - A `SETTINGS_ENVIRONMENT` table (`{field: [name, parser]}`) and a `PERFORMANCE_ENVIRONMENT` table. Derive the key union and `ENVIRONMENT_KEYS` from them, build both objects with Object.fromEntries, and read keys with `Config.string(k).pipe(Config.withDefault(undefined))`.
  - The draft does not typecheck as written. Land it after -2, or move the cast inside the freeze: `Object.freeze(Object.fromEntries(...) as Record<keyof CodePreviewPerformanceConfig, number>)`.
  - **45/0** · low · M. Spot-checked; verifiers measured env.ts going from 248 to 198 lines.
  - Why behavior holds: each field keeps its parser and falls back through `environmentField`, and the same 33 variable names are read. In rc.112, `Config.option` is `map(Some)` plus `withDefault(None)`, so the new form resolves missing keys the same way.
- **previews-shell-config-3**: Inline ten unused exported field schemas into `CodePreviewSettingsSchema` and derive the exported aliases from the struct type. `src/config/schema.ts:11-25,54-62`.
  - **13/0** · none · S.
  - Why behavior holds: the struct uses the same field decoders, and nothing in the workspace imports the ten schemas.
- **previews-shell-config-4**: `Equal.equals` replaces `CodePreviewSettingValue` and `settingValuesEqual`. `document-store.ts:167-187`.
  - **11/0** · low · S.
  - Why behavior holds: primitives compare with `===` and arrays element by element. The identity caches cannot go stale, because the compared arrays are either fresh per save or frozen.
- **previews-shell-config-6**: Delete `defaultSettingsSaveContext` and use `freezeSnapshot({ baseline: environment.defaults, loaded: environment.defaults })`. Destructure the deps fields. `document-store.ts:40-41,66-68,101-103,189-194`, `service.ts:18-25,65-67`.
  - **11/0** · none · S.
  - Why behavior holds: freezeSnapshot deep-clones. Baseline and loaded now share one frozen object, which is only read.
- **previews-shell-config-5**: Delete `flatCodePreviewSettings` and call `loadSettingsFile(deps, settingsPath, identity, effective)` on one line, importing `identity` from `effect/Function`. `document-store.ts:81-86,202-210`.
  - **9/0** (verifiers measured about 15) · low · S.
  - Why behavior holds: `readObject` already decodes the same `Record(String, MutableJson)`, only known keys are read, and unknown root fields are still kept on save.
- **previews-shell-config-7**: Route `queueSettingsSave` through `runSettingsEffect` with `options = hasCodePreviewSessionCapability() ? {} : { rehydrate: loadOptions }`. Rewrite `formatSettingsSaveError` with `Predicate.hasProperty` and `isString`. `store.ts:4,21-26,79-111`.
  - **9/0** · low · S.
  - Why behavior holds: the runtime choice is made synchronously in the same way, and `{}` equals save's default options.
- **previews-shell-config-2**: Derive `type CodePreviewPerformanceConfig = Readonly<typeof performanceDefaults>` and export `Object.freeze(performanceDefaults)` with no annotation. `defaults.ts:33-55`.
  - Land it with or before -1.
  - **8/0** · none · S.
  - Why behavior holds: type-only change; the frozen values are the same.

### syntax/, shared/terminal-text and projections (src 82 / test 3)

- **previews-diff-syntax-12**: Table-drive `updateAnsiState` with `ANSI_STATE_GROUPS`, and express `dropAnsiState` through `replaceSgrSequences` with an optional matcher. `extractSgr` returns a string. `src/shared/terminal-text.ts:47-64,209-265`.
  - Keep the fg/bg predicate `startsWith('38;') && length > 3`, and update the `.sequence` reads in `injectVisibleRanges` and `wrapAnsiToWidth`.
  - **20/0** · none · S.
  - Why behavior holds: reset codes are never appended to the state, so dropping only set-codes is equivalent. A 200,000-case differential fuzz found 0 mismatches.
- **previews-diff-syntax-17**: Remove dead or test-only members.
  - `diff/full-width-text.ts:21-25` (setText).
  - `emphasis.ts:13` (type re-export).
  - `terminal-text.ts:3` (stripAnsi re-export; point `tests/support/render.ts` at pi-cosmic-core).
  - `syntax/projection.ts:24` and `service.ts:61` (snapshot `generation`).
  - `boundary/shiki.ts:49-66` (HighlighterDisposal return).
  - **14/3** · none · S.
  - Why behavior holds: nothing reads these, and the internal `SyntaxState.generation` stays.
- **previews-diff-syntax-14**: One `clearFlight` modify shared by `onFailure` and `onInterrupt`, and `Effect.isSuccess(loadCurrentGeneration)` in place of the match. `syntax/service.ts:183-218,244,282-287`.
  - Keep the "Replacement is transactional" comment.
  - **14/0** · none · S.
  - Why behavior holds: the transition is the same flight-guarded modify. In rc.112, `isSuccess` is `matchEager` with false/true, so defects still propagate.
- **previews-diff-syntax-15**: Store `Map<string, (() => void)[]>` directly, add `invalidateRequest(key)` for the finalizer, the flush and offers, and test `offer(...) !== "accepted"`. Delete `invokeCallbacks` and `PendingRequest`. `syntax/ingress.ts:14-119`.
  - **14/0** · none · S.
  - Why behavior holds: callbacks are still swallowed one by one and flushed in insertion order. The switch loses compile-time exhaustiveness, but any new non-accepted result takes the fail-safe invalidate path.
- **previews-diff-syntax-18**: `syntax/render.ts:53-62,152-188`.
  - Use a `[flag, open, close]` table for font styles.
  - Use a `LOW_CONTRAST_BASIC_FG` Set, with NaN destructuring defaults as the only channel guard.
  - Make `renderHighlightedText` return `renderWithShiki(...) ?? plainHighlightedText(...)`.
  - **14/0** · none · S.
  - Why behavior holds: open and close order are preserved, and `renderWithShiki` returns undefined before any side effect when highlighting is off.
- **previews-diff-syntax-16**: Add `makeOwnedProjection<A>()` to `shared/projection-ownership.ts:1-12`, shared by `syntax/projection.ts:36-81` and `write/projection.ts:10-44`.
  - **6/0** · low · M.
  - Why behavior holds: claim, reset and clear semantics are the same, and each module keeps its own generation. Value is marginal (see Needs a decision).

### settings/ UI (src 62)

- **previews-shell-config-13**: Inline the nine single-use summary functions as `summarize` lambdas on the group definitions and delete `settings/ui/summaries.ts` (1-42). `settings/ui/index.ts:17-27,51,110,154-197`.
  - Apply together with -12.
  - **36/0** · none · S.
  - Why behavior holds: the templates move verbatim. Measured on top of -12: summaries.ts (41 lines) is deleted and index.ts grows by 2.
- **previews-shell-config-12**: Replace the per-group `items` callback with declarative `ids?` and `groups?`, and delete `createSettingListItems`. `settings/ui/index.ts:29-208`.
  - **20/0** · none · S.
  - Why behavior holds: the same items come out in the same order. `theme` only affects the shikiTheme submenu, which is in Appearance. Measured: index.ts goes from 227 to 207 lines.
- **previews-shell-config-11**: Change the signature to `syncSettingsListValues(list, settings)`, which builds throwaway items with `constVoid`. `settings/panel.ts:63-94,115-122`.
  - **6/0** · none · S.
  - Why behavior holds: `SettingsList.updateValue` only copies `currentValue`, so the throwaway items' closures never run.

### application/, preview shell, write (src 46 / test 3)

- **previews-shell-config-9**: Remove dead or test-only code.
  - `application/capability.ts:55-57` (scheduleCodePreview).
  - `preview/line-counts.ts:19-25` (countPreviewTextLines).
  - `preview/compact-tool-call.ts:12` (re-export).
  - `preview/compact-issues.ts:38` (alias).
  - `config/values.ts:62-84` (unused return value).
  - Tests: `tests/boundary/runtime.test.ts:11-21`, `tests/preview/format.test.ts:8-22`.
  - Put the SAFETY comment inside the `if`, directly before the asserting assignment, and edit ARCHITECTURE.md's "Inactive defer/schedule" sentence.
  - **15/3** · none · S.
  - Why behavior holds: nothing in production uses these. Counting stays tested through `selectPreviewTextLines(x, 0).total`. Coordinate with T-previews-rest-13 and -32, which edit the same test files.
- **previews-shell-config-10**: One `renderBorder(width, border, open, close, label)` replaces four single-use wrappers. `preview/bordered-tool-call.ts:157-197`.
  - **15/0** · none · S.
  - Why behavior holds: the labels change only through setters called outside `render()`. Measured: 243 to 228 lines.
- **previews-shell-config-8**: Add a `rejectInactiveCodePreviewSession(operation)` function declaration in capability.ts. `application/capability.ts:59-71`, `application/lifecycle.ts:25-29,130-138`, `write/preview-execution.ts:7-12,119-126`.
  - **10/0** · none · S.
  - Why behavior holds: the error class, operation values and message are the same, and the rejection is still synchronous.
- **previews-shell-config-14**: Define `ExistingFilePreview` as `{kind: "content"; content} | typeof SkippedExistingFilePreview.Type`, declared after the schema. `src/write/diff.ts:10-27`.
  - **6/0** · none · S.
  - Why behavior holds: type-only change. Measured: 186 to 179 lines.

### tests/tools: compact presentation suites (test 490)

- **T-previews-tools-1**: Delete `tests/tools/compact-fallback.test.ts:171-212` and `:214-255`. In `compact-lifecycle.test.ts:282-299`, loop over the on, off and border modes, and assert that `CALL file.ts` appears only when expanded.
  - **0/82** · low · S. Spot-checked.
  - Why behavior holds: `detailsOnExpand` is read nowhere in src, only at `compact-summary.ts:91` and `compact-summary-schema.ts:34`. Lifecycle 216-245 and 314-361 cover slot reuse and owned failures in every mode.
- **T-previews-tools-2**: Move shared fixtures into `tests/support/render.ts`: `renderContext(overrides)`, `textResult`, a `bg` method on `testTheme()`, `restoreCodePreviewSettingsAfterEach()` and a `previewBodiesDisabled` fragment.
  - Sites: `compact-fallback.test.ts:19-49`, `compact-lifecycle.test.ts:40-46,94-107`, `cooperative-tools.test.ts:23-61`, `compact-summary.test.ts:33-35,47-66,79-102,657-683`, `shared/cache.test.ts:26-35,107-120`, `builtin-presentation-conformance.test.ts:65-94`, `presentation-conformance.test.ts:10-27`, and the path-list-render, selection and registration tests.
  - **0/60** · none · M. Spot-checked.
  - Why behavior holds: only fixtures change. The count excludes compact-summary 131-145, which T-tools-7 removes. The 665-683 site keeps its FactoryState and `isPartial: false`.
- **T-previews-tools-3**: In `compact-summary.test.ts:725-1040`, add a local `renderText(tool, output, ctx, width = 100)`. Call it with `{ ...ctx, expanded }`, building ctx once before each toggle loop so the retained shell state stays covered.
  - Keep the fresh-state ctx at 886 and `readArgs` at 833, and pass width 200 at 785 and 1020. Skip the factories record and the `readTruncation` builder.
  - **0/50** · low · M. Spot-checked.
  - Counted after T-tools-5 and -6.
- **T-previews-tools-4**: Delete `builtin-projection.test.ts:120-140`, `142-159` and `115-117`, plus the import on line 6.
  - **0/42** · low · S. Spot-checked.
  - Why behavior holds: compact-summary.test.ts covers each case through the adapter (445-465, 487-496, 1046, 436-442, 191-203, 245-258). The mutation check could not fail.
- **T-previews-tools-5**: Tighten `builtin-presentation-conformance.test.ts:111` to `expect(text.includes(fixture.retained)).toBe(expanded)`, add one collapsed `isPartial: true` render check, and delete `compact-summary.test.ts:685-723`.
  - **0/36** · low · S.
  - Why behavior holds: in a scratch run, all 25 tests pass with the tightened assertion.
- **T-previews-tools-7**: Three changes in `compact-summary.test.ts`.
  - 124-152: use the file's `summary()` helper, with a SAFETY cast for the null and 42 content values.
  - Delete 260-264.
  - Merge 549-566 into 630-647.
  - **0/33** · none · S.
- **T-previews-tools-6**: In `builtin-presentation-conformance.test.ts:118-137`, loop over the three modes, split the error into two text parts, and add the collapsed check. Then delete `compact-summary.test.ts:945-985`.
  - **0/32** · low · S.
  - This drops the check that the target is present while collapsed; lifecycle 314-361 covers subject retention generically. Keep the `[false, true, false, true]` toggle.
- **T-previews-tools-8**: Extend `compact-lifecycle.test.ts:265-280` to all modes with a 100-line body, and delete lifecycle 527-533 and `compact-fallback.test.ts:411-438`.
  - **0/30** · low · S.
  - Why behavior holds: all three copies go through the same `CompactShell.summary()` catch.
- **T-previews-tools-9**: Delete `compact-issues.test.ts:261-286` and its import on line 9, and `compact-descriptions.test.ts:40-43`.
  - **0/28** · none · S.
  - Why behavior holds: the tested function is literally an alias of `subtractCompactIssueClaims`, and 289-324 cover the same cases. It pairs with previews-tools-13.
- **T-previews-tools-10**: Delete `builtin-projection.test.ts:87-103` and `builtin-presentation-conformance.test.ts:188-196`.
  - **0/26** · low · S.
  - Why behavior holds: compact-summary 532-547, 124-152 and 759-790, plus conformance 162-187, still cover it.
- **T-previews-tools-13**: Add a local `installRecordingScheduler()` for `compact-lifecycle.test.ts:551-561` and `612-622`. Add a shared `failingRenderer(failure, lines)` for lifecycle 411-419 and 474-481 and `presentation-conformance.test.ts:114-126` and `301-313`.
  - **0/22** · none · S.
- **T-previews-tools-12**: Delete `compact-summary.test.ts:467-485` and the import on line 31.
  - **0/20** · low · S.
  - Why behavior holds: `tests/preview/compact-tool-call.test.ts:104-165` covers the header width policy.
- **T-previews-tools-15, T-previews-rest-34** (duplicates): Move `tests/uncaptured-write.test.ts` into `tests/tools/builtin-projection.test.ts` and reuse its `base` fixture.
  - **0/15** (T-rest-34 estimated 17) · none · S.
  - This also fixes the test layout so it mirrors the source. Coordinate with T-tools-4 and -10, which edit the same file.
- **T-previews-tools-11**: Collapse `compact-summary.test.ts:487-528` into one four-row `test.each`.
  - **0/14** · none · S.

### tests/tools: selection, registration, grep, cache (test 49)

- **T-previews-tools-14** (policy): Changes in `selection.test.ts`.
  - Delete the circular test at 39-49.
  - Delete the exact health-copy assertions at 36 and 55, and their import.
  - Fold 33-37 into 58-62, which then publishes `"write,edit,grep"`.
  - **0/17** · none · S.
- **T-previews-tools-16**: Turn `grep-render.test.ts:5-30` into a tuple table.
  - **0/12** · none · S.
- **T-previews-tools-17**: In `registration.test.ts`, remove the vacuous `activeNames` plumbing (41-62, 68-81) and merge 83-100 and 189-204 into one `test.each`.
  - **0/10** · none · S.
- **T-previews-tools-18**: Share one `expectReplacedAfter` helper across `shared/cache.test.ts:42-94`.
  - **0/10** · none · S.

### tests/syntax and tests/boundary/shiki (test 240)

- **T-previews-rest-1**: In `tests/syntax/shiki.test.ts`, add `syntaxLayer(adapter)`, `shikiAdapter(create, loadLanguage = () => Effect.void)` and a `beforeEach` that sets `syntaxHighlighting: true` and `dark-plus`. Keep the inline theme switch at 799-806.
  - There are 21 layer sites here and 2 more in boundary/shiki.test.ts.
  - **0/70** · none · M. Spot-checked the counts.
  - Estimated on the tests that remain after T-rest-3, -4 and -5; the gross saving is 80-100.
- **T-previews-rest-3**: Delete `shiki.test.ts:867-891` and `boundary/shiki.test.ts:97-115`.
  - **0/42** · low · S. Spot-checked.
  - Why behavior holds: 406-440 interrupts at the same point, asserts `interrupted === 1` and also proves that a retry succeeds.
- **T-previews-rest-5**: Delete `shiki.test.ts:721-737` and the `renderInSyntaxSession` helper (46-71).
  - **0/42** · low · S. Spot-checked.
  - Why behavior holds: any stale cross-session cache hit would also fail 739-776.
- **T-previews-rest-4**: Delete `shiki.test.ts:479-507`.
  - **0/29** · low · S.
  - Why behavior holds: the 200-request test at 509-545 covers both the retained and the overflow paths.
- **T-previews-rest-6**: Delete `boundary/shiki.test.ts:78-95`. Assert `getShikiStatus().initialized === false` inside the service scope at `shiki.test.ts:387`, not in the post-release tap, where the check would pass trivially. After T-rest-3, drop the unused imports and `initializeSyntax`.
  - **0/20** · low · S.
- **T-previews-rest-2**: Give `highlighter` a signature of `highlighter(dispose, tokens)` and use it in place of four inline cast fixtures and one mutation (`shiki.test.ts:26-33,47-55,180-184,742-750,780-791,828-836`).
  - **0/15** · none · S.
  - Counted after T-rest-5.
- **T-previews-rest-33**: Delete `syntax/projection.test.ts:65-73` and add a local `install(owner, label)`.
  - **0/15** · none · S.
- **T-previews-rest-7**: Use `capturedTelemetrySnapshot` from pi-cosmic-core/testing in `config/service.test.ts:70-72,109` and `shiki.test.ts:102-107`.
  - **0/7** · none · S.

### tests/config (test 233)

- **T-previews-rest-16**: Add a `settingsRoots(prefix)` generator in `store.test.ts`. Drop the `makeDirectory` calls at 222-224, 394-396, 415-418 and 634-636, and call writeJson before `chdir`.
  - **0/35** · none · M.
  - Estimated after T-rest-17 through -21.
- **T-previews-rest-19**: Delete `store.test.ts:496-521`.
  - **0/25** · low · S.
  - Why behavior holds: 523-556 exercises the same shared fallback.
- **T-previews-rest-18**: Delete `store.test.ts:436-459`.
  - **0/24** · low · S.
  - Why behavior holds: 279-285 keeps the trust-gating check.
- **T-previews-rest-20**: Delete `store.test.ts:179-202`. Optionally add a `codePreview` block to `service.test.ts:312-328` for about 1 line.
  - **0/23** · low · S.
- **T-previews-rest-17**: Merge `store.test.ts:301-332` and `357-385` into one `it.each`.
  - **0/20** · none · S.
- **T-previews-rest-25** (policy): In `values.test.ts`, replace 33-47 with one deepEqual, loop over 71-87, and drop the duplicate assertion at 48.
  - **0/20** · none · S.
- **T-previews-rest-26**: Delete `values.test.ts:146-163`.
  - **0/18** · low · S.
  - Why behavior holds: service.test.ts 81-115, 312-328 and 463-499 assert frozen publication.
- **T-previews-rest-23**: Add a `gateFirstRead` helper for `service.test.ts:142-160,180-199,220-243`.
  - **0/16** · none · S.
- **T-previews-rest-21**: Merge `store.test.ts:387-405` and `407-434`.
  - **0/15** · none · S.
- **T-previews-rest-37**: Five small cleanups.
  - The duplicate assertion at `write/service.test.ts:45-48`.
  - Inline `queueSettingsSaveEffect` (`store.test.ts:348-351`).
  - Delete `store.test.ts:558-563`.
  - The two unused settings writes (`diff/index.test.ts:157,169`).
  - The alias and stale SAFETY comments in `support/word-fixtures/emphasis-accuracy.ts`.
  - **0/15** · none · S.
- **T-previews-rest-24**: Table-drive `service.test.ts:358-430` only if the rows stay compact, and assert the `'write'` operation for the first case.
  - **0/12** · none · M.
- **T-previews-rest-22**: Add `installRunOnlyCapability(run)` in tests/support and drop the two redundant try/finally blocks (`store.test.ts:465-473,509-520,534-541,610-624`), since afterEach already clears the capability.
  - **0/10** · none · S.

### tests/preview (test 117)

- **T-previews-rest-8**: Delete `compact-tool-call.test.ts:15-49`.
  - **0/35** · low · S.
  - Why behavior holds: the compact-parity 52-91 matrix covers the numeric threshold.
- **T-previews-rest-9**: Delete `compact-tool-call.test.ts:193-218`.
  - **0/26** · low · S.
  - Why behavior holds: 220-240 asserts both the width bound and exact character preservation.
- **T-previews-rest-13**: In `format.test.ts`, loop the within-limit cases, reduce 100-115 to the limit-7 head-only assertion, and merge the two counter tests.
  - **0/20** · none · S.
  - Coordinate with previews-shell-config-9.
- **T-previews-rest-10**: Add a `description` variant to `compact-children.test.ts:198-234` and delete `compact-parity.test.ts:93-113`.
  - **0/15** · low · S.
- **T-previews-rest-11**: Add a `compactChildren(entries, width, opts)` helper in `tests/support/render.ts`; putting it in a test file would re-register that file's tests in the importer. Keep compact-children line 31 as the raw call.
  - **0/15** · none · S.
- **T-previews-rest-12**: Add a `cachedDeferredPreview` wrapper in `deferred.test.ts`, typed with a `Parameters<…>` rest tuple.
  - **0/6** · none · S.

### tests/diff (test 102)

- **T-previews-rest-27** (policy): In `diff/index.test.ts`, delete the telemetry test at 129-154, the telemetry assertions at 207-209 and 232, the `'off'` range assertions at 224-231, and the import on line 11.
  - **0/36** · low · S.
- **T-previews-rest-29**: Delete `range-refinement.test.ts:31-54` and the first deepEqual at 6-17. Both repeat golden-corpus cases verbatim.
  - **0/35** · low · S.
- **T-previews-rest-30**: Delete `line-matching.test.ts:8-19`; the corpus case `largeReorderedBlockCase(33)` covers it.
  - **0/12** · low · S.
- **T-previews-rest-28**: Add an `emphasisSpans(diff, onInvalidate?)` helper for the seven sites in `diff/index.test.ts`.
  - **0/10** · none · S.
- **T-previews-rest-31**: In `emphasis-accuracy.test.ts:11-22`, keep only the caseCount, exactSpanCases and pair false-positive/false-negative assertions.
  - **0/9** · none · S.

### tests/application, tests/boundary, tests/write (test 118)

- **T-previews-rest-35**: Move `write/preview-execution.test.ts` onto Effect FileSystem with one merged Layer and `makeTempDirectoryScoped`. Delete `TestFileSystemError`, `testFileSystem` and `withTempDirectory`, and keep a small `isSymlink` helper on raw `lstat`.
  - **0/50** · low · M. Spot-checked: 42 `testFileSystem` calls and 7 repeated layer pipes.
  - The inode comparisons need Option unwrapping.
- **T-previews-rest-15**: In `application/lifecycle.test.ts:543-631`, run one loop over the context mutators, add the throwing `isProjectTrusted` getter to the trust table, and delete 611-631.
  - **0/22** · none · S.
- **T-previews-rest-14**: Add a `registered()` generator and a `realRenderers` option to the `lifecycle.test.ts` harness.
  - **0/20** · none · S.
- **T-previews-rest-32**: Delete `boundary/runtime.test.ts:26-36`, move 15-23 and 38-50 into `application/scheduler.test.ts`, and delete runtime.test.ts.
  - **0/18** · none · S.
  - Coordinate with previews-shell-config-9.
- **T-previews-rest-36**: In `write/diff.test.ts`, switch to `it.effect` with `makeTempDirectoryScoped`, and keep `join` for the homedir assertions.
  - **0/8** · none · S.

### Structural notes (unverified)

- About 130 lines: `tests/support/word-emphasis-accuracy.ts` (275 lines) mostly computes precision, recall and F0.5 metrics for the bench. Moving the metrics into `bench/` and giving the test a lean exact checker would shrink it; this touches bench tooling.
- About 100 lines: settings persistence spans about 510 lines (`config/store.ts`, `service.ts`, `document-store.ts`, `coordinator.ts`, `state.ts`) for one small JSON file. Its one-shot rehydrate, signalled retry and admission ordering are documented contract, so shrinking it would be a contract change.
- About 100 lines: the "builtin factory compact integration" describe block in `compact-summary.test.ts:656-1041` (about 385 lines) could move onto the registered-definition harness in the conformance suite. T-tools-3, -5 and -6 are incremental steps toward this.
- About 70 lines: after diff-syntax-1 through -4, the dense matcher (`line-matching.ts`) and the sparse matcher (`sparse-*.ts`) could converge on one score, assign and fallback pipeline. The golden fixtures pin exact pairings, so this is medium risk.
- About 60 lines: the `CompactSummary`, `CompactChild`, `CompactNotice` and `CompactFailureEvidence` interfaces (`compact-summary.ts:21-111`) repeat the schema in `compact-summary-schema.ts`. pi-subagents, pi-ask-user and pi-code-mode mutate summaries, so deriving the types needs a `Types.Mutable` design.
- About 60 lines: the `TestFileSystemError`/`testFileSystem`/`withTempDirectory` trio is copied in pi-code-previews and in pi-cosmic-core's safe-file and host-logger tests. It could move into `pi-cosmic-core/testing` or onto Effect FileSystem (see T-rest-35).
- About 55 lines: `compact-lifecycle.test.ts:66-139` duplicates the public `createToolPresentationHarness`. An option on the public harness to skip forced settlement would let lifecycle and compact-fallback drop their bespoke drivers.
- About 25 lines: the preview-style framing path and the compact-shell framing path (`compact-shell.ts:182-214,291-313`, `tool-shell.ts:78-130`) use different tone rules, so unifying them needs its own design.
- About 25 lines: session-capability fakes are hand-built in store, compact-lifecycle and deferred tests. One `tests/support/capability.ts` would cover them all; T-rest-22 and T-tools-13 cover only part of this.
- About 20 lines: `CompactSummary.detailsOnExpand` is never read in pi-code-previews, but pi-background-task, pi-code-mode, pi-mcp and pi-subagents still set it. Removing it is a cross-package change.
- About 15 lines: `terminal-text.ts` has a strict and a lenient SGR scanner, and pi-cosmic-core has a third. Unifying them changes how malformed input is handled.
- About 12 lines: small duplications in the preview-mode renderers, each saving 2-4 lines: the grep search object, the write before-snapshot lookup, the diff-preview labels and the cache-key builders.
- About 12 lines: the raw Node builtin preamble is repeated in four test files. Most of it goes away with T-rest-35 and -36.
- About 10 lines: exact-span tests in `diff/index.test.ts` could move into the golden corpus. This is organizational, with no net reduction.
- About 8 lines: `createBoundedCompactIssuesSchema` re-declares the issue fields. Deriving the unbounded schema from it would change the decode-error paths consumers see.
- About 8 lines: renderer state for borders and timing is reached through three identical casts. One typed accessor would make field ownership explicit.
- About 8 lines: `analyzeChangedLineBlock` returns removed, added and pairs only for the telemetry helpers.
- About 4 lines: `boundary/settings-one-shot.ts` could use `Effect.provide(..., { local: true })`, but equivalence to the current `Layer.build` memo-map behavior is not proven.
- About 3 lines: the syntax service's initialize has two nested tracing spans; dropping one changes only tracing output.
- About 2 lines: `planCompactPresentation`'s `severity` field has no consumers, but it is documented planner contract, so removing it is an API decision.
- About 0 lines: several compact-summary and path-list tests pin exact label copy, which the testing policy discourages. Loosening them would not reduce lines.
- About 0 lines: the explicit extension and shebang tables in `language.ts` must stay. Deriving them generically would start resolving extensions that are not listed today.

### Needs a decision

No findings were disputed. Two confirmed findings still involve a maintainer choice:

- **previews-tools-13: public API removal.**
  - For: `isCompactIssues` and `withoutFailureBodyIssues` have no consumers or doc references anywhere in the workspace.
  - Against: both are exported from the published package's root `index.ts` (pi-code-previews 0.2.0), so removing them is a semver-visible 0.x change.
  - Either apply the finding and mention the removal in the release notes, or keep both exports, which lowers the saving from 9 to about 6.
- **previews-diff-syntax-16: shared owned-projection slot.**
  - For: one verifier found it fits ARCHITECTURE.md, which already names `shared/projection-ownership.ts`, and nets about 10.
  - Against: the other measured only about 4 net for a new two-user abstraction that also edits the write feature. It is worth doing only alongside other write-projection cleanup.
