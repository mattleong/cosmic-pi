## pi-cosmic-ui

Reviewers confirmed all 56 findings in this shard. None were disputed or dropped. After deduplication there are 55 entries, which together remove about **641 source lines and 644 test lines** (net figures, using the verifiers' conservative minimums). T-ui-22 is folded into ui-activity-app-6 because both delete the same dead `renderToolSections` export and its test lines. The source savings split three ways: manager/config (237 src / 20 test, 11 entries), footer/protocol (221 src / -4 test, 10 entries), and application/activity/working timer (183 src / 17 test, 12 entries). The 22 test-only T-ui entries account for 611 test lines. The main themes are:

- unused exports on published subpaths, such as `ModelPickerPage` actions and `refreshCatalogs`, `renderToolSections`, and the footer label layout
- switch or if-ladders that become tables, in the keymap, settings adapter, list-navigation, builtin contributions and blocked labels
- over-explicit Effect/state code in the working timer, footer installation, registry and service type arguments
- repeated test fixtures, plus tests already covered by broader lifecycle tests

Nearly everything is effort S, with risk none or low. Many source findings were rebuilt in scratch copies and passed tsc, oxlint (anti-slop), effect-tsgo and the full package suite. I spot-checked the eight largest entries against the code and all eight held, so none were demoted. Three findings require doc edits:

- `docs/architecture/pi-boundaries.md:115` (ui-activity-app-7)
- `packages/pi-cosmic-ui/README.md:84` (ui-manager-4)
- `packages/pi-cosmic-ui/ARCHITECTURE.md:49` (ui-activity-app-6)

Paths below are relative to `packages/pi-cosmic-ui/` unless they start with `packages/` or `docs/`.

| Category                 | Entries | Src LOC | Test LOC |
| ------------------------ | ------: | ------: | -------: |
| verbose-code             |      14 |     224 |       64 |
| dead-code                |       7 |     168 |       37 |
| indirection              |       4 |      70 |       -4 |
| redundant-validation     |       3 |      66 |        0 |
| duplication              |       5 |      65 |        0 |
| over-generalization      |       1 |      23 |        0 |
| boilerplate              |       1 |      19 |        0 |
| shared-helper-reuse      |       2 |       6 |        7 |
| test-redundancy          |      11 |       0 |      298 |
| test-fixture-duplication |       5 |       0 |      167 |
| test-policy-violation    |       2 |       0 |       75 |
| **Total**                |  **55** | **641** |  **644** |

**How the findings interact (each counted once):**

- ui-activity-app-6 and T-ui-22 cover the same test lines. They are merged, and the test side is counted at 10, the scratch-measured 31→21 lines. T-ui-22 estimated 9.
- ui-manager-1 and ui-manager-6 were verified together: model-picker.ts goes 270→208, which is 38+24.
- ui-activity-app-2, -3 and -4 were verified together: application.ts goes 567→524, which is 43 = 15+12+16.
- ui-manager-6 deletes the refresh test at `tests/model-picker.test.ts:146-164`. That test holds one of the seven constructions that T-ui-17's builder would shrink, so if both land, that construction is saved only once.
- ui-footer-protocol-6 adds 4 test lines to `footer-primitives.test.ts`. T-ui-14's builder there would absorb part of them.
- T-ui-2's estimate assumes T-ui-1 lands first, and T-ui-5's assumes T-ui-4 lands first.
- Some of T-ui-5's one-line exec literals (host-service.test.ts:439, 454, 595) sit inside tests that T-ui-11 rewrites. T-ui-5's savings come from the multi-line literals, so there is no material double count.

### Manager and config (`src/manager`, `src/config`): 11 entries, src 237 / test 20

- **ui-manager-6**: Remove the test-only `ModelPickerPage.refreshCatalogs` and `ModelPickerCatalogUpdate`, and compute `canScope` once.
  - Locations: `src/manager/model-picker.ts:110-115,141,146-151,172-176,228-247`, `tests/model-picker.test.ts:146-164`
  - Proposal: Delete the method, the interface and the test that exercises it. Make `options` readonly and store `private readonly canScope` in the constructor for use in `scopeSubtitle` and `handleInput`.
  - **src 24 / test 20 · risk low · effort S**
  - Why behavior holds: Only its own test calls `refreshCatalogs`; pi-subagents rebuilds the picker instead. Once `options` never changes, `canScope` is invariant. This removes a public method from the published `manager/model-picker` subpath.
- **ui-manager-1**: Remove `ModelPickerPage`'s unused `actions` feature (`ModelPickerAction` and `ModelPickerPageEntry` wrapping).
  - Locations: `src/manager/model-picker.ts:98-108,131,143,178-209,220-223`
  - Proposal: Delete both types and the option. Type the inner page as `SearchableSelectPage<M>`, pass `createModelPickerChoices(this.models(), this.options.current)` directly, and use `select: (model) => this.options.select(model)`.
  - **src 38 / test 0 · risk none · effort S**
  - Why behavior holds: No workspace caller passes `actions`; it is left over from the removed pi-advisor package. Choices and select behave the same for every caller, but a public type leaves the published subpath.
- **ui-manager-2**: Collapse `FullScreenKeymap`'s six copy-pasted selection-motion blocks into a table loop.
  - Locations: `src/manager/keymap.ts:70-77,140-142,160-210`
  - Proposal: Add a module-level `SELECTION_MOTIONS` table of `[key, action, configuredId?]`. One loop checks `matchesKey`, then the configured binding (only when `id` is set and `!sharedActionOwnsPrintable`), resets the chord and returns the action. Inline `selectionMatch` at its one remaining use, the confirmation branch.
  - **src 37 / test 0 · risk none · effort S**
  - Why behavior holds: The order (up, down, home, end, pageUp, pageDown) and the gating are unchanged, and every match still resets the chord. Scratch copy: 255→218 lines.
- **ui-manager-3**: Replace `VimSettingsAdapter`'s two action switches with one exhaustive table, and cast the child once.
  - Locations: `src/manager/settings-adapter.ts:56-107,131-137,149-150,157-161,174-177,225-227`
  - Proposal: Add `SETTINGS_ACTION_INPUT = {...} satisfies Record<FullScreenAction, {input, id}>`. The `satisfies` form is required, because an annotated `Partial<Record>` trips anti-slop `no-known-value-widening`. `forwardSelection` becomes a lookup plus `id && matchesKeybinding?.(data, id) ? data : input`. Type `child` once as `Component & SettingsFocusableBridge` with a single SAFETY comment.
  - **src 29 / test 0 · risk none · effort S**
  - Why behavior holds: The table holds the same action→input/id pairs, `satisfies` keeps exhaustiveness, and the cast is type-only.
- **ui-manager-4**: Move the single-use selection helpers into `ListDetailShell` and inline `browsingListDetail`.
  - Locations: `src/manager/list-detail.ts:32-40,45-70,126`, `src/manager/list-detail-shell.ts:6-17,44-57`
  - Proposal: Write `select` and `reconcile` directly in the shell (clamp, compute `changed` against the prior `selectedId`, reset `detailScroll`). Delete `applySelection`, `selectListIndex`, `reconcileListSelection` and `ListSelection`, and inline `browsingListDetail` into `listDetailMotion`.
  - Verifier adjustment: Also update `README.md:84` and the list-detail.ts header comment, which still describe "selection reconciliation" as a pure primitive.
  - **src 27 / test 0 · risk low · effort S**
  - Why behavior holds: Clamping, reconciliation and scroll reset give the same results. External consumers import only `ListSelectionChange`, which stays. Four unused exports leave the published subpath.
- **ui-manager-5**: Inline the single-use `settingsHintRenderer`, and drop the always-true `search` option and the unused `maxVisible`.
  - Locations: `src/manager/settings-adapter.ts:15-48,203`, `src/manager/settings-surface.ts:100,114,156,174-190`, `tests/settings-adapter.test.ts:49`, `packages/pi-better-openai/src/settings/controller.ts:314`
  - Proposal: Remove `search` from all four option shapes, so search is always on and `SettingsList` gets `enableSearch: true`. Inline the hint renderer, which is about 5 lines after oxfmt. Drop `maxVisible`, and drop pi-better-openai's `search: true`, which would otherwise be an excess property.
  - **src 23 / test 0 · risk low · effort S**
  - Why behavior holds: All five `createSettingsListSurface` callers already search, and the hint text is unchanged. Verifier adjustment: a `VimSettingsAdapter` constructed directly now always treats `/` as search. That changes a published default, though nothing in the workspace relies on it.
- **ui-manager-7**: Derive the config types from one `FooterConfig` plus core's `ScopedConfigMetadata`.
  - Locations: `src/config/schema.ts:17-40,66`, `src/config/store.ts:2,56-60,68-78,138-142`
  - Proposal: Declare one `FooterConfig` interface. Type `CosmicUiConfigFile.footer` as `Partial<FooterConfig>` and make `ResolvedCosmicUiConfig extends ScopedConfigMetadata`. Use spread-based decode and resolve, and let `currentFooter` use core's `isJsonObject`, which drops a SAFETY cast.
  - **src 20 / test 0 · risk none · effort S**
  - Why behavior holds: The types are structurally identical, and `decodeTolerantFields` emits only owned keys. For parsed JSON, `isJsonObject` matches the old object, non-null, non-array check. The persisted format is unchanged.
- **ui-manager-8**: Turn list-navigation's motion union, Set and if-ladder into one offset table.
  - Locations: `src/manager/list-navigation.ts:3-40`
  - Proposal: Define `MOVEMENT_OFFSETS` and derive `MovementMotion` and `ListMotion` from its keys. Guards use `Object.hasOwn`, and `movementOffset` becomes a table lookup.
  - **src 13 / test 0 · risk none · effort S**
  - Why behavior holds: The exported names and literal unions are unchanged for pi-subagents. Every caller guards with `isMovementMotion`. Scratch copy: 58→45 lines.
- **ui-manager-9**: Drop `SearchableSelectPage`'s redundant height-1 render branch and its no-op switch cases.
  - Locations: `src/manager/searchable-select.ts:224-227,337-344`
  - Proposal: Delete the height-1 early return, plus the three no-op case labels and their `break`.
  - **src 12 / test 0 · risk low · effort S**
  - Why behavior holds: `framedScreen` already returns only the truncated top row at height 1. The only differences are unobservable side effects (a footer or `keybindingLabel` call, and `Input.render`). Scratch copy: 421→409 lines.
- **ui-manager-10**: Make `managerTable.row` reuse its own cell formatter.
  - Locations: `src/manager/table.ts:48-65`
  - Proposal: Hoist `cell`, and build `row` with `columns.flatMap` over the columns that have a truthy width.
  - **src 8 / test 0 · risk none · effort S**
  - Why behavior holds: For truthy widths, `widths[i] ?? 0` equals `widths[i]!`. This also drops two non-null assertions. Scratch copy: 66→58 lines.
- **ui-manager-11**: Share model-picker's `boundedMiddle` instead of the verbatim copy in pi-subagents.
  - Locations: `src/manager/model-picker.ts:40-45`, `packages/pi-subagents/src/settings/ui/model-picker.ts:38-43`
  - Proposal: Export `boundedMiddle`, delete the pi-subagents copy, and add it to pi-subagents' existing `pi-cosmic-ui/manager/model-picker` import.
  - **src 6 / test 0 · risk none · effort S**
  - Why behavior holds: The two bodies are character-for-character identical, and the import edge already exists.

### Footer and protocol (`src/footer`, `src/protocol`): 10 entries, src 221 / test -4

The finder prototyped all ten together in one scratch copy: about 229 source lines removed and 4 test lines added, with every gate passing.

- **ui-footer-protocol-1**: Delete the dead footer layout exports (labeled line, footer label, legacy context wrapper).
  - Locations: `src/footer/contributions.ts:9-13,179-199`, `src/footer/layout.ts:16,72-84`, `src/footer/component.ts:22`
  - Proposal: Delete `FOOTER_LABEL_WIDTH`, `footerLabel`, `renderLabeledContributionLine`, `renderContextLine` and the layout.ts re-export. component.ts then imports `renderContributionLine` from contributions.ts.
  - **src 43 / test 0 · risk none · effort S**
  - Why behavior holds: There are no callers, and the footer layout modules are not package exports (only `./client` is). I spot-checked this.
- **ui-footer-protocol-2**: Build the builtin thinking colors and metric contributions from tables.
  - Locations: `src/footer/builtin-contributions.ts:29-52,90,178-210`
  - Proposal: Make `THINKING_COLORS` a `ReadonlyMap` read with `?? "thinkingText"`. Replace the metric array, filter and loop with a local push-and-return `metric(id, text, order)` helper called five times, and set `.align = "right"` on cost. A conditional spread is not an option because anti-slop forbids it.
  - **src 28 / test 0 · risk none · effort S**
  - Why behavior holds: Ids, text, order, priority 90, push order and cost alignment are all unchanged. Unknown thinking levels still get `thinkingText`.
- **ui-footer-protocol-4**: Share one get-or-create helper for provider usage window entries.
  - Locations: `src/footer/provider-usage.ts:10-21,29-90,100-103,121-124`
  - Proposal: Add `WindowEntry` and `ProviderEntry` types and a local `windowFor(label)` keyed by the lowercased label. `entryText(entry)` then serves both `simpleEntry` and `wrappedEntry`.
  - **src 27 (the verifier adjusted this down from 31) / test 0 · risk none · effort S**
  - Why behavior holds: Entries keep their fields, first-seen label and order, and resets still merge into the matching window.
- **ui-footer-protocol-5**: Move the upsert number and callback checks into the Schema, and use one return path.
  - Locations: `src/protocol/protocol.ts:193-194,204-205,211,215-219,241-242,322-365`
  - Proposal: Add `Callback = Schema.declare(Predicate.isFunction)`. Use `Schema.Finite` for priority and order, `Finite.check(isGreaterThan(0))` for preferredWidth, and `Schema.optional(Callback)` for the optional callbacks. Delete `optionalFunction` and the post-decode block, and freeze and return once through `detachCosmicFooterContributionFromReceiver`.
  - **src 25 / test 0 · risk none · effort S**
  - Why behavior holds: A scratch comparison over 14 hostile inputs gave the same accept or reject result every time. The receiver only matters for surfaces, and the outer try/catch stays.
- **ui-footer-protocol-6**: Pass the footer component one projection getter and the registry bridge.
  - Locations: `src/footer/component.ts:21,33-53,113,119-127,190-192`, `src/footer/builtin-contributions.ts:56-63`, `src/footer/installation.ts:122-133`, `src/footer/registry.ts:311-315`
  - Proposal: Replace the four getters with one `projection()` typed as `Pick<CosmicUiProjection, …>`, which `builtinContributions` destructures. Pass `registry: bridge` typed as `Pick<FooterRegistryBridge, "snapshot"|"invalidate">`, delete `FooterContributionView`, and inline `footerSurfaces` as a type-guarded `find`.
  - Verifier adjustment: Also point application.ts, layer.ts and protocol/service.ts at builtin-contributions.ts for `FooterTotals`, and drop component.ts's re-export. Otherwise the change adds a type-only import cycle.
  - **src 23 / test -4 · risk none · effort S**
  - Why behavior holds: Values are still read lazily on each render. Publish reassigns `bridge.snapshot`, so reading the property matches the old getter.
- **ui-footer-protocol-9**: Replace installation's generation counters and staged/active variables with attempt objects.
  - Locations: `src/footer/installation.ts:29-37,44-71,88-107,134-146,168-192,203-220,227`
  - Proposal: Add `FooterAttempt { instance, renderRequest, component, disposers }` and track `pending` and `active` attempts, comparing identity instead of generation numbers. Move `inertFooter` and `FooterInstance` to module scope.
  - **src 20 / test 0 · risk low · effort M**
  - Why behavior holds: These fields were always assigned together. The currentness checks, the capture before `setFooter(undefined)`, and pending-attempt disposal all map one-to-one, and all 288 tests pass. This is a delicate re-entrancy state machine, so review it carefully.
- **ui-footer-protocol-8**: Let `makeSubscriptionRefresh` infer its type parameters in `CosmicUiService`.
  - Locations: `src/protocol/service.ts:69-72,111-117,137-143,170-176`
  - Proposal: Drop the explicit type arguments and the `PullValue` alias, and write `updateState` as a single transition.
  - **src 19 / test 0 · risk none · effort S**
  - Why behavior holds: This is type-only. The contract's `Effect<void>` signatures still force E and R to `never`.
- **ui-footer-protocol-7**: Store registry state as a plain entry array and simplify `remove`'s result.
  - Locations: `src/footer/registry.ts:26-28,37-40,67,144-213,219-281,291-294`
  - Proposal: Use `type RegistryState = readonly RegistryEntry[]`. `remove` returns `[undefined, current]` when nothing matches, otherwise `[resources, filtered]`, and `afterPublish` closes and then renders only when resources are defined.
  - **src 15 / test 0 · risk none · effort S**
  - Why behavior holds: Publication still keys on state identity. A no-op remove neither closes nor renders, and `clear` still publishes an empty snapshot.
- **ui-footer-protocol-3**: Collapse the cache metric helpers and drop the re-filtering in `metricParts`.
  - Locations: `src/footer/metrics.ts:15-41,49-53,62-63`
  - Proposal: Use one `metricCacheGroup` over `[cacheRead, cacheWrite]` that lowercases R and W, and a `CACHE_IDS.includes` check. Remove the unreachable cost/right skip and the empty-text guards.
  - **src 14 / test 0 · risk none · effort S**
  - Why behavior holds: The only caller, `renderMetricsLines`, already filters out empty and cost/right entries. Read still comes before write.
- **ui-footer-protocol-10**: Simplify layout's context fallback and cursor-up stripping.
  - Locations: `src/footer/layout.ts:59-63,124-129,134`
  - Proposal: Use `candidates.find(...) ?? truncateToWidth(candidates.at(-1) ?? "", width, "")`. Replace `stripLeadingCursorUp` with a `^\u001B\[\d+A` regex written in the file's `String.raw` style.
  - **src 7 / test 0 · risk none · effort S**
  - Why behavior holds: pi-tui's `truncateToWidth` returns text that fits unchanged, and the regex accepts exactly the digit-only prefixes the hand-written parser accepted.

### Application, working timer, activity, boundaries (`src/application.ts`, `working/`, `activity/`, `boundary/`, `layer.ts`, `tool/`): 12 entries, src 183 / test 17

- **ui-activity-app-6 + T-ui-22**: Delete the test-only `renderToolSections` and its `ToolSection` and `sectionColor` support.
  - Locations: `src/tool/presentation.ts:70-102`, `tests/tool-presentation.test.ts:11,23-30`, `ARCHITECTURE.md:49`
  - Proposal: Delete lines 70-102 and the now-unused `visibleWidth` and `sanitizeTerminalStyledText` imports. Delete the width test and `TEST_WIDTHS`, and drop "and bounded plain sections" from ARCHITECTURE.md.
  - **src 33 / test 10 · risk low · effort S**
  - Why behavior holds: Its own test is the only consumer (spot-checked). The change removes an export from the published `./tool` subpath, which is acceptable at version 0.x.
- **ui-activity-app-1**: Collapse the `WorkingTimerService` transitions.
  - Locations: `src/working/service.ts:37-56,138-158,168-171,202-299`
  - Proposal:
    - Add a module-level `pausedAt(state, now)` and use it in the unavailable branch of `tick` and in `waitForUser`.
    - Switch the four void transitions to `SynchronizedRef.updateEffect`.
    - Assign directly inside `Effect.gen` instead of wrapping in `Effect.sync`.
    - Inline `estimateTokensPerSecond` into `formatWorkingMessage`.
  - **src 42 / test 0 · risk none · effort S**
  - Why behavior holds: An inactive state always has both start stamps undefined, so `waitForUser`'s conditionals already equal `elapsedAt`. `updateEffect` holds the same semaphore. Two independent scratch rebuilds went 313→270 and 313→271 lines, with all gates green (spot-checked).
- **ui-activity-app-5**: Derive `ActivityEnvelope` from the ingress schema and collapse the three function-guard declarations.
  - Locations: `src/activity/protocol.ts:88-100`, `src/boundary/host-activity.ts:30-55`
  - Proposal: Move the schema into protocol.ts as `ActivityEnvelopeSchema`, using a local callback-declare helper. Define `type ActivityEnvelope = typeof ActivityEnvelopeSchema.Type`.
  - **src 21 / test 0 · risk low · effort S**
  - Why behavior holds: Runtime validation is identical. The callback fields widen to `?: F | undefined`, and the consumers in pi-mcp, pi-subagents, pi-background-task and pi-ask-user still typecheck. `./activity` gains one export.
- **ui-activity-app-7**: Drop the test-only failure-diagnostics ring buffer from `HostCallbackBoundary`.
  - Locations: `src/boundary/host-callback.ts:23-25,30,49-66`, `tests/registry.test.ts:579-608`, `tests/working.test.ts:71`, `tests/host-callback.test.ts:69`, `tests/host-service.test.ts:417-426`
  - Proposal: Remove `HostCallbackDiagnostic`, `diagnostics()`, `maxDiagnostics` and the ring buffer, so `invoke` becomes a plain try/catch with a fallback. The tests drop their diagnostics assertions, and host-service.test.ts uses a local failure counter instead.
  - Verifier adjustment: Also update `docs/architecture/pi-boundaries.md:115`, which describes the bounded diagnostics.
  - **src 13 / test 7 · risk none · effort M**
  - Why behavior holds: No production code reads `diagnostics()`, and callback isolation and fallbacks are unchanged. Scratch copy: 107→94 lines.
- **ui-activity-app-4**: Share the host-state projection and the start-failure notice, and fold the `registerCosmicUiApplication` wrapper.
  - Locations: `src/application.ts:68-76,183-190,250-257,338-355,444-452`, `tests/extension.test.ts:12,86`
  - Proposal: Add a `hostState()` helper for `publishHostState` and the host-query responder, and a `notifyStartFailure(ctx)` helper. Merge `cosmicUiWithDependencies` into `registerCosmicUiApplication(pi, dependencies = {})`.
  - **src 16 / test 0 · risk none · effort S**
  - Why behavior holds: The published key order (version, active, ready, hidden), and so the dedupe key, is unchanged. Each field is still evaluated where it was before.
- **ui-activity-app-2**: Remove `SessionHostRead` and `sessionHostFrom`.
  - Locations: `src/application.ts:88-115,401-406,416-446`
  - Proposal: Keep only a `sessionCwd(ctx)` read. In `session_start`, snapshot the abort signal only when cwd is defined, and use `abort.aborted`, `abort.signal` and `abort.release` directly.
  - **src 15 / test 0 · risk none · effort S**
  - Why behavior holds: The reads happen in the same order, and the failure paths and release calls are the same.
- **ui-activity-app-3**: Inline the single-use totals helpers and replace the five-field equality ladder.
  - Locations: `src/application.ts:120-123,160-162,434,461-469,485-490`
  - Proposal: Fold the remember step into `totalsFromSession`, delete `refreshTotals` and call `refreshUsage` directly, and compare with `TOTAL_KEYS.every`.
  - **src 12 / test 0 · risk none · effort S**
  - Why behavior holds: `FooterTotals` has exactly these five numeric fields, and the ticker still resolves `refreshUsage` lazily.
- **ui-activity-app-8**: Share one activity-item detach and sanitize routine between the producer broadcast and host ingress.
  - Locations: `src/activity/protocol.ts:108-136`, `src/activity/service.ts:143-167`
  - Proposal: Add `detachActivityItem(item, text, detail)` in a new `src/activity/detach.ts`, which keeps it off the public `./activity` surface. Each side passes its own cleaners.
  - **src 7 / test 0 · risk none · effort S**
  - Why behavior holds: Both sanitization passes and each side's limits remain. Only the key order of the result objects changes, and nothing observes it.
- **ui-activity-app-9**: Dedupe the `makeFooterStatusDeclaration` shutdown path.
  - Locations: `src/boundary/host-status.ts:80-108`
  - Proposal: Define one `shutdown` closure, write `if (!tui) return shutdown();` in `activate`, and expose the closure directly.
  - **src 7 / test 0 · risk none · effort S**
  - Why behavior holds: Both paths run the same statements in the same order, and consumers call `declaration.shutdown()` without relying on `this`. Scratch copy: 176→169 lines.
- **ui-activity-app-12**: Replace the blocked-reason switch with a label table, and import `activityStatus` directly instead of through the widget re-export.
  - Locations: `src/activity/attention.ts:13-26`, `src/activity/widget.ts:15`, `src/activity/component.ts:29-38`
  - Proposal: Add a `blockedLabels` const table with a `'blocked'` fallback, and delete widget.ts's re-export.
  - **src 7 / test 0 · risk none · effort S**
  - Why behavior holds: `blockedReason` is schema-decoded to one of four literals or undefined, so every case maps to the same label.
- **ui-activity-app-10**: Use the unused `ActivityService.layer` static from layer.ts.
  - Locations: `src/layer.ts:78-95`, `src/activity/service.ts:344-345`
  - Proposal: Declare `connected` once per `makeCosmicUiApplicationLayer` call, and use `ActivityService.layer({ publish, tick, connect })`.
  - **src 5 / test 0 · risk low · effort S**
  - Why behavior holds: The layer is built once per session runtime. A stale `connected` could only address a released binding, which the host ignores.
- **ui-activity-app-11**: Replace the `MutableRef` cells in the host-activity `Binding` with plain fields.
  - Locations: `src/boundary/host-activity.ts:4,67-69,126-128,147-159,243-246,350-354`
  - Proposal: Make `rows`, `now` and `starting` plain mutable fields, and drop the `MutableRef` import.
  - **src 5 / test 0 · risk none · effort S**
  - Why behavior holds: The same synchronous reads and writes happen on the same object. `MutableRef` added no synchronization here.

### Tests (`tests/`): 22 test-only entries, test 611 (T-ui-22 is merged above)

**Registry and footer tests (200)**

- **T-ui-9**: Remove two `FooterRegistryService` tests that the lifecycle and ordering tests already imply.
  - Locations: `tests/registry.test.ts:216-258,288-311,357-396,484-550`
  - Proposal (verifier-adjusted): In 216-258, replace the single remove with an owner-wide double `registry.remove("owner")` and assert dispose ran once, then delete 288-311. In 357-396, have `first` request a render from `detach`, and assert that every render event is `render:second` and the attach/detach/dispose order is unchanged. Then delete 484-550.
  - **test 75 · risk low · effort S**
  - Why coverage holds: Idempotent owner-wide surface disposal and the detach-triggered render ordering move into the tests that stay (spot-checked; the verifier recounted about 80).
- **T-ui-13**: Replace the verbose footer metric fixtures with a builder, and loosen the exact layout and copy assertions.
  - Locations: `tests/footer-layout.test.ts:10-151`
  - Proposal (verifier-adjusted): Add a `metric(id, text, compactText?, extra?)` builder. Keep the width bounds, value survival and compact selection, plus an index-free reset-pairing check (5h with 9/10, 7d with 9/12). Drop the row-count, `88% left`, `⇄` format and right-alignment geometry checks.
  - **test 55 · risk low · effort S**
  - Why coverage holds: Provider window/reset pairing is domain parsing, and it stays asserted. Only layout and copy checks that the testing policy excludes go (spot-checked).
- **T-ui-10**: Stop re-proving canonicalization through the protocol buffer, and share the surface render call.
  - Locations: `tests/host-service.test.ts:115-191`, `tests/registry.test.ts:158-165,339-346`
  - Proposal: Reduce the buffer test to its own guarantee: a contribution offered and then mutated drains as a frozen copy of the original. Drop the surfaceSource/normalizedSurface section, and add a local `renderSurface` helper in registry.test.ts.
  - **test 30 · risk low · effort S**
  - Why coverage holds: The buffer uses the same `detachCosmicFooterContribution` that `registry.test.ts:107-214` already covers.
- **T-ui-14**: Share one `createFooterComponent` builder in footer-primitives.
  - Locations: `tests/footer-primitives.test.ts:12-43,68-110`
  - Proposal: Add a local `footer({ contributions, config, contextUsage })` builder.
  - **test 22 · risk none · effort S**
  - Why coverage holds: The assertions are identical.
- **T-ui-16**: Collapse the duplicated hostile-input guard loops and the status-sanitization tests.
  - Locations: `tests/protocol-guards.test.ts:17-59`, `tests/footer-security.test.ts:54-58,79-98`
  - Proposal: Hoist the normalizer list and run `it.each` over the getter and proxy inputs. Test status delivery with a mode table: tui and rpc deliver sanitized text, json and print suppress it.
  - **test 18 · risk none · effort S**
  - Why coverage holds: All five normalizers stay covered for both hostile input kinds, and all four modes stay covered.

**Extension and host-service tests (163)**

- **T-ui-4**: Consolidate the duplicated promise gates, abortable pending exec and in-memory event buses in `tests/support`.
  - Locations: `tests/activity-host.test.ts:25-33,55-70`, `tests/activity-service.test.ts:12-20`, `tests/host-service.test.ts:41-67`, `tests/extension.test.ts:27,55-68,176-198`, `tests/footer-client.test.ts:15-33,45-100`, `tests/support/host.ts:29-34`
  - Proposal: Put `promiseGate`, `abortablePendingExec` and `eventBus({ onUnsubscribe? })` in `tests/support/host.ts`. `eventBus` gets `respondToHostQuery`, which takes a state thunk and returns the unsubscribe handle. Delete the unused `eventBusFixture`.
  - **test 45 · risk none · effort M**
  - Why coverage holds: The fakes keep the same semantics (Deferred release, reject on abort, synchronous dispatch). The copies really are verbatim (spot-checked).
- **T-ui-7**: Fold the event-usage-ignored test into the native-usage reconciliation test, and share usage entry builders.
  - Locations: `tests/extension.test.ts:533-561,573-687`
  - Proposal: In 573-638, send a message_end usage whose `input` getter throws and assert it is never read, then delete 640-661. Remove lines 669 and 679-683 but keep the NaN-rescan atomicity check. Add `nativeUsage` and `usageEntry` builders.
  - **test 35 · risk low · effort S**
  - Why coverage holds: Persisted-only totals, no double charge, never reading event usage, and atomic rescan rejection all stay covered.
- **T-ui-11**: Parameterize the stale and current completion tests, and drop the duplicated probe-interruption tail.
  - Locations: `tests/host-service.test.ts:430-458,577-649`
  - Proposal: Use `it.effect.each([["/second", undefined], ["/project", 1]])`. Remove the pending/started/aborted branch from the polling test; 627-649 stays as the interruption proof.
  - **test 25 · risk none · effort S**
  - Why coverage holds: 627-649 already asserts that both probes abort when the scope closes.
- **T-ui-6**: Add a replacement-context helper and loosen the exact footer copy in the extension session tests.
  - Locations: `tests/extension.test.ts:329-370,386-394,461,511-520,961-971`
  - Proposal: Add `withSession(base, sessionOverrides, extra)` on top of `extensionContextFixture`, and drop the unused `getLeafId` overrides. Assert only that the rendered footer contains the model, cwd and session values, and loosen line 461 to `(expect.any(String), "warning")`.
  - **test 20 · risk low · effort S**
  - Why coverage holds: Reinstall, model_select refresh, stale-probe disposal and the warning severity stay asserted.
- **T-ui-8**: Trim extension micro-redundancies.
  - Locations: `tests/extension.test.ts:279-290,439-440,799-842,878,1108`
  - Proposal: Delete 279-290. Merge 828-842 into 799-826 by adding a second footer, from the same factory, whose `onBranchChange` throws. Route the raw `setFooter` captures through `capturedFooter(h, index, data[, requestRender])`.
  - **test 20 · risk low · effort S**
  - Why coverage holds: Hostile getter containment is still covered at the event boundary (237-277) and in protocol-guards.
- **T-ui-5**: Replace the inline exec result literals with an exec-result helper and a default exec. Depends on T-ui-4.
  - Locations: `tests/extension.test.ts:35-47,200-206,379-383,434-438,1032-1036,1052-1057`, `tests/host-service.test.ts:291,310-324,350,365-373,410,439,454,471,503,551,595`, `tests/pi-exec.test.ts:11`
  - Proposal: Add `execResult(stdout, code)` and `execOk` to `tests/support`, and give `serviceLayer`'s exec a default. Because exec is the first positional parameter, either move it into the options or pass `undefined`. Add a `startWithPendingProbes(h)` helper.
  - **test 18 · risk none · effort S**
  - Why coverage holds: Inputs and assertions are unchanged. The verifier counted 16 literals, not the 17 in the finding's title.

**Activity tests (133)**

- **T-ui-1**: Share one activity row builder and an `ActivityComponent` mount helper.
  - Locations: `tests/activity-component.test.ts:8-17,34-43,71-440` (13 constructions), `tests/activity-model.test.ts:5-22`
  - Proposal: Add `tests/support/activity.ts` with `activityRow(id, status, parent?, overrides?)`, lifted from activity-model's builder. Add `mountActivity(snapshot, { height, loadDetail?, matchesKeybinding? })`, which returns `{ component, closed }`.
  - **test 55 · risk none · effort M**
  - Why coverage holds: Only fixture construction changes. I spot-checked the 13 hand-built constructions.
- **T-ui-3**: Add a default activity provider registration helper to the activity-host harness.
  - Locations: `tests/activity-host.test.ts:207-390` (8 registration blocks)
  - Proposal: Add `harness().register(overrides)`, defaulting the session, provider, snapshot and invoke.
  - **test 24 · risk none · effort S**
  - Why coverage holds: The acknowledgement, replay, re-handshake, redaction and overlay assertions are unchanged.
- **T-ui-23**: Add a recording `ActivityService` helper and merge the two animation tests.
  - Locations: `tests/activity-service.test.ts:55-62,83-86,103-111,131-134,146-197,219-226,290-292`
  - Proposal: Add `recordingService(extra?)`, which returns `{ service, rows(), starting(), rendered() }`. Run the two animation cases through `it.effect.each`, and check rejections with `Effect.flip` or an `expectFailure` helper.
  - **test 22 · risk none · effort S**
  - Why coverage holds: Starting-count semantics, metadata withdrawal, the 100 ms animation and the rejection assertions are all kept.
- **T-ui-20**: Derive the host-viewport expectations from `screenViewport` and delete the tautological child-sizing test.
  - Locations: `tests/viewport.test.ts:40-65,77-85`, `tests/activity-host.test.ts:420-430`
  - Proposal: Assert that the options equal `screenViewport(terminal)` and that the anchor rule holds, then delete 77-85.
  - **test 20 · risk low · effort S**
  - Why coverage holds: The allocation policy stays covered by the `screenViewport` table, and 77-85 asserts something true by construction.
- **T-ui-2**: Table-drive the activity width-bound tests. Depends on T-ui-1.
  - Locations: `tests/activity-component.test.ts:19-32,69-88,212-240,432-447`
  - Proposal (verifier-adjusted): Run one `it.each` over fixtures and widths, with options per fixture. Keep the deep-hierarchy `n` test and the `toContain(agent.route)` check at widths of 100 and above, and drop only the 80-column not-contain check (line 31).
  - **test 12 · risk low · effort S**
  - Why coverage holds: Every fixture stays width-checked, and the check that route data is rendered stays.

**Manager, config and working-timer tests (115)**

- **T-ui-21**: Merge near-duplicate manager component tests into tables.
  - Locations: `tests/keymap.test.ts:9-18,49-57`, `tests/settings-adapter.test.ts:29-45,61-82`, `tests/searchable-select.test.ts:158-192`, `tests/list-detail-shell.test.ts:249-297`
  - Proposal (verifier-adjusted): Use `it.each` for the keymap precedence cases, the adapter key translations and the degenerate `framedScreen` sizes. Keep the adapter's own `render(0)`/`render(1)` bounds check, and leave the searchable-select height loops separate.
  - **test 28 · risk none · effort S**
  - Why coverage holds: Every rule and size stays as a table row with the same assertions.
- **T-ui-17**: Add a model picker page builder.
  - Locations: `tests/model-picker.test.ts:43-183`
  - Proposal: Add `picker(overrides)` with the shared defaults, so each test passes only what distinguishes it. Pass `allModels: undefined` explicitly in the two tests that omit it today.
  - **test 25 · risk none · effort S**
  - Why coverage holds: The inputs and assertions are identical. This overlaps with ui-manager-6 on the refresh test.
- **T-ui-12**: Fold the omitted-trust config test into the untrusted-project test. The verifier reversed the original direction.
  - Locations: `tests/config.test.ts:101-169`
  - Proposal (verifier-adjusted): Delete the real-filesystem test at 101-123, and make the I/O-recorder test at 125-169 an `it.effect.each([false, undefined])`.
  - **test 20 · risk low · effort S**
  - Why coverage holds: The recorder is the only test that enforces zero project-document I/O on writes (store.ts:84), so it stays.
- **T-ui-19**: Drive the working-timer retry tests through `workingHarness`.
  - Locations: `tests/working.test.ts:77-109,184-229`
  - Proposal: Add `flakyHarness(result)` with `failNext()`, and reuse it in the three retry tests.
  - **test 20 · risk low · effort S**
  - Why coverage holds: The mapping from a throwing host to "failed" stays covered in 40-73, and the retries keep the same clock steps.
- **T-ui-18**: Wrap settings-controller open and close, and drop the rollback segment that is already covered three times.
  - Locations: `tests/settings-controller.test.ts:133-240`
  - Proposal (verifier-adjusted): Add a `withSettings` helper and delete 228-235. Move `expect(h.requestRender).toHaveBeenCalled()` into the 192-215 rollback test, and loosen notify to `(expect.any(String), "error")`.
  - **test 15 · risk none · effort S**
  - Why coverage holds: Stale settlement, rollback, reread on success and the re-render request all stay covered.
- **T-ui-15**: Use the `pi-cosmic-core/testing` capture helpers instead of local telemetry and logger capture.
  - Locations: `tests/probe.test.ts:7-9,33-35`, `tests/config.test.ts:206-232`
  - Proposal: Use `capturedTelemetrySnapshot` and `makeCapturedLogger`.
  - **test 7 · risk none · effort S**
  - Why coverage holds: The same redaction and secret-absence checks run through the shared test kit.

### Structural notes (unverified)

**Cross-package**

- The owned-overlay lifecycle (factory, done and closing latches, hide plus a neutral guard, late-mount finish) is re-implemented four times: `src/boundary/host-activity.ts:273-427`, pi-mcp `host-ui.ts` and `host-auth-panel.ts`, and pi-ask-user `host-tui.ts`. A shared `openOwnedOverlay` helper would need a careful cross-package design. About 150 lines.
- There are three parallel guarded `ctx.ui.custom` settings-surface openers with inert fallbacks: cosmic-ui's controller, pi-better-xai `host-ui.ts` and pi-code-mode `host-ui.ts`. Promise versus Effect and abort handling differ between them. About 50 lines.
- Five settings controllers repeat the same host-guarded `matchesKeybinding`, `requestRender`, `dim` and bridge wiring into `createSettingsListSurface`. It could take `{ tui, theme, keybindings, invoke }` instead, with an escape hatch for code-mode and code-previews. About 30 lines.
- The `tests/support/host.ts` cast fixtures and the settings-controller bootstrap are cloned in pi-better-xai and pi-code-mode. Moving them to `pi-cosmic-core/testing` would add Pi host types to core's test kit. About 30 lines.
- Two helpers duplicate code that belongs in core: `snapshotHostAbortSignal` re-implements core's private `ownAbortSignal`, and `schema/decode.ts` `decodeUnknownOrUndefined` duplicates pi-code-mode's `decodeOption`. About 15 lines.
- Possible latent bug: model-picker `modelItem` ignores `model.description` in the non-label branch, so the " · fast mode available" description that pi-subagents computes is dropped. Either that computation is dead, or cosmic-ui should honor it. About 5 lines.
- Option types are re-declared in pi-background-task `TaskManagerOptions` and pi-subagents `profilePaneRows` instead of extending the owner types. About 10 lines.

**This package**

- After ui-activity-app-7, the `HostCallbackOperation` label union and the first argument of about 42 `callbacks.invoke` calls are documentation only. They could be removed or replaced with per-purpose helpers. About 25 lines.
- Activity service→host wiring runs through three callbacks, a `connected` closure and a host `Map` keyed by service. A per-service `bind()` handle would remove the lookups. About 15 lines.
- Items below the reporting threshold: the activity provider availability guard, the double span in repository-probe, `FooterModelView` extending `FooterProjectedModel`, the host-input-dock unfocus branch, and `owner.ts` reusing `clearRun`. About 16 lines in total.
- `ActivityComponent`'s h/l branch and its `c` shortcut duplicate the collapse and expand mutations, but with different depth semantics. Merging them requires picking one semantic. About 5 lines.
- Unused public surface: `CosmicFooterClient.invalidate` and the `detachCosmicFooterContribution` re-export. Removing them would be an API change for third parties, so they were not reported as findings. About 7 lines.
- Smaller ideas the finders checked and dropped:
  - Deriving the public protocol interfaces with `Schema.Type` would change published types; a narrower dedupe saved only about 2 lines.
  - Two protocol/host.ts nits: widening the invalidate ternary (about 1 line) and the unused `ingressCapacity` option (about 3 lines).
  - The canonicalization receiver wrapper is required by anti-slop; folding its rebinding into a loop saves about 3 lines.
  - The scan's clone hints were false positives.
- Published API impact: the manager findings remove `settingsHintRenderer`, `selectListIndex`, `reconcileListSelection`, `browsingListDetail`, `ModelPickerAction` and `refreshCatalogs` from published subpaths, so treat them as minor API removals in release notes. The finder's combined scratch run of ui-manager-1 through -10 removed about 233 source and 20 test lines with all gates passing.

**Tests**

- `tests/extension.test.ts` is 1128 lines covering protocol, footer installation, usage, abort and working concerns. Splitting it by concern would follow the layout guidance but removes no lines on its own.
- The wall-clock `waitUntil` in extension.test.ts could become core's `yieldUntil`. Verify that 100 yields is enough first. About 8 lines.
- Working-timer semantics are observable only through the exact message copy. A `parseWorking` helper would decouple the tests from that copy without saving lines.
- activity-host and activity-service tests overlap on starting withdrawal and animation, but trimming them would tangle the host's redraw assertions. About 10 lines.

### Needs a decision

None of the findings are disputed: all 56 were confirmed, none dropped, and all eight spot-checks held. The confirmed findings do contain three choices the maintainer should make deliberately:

- **Published API removals (0.x).** ui-manager-1, -4, -5 and -6 and ui-activity-app-6 remove unused exports, options or methods from the published `manager/model-picker`, `manager/list-detail`, `manager/settings-*` and `./tool` subpaths. For: nothing in the workspace uses them, and 0.x allows removals. Against: third-party users of the npm package would break, so either note the removals in the release notes or keep the exports.
- **ui-manager-5 default change.** A `VimSettingsAdapter` constructed directly now always treats `/` as search. For: every production path already passes `search: true`. Against: it changes a published class's default behavior.
- **T-ui-12 direction.** The finder proposed deleting the in-memory I/O-recorder test. The verifier reversed this and would delete the real-filesystem test instead, because the recorder is the only enforcement of zero project I/O on writes. Use the reversed version.
