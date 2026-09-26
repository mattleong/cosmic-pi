## pi-ask-user

pi-ask-user has 5,917 source LOC and 6,500 test LOC (`wc -l` over `src/` and `tests/`). Verification confirmed 33 findings: 10 in source and 23 in tests. One finding is disputed and one was dropped. After deduplication the removable total is **190 source LOC and 520 test LOC**. The test findings add up to 552 on their own, and 32 LOC of overlap is subtracted once (see the dedup notes). The biggest single item is ask-user-1, which merges the two copy-pasted TUI overlay presenters (80 source LOC). The finders prototyped all the source findings together in a scratch copy: about 215 net lines plus 5 for QuestionnaireQuery, with 266/266 package tests passing and tsc, oxlint, oxfmt and effect-tsgo all clean. That total includes the disputed ask-user-4. Most test savings come from repeated fixtures and scaffolding and from tests whose coverage duplicates a sibling test. I spot-checked the 8 largest findings (ask-user-1, T-1, T-3, T-4, T-5, T-2, T-8, T-7) against the code, and all of them hold. None were demoted.

| Category                 | Src LOC | Test LOC | Findings |
| ------------------------ | ------: | -------: | -------: |
| duplication              |     150 |       38 |        9 |
| test-fixture-duplication |       0 |      189 |        7 |
| test-redundancy          |       0 |      129 |        6 |
| verbose-code             |      16 |       75 |        6 |
| shared-helper-reuse      |       0 |       67 |        2 |
| test-policy-violation    |       0 |       22 |        1 |
| redundant-validation     |      14 |        0 |        1 |
| boilerplate              |      10 |        0 |        1 |
| **Total**                | **190** |  **520** |   **33** |

Dedup notes: each overlap below is subtracted once, from the finding listed second, and the table uses the reduced counts.

- **T-1 with T-4 and T-20:** T-1 drops from 45 to 30, per its verifier's combined estimate of "about 30-35".
- **T-5 with T-7:** 8 lines overlap at tool.test.ts:23-32, per both verifiers. T-7 drops from 32 to 24.
- **T-7 with T-10:** tool.test.ts:221-223 moves into T-10's merged test. T-7 drops a further 2, to 22.
- **T-2 with T-9:** the 4-line literal at host-dialogs.test.ts:238-241 is deleted by T-2's merge. T-9 drops from 30 to 27.
- **T-8 with T-16:** one inline async request (service.test.ts:43-47 or form-service.test.ts:40-44) disappears in T-8's merge. T-16 drops from 16 to 12.

The last three deductions are my own estimates from the cited line ranges, because the verifiers said only "not additive". The disputed ask-user-4 is excluded from all totals.

### Source: boundary TUI hosts and dialog bridge (90 src)

- **ask-user-1: Unify the copy-pasted TUI overlay presenters**
  - Where: `packages/pi-ask-user/src/boundary/host-tui.ts:25-201` and `packages/pi-ask-user/src/boundary/host-form-tui.ts:12-151`
  - Proposal: Export one generic `presentDockedDialog<Outcome, Dialog>(options)` from host-tui.ts. It would own the dock, the finish latch, one AbortController authority, the bridge token, the prompt-gate recheck, the `ui.custom` factory and onHandle, ensuring cleanup and the blocked retry. Callers pass `create`, `cancelled`, `checkGate`, `retry`, `close`, and optionally `opened` and `join`. host-form-tui.ts shrinks to about 36 lines, and form's `live` flag becomes the helper's AbortController.
  - Size: 80 src / 0 test (verifier recounts ranged from 78 to 84). Risk: low. Effort: M.
  - Why behavior holds: cleanup order stays the same: revoke, dialog dispose, finish(cancel), dock.dispose, releasePrompt/bridge.clear, then the editor join. Retry conditions and error messages are unchanged. Form's `if (live)` guards are already redundant behind the finish latch. The prototype passes all 266 package tests plus the pi-mcp and pi-subagents ask-user tests.
  - Implementation notes: do not type `join` as `Promise<unknown>`, pass `opened` as `opened ? … : undefined`, and add one ARCHITECTURE.md line.
  - Spot-check: confirmed that the two hosts duplicate the state machine line for line. The scratch prototype is 226+34 lines, and that already includes ask-user-4.
- **ask-user-7: Derive `AskUserDialogBridge` from its only implementation**
  - Where: `src/boundary/host-ui.ts:12-22, 26, 42-92`
  - Proposal: Delete the 11-line interface, annotate the arrow parameters inline, and add `export type AskUserDialogBridge = ReturnType<typeof makeAskUserDialogBridge>`. This follows the sibling pattern in host-prompt.ts:42 and host-activity.ts:190.
  - Size: 10 src. Risk: none. Effort: S.
  - Why behavior holds: the change is type-only, and every user is inside the package. The only loss is the `readonly` member modifiers.

### Source: questionnaire protocol, model and validation (42 src)

- **ask-user-5: Derive `AskUserOutcome`/`AskUserAnswer` from `QuestionnaireOutcomeSchema`**
  - Where: `src/questionnaire/model.ts:3-10, 22-29` and `src/questionnaire/protocol.ts:4, 13, 78-105`
  - Proposal: In protocol.ts, add `export type AskUserOutcome = typeof QuestionnaireOutcomeSchema.Type`. model.ts then re-exports it and derives AskUserAnswer with `Extract<…>["answers"][number]`. The draft types stay.
  - Size: 14 src. Risk: none. Effort: S.
  - Why behavior holds: the change is type-only and the two types are mutually assignable. The public export name is unchanged, and pi-mcp and pi-subagents typecheck against it.
- **ask-user-10: Share one provider-query helper and delete the unused `QuestionnaireQuery`**
  - Where: `src/questionnaire/protocol.ts:203-257, 41-45`
  - Proposal: Add a private `queryProvider(events, query, sessionId, accepts)` and make relay and capability discovery one call each. Delete the unreferenced exported interface.
  - Size: 11 src. Risk: low. Effort: S.
  - Why behavior holds: last-valid-wins, the late-response latch and throw-to-undefined are unchanged. The only surface change is that the published `pi-ask-user/protocol` entry loses one type that nothing uses. `queryOwnedFormCapability` rightly stays out of the helper because its semantics differ.
- **ask-user-8: One decoder factory for three identical `try/decode(capture)` functions**
  - Where: `src/questionnaire/form-protocol.ts:161-181`
  - Proposal: Add `decodeCaptured(schema)`, then `export const decodeX = decodeCaptured(XSchema)` for each of the three decoders.
  - Size: 9 src. Risk: none. Effort: S.
  - Why behavior holds: names and signatures are unchanged (pi-mcp host-ask-user.ts:99 is unaffected), and nothing uses the functions before definition, so the TDZ is not a problem. It adds one non-failing Effect language-service message, `preferTypedSchemaDecoder`.
- **ask-user-6 (adjusted): Field-table loops in `validateAskUserRequest`**
  - Where: `src/questionnaire/validation.ts:54-99`
  - Proposal: Replace the six empty-field `if`s with `for (const field of [...] as const)` loops, move both passes to `.entries()`, and inline the key and value aliases. Keep the two passes separate.
  - Size: 8 src. Risk: none. Effort: S.
  - Why behavior holds: the message text is identical because the field names equal the message words. Check order and error precedence are unchanged, and the tests that pin the messages pass.

### Source: questionnaire services (27 src)

- **ask-user-3: Share the queued present/race/settle block between `ask` and `askForm`**
  - Where: `src/questionnaire/service.ts:66-108`, `src/questionnaire/form-service.ts:41-91` and `src/questionnaire/queue.ts:73`
  - Proposal: Add `presentQueued({ queue, activity, counter, id, admitted, present, cancelled, settle })` to queue.ts, the module that already owns the FIFO, and call it from both services.
  - Size: 19 src. Risk: low. Effort: S.
  - Why behavior holds: the order of admit, counter, Deferred, activity row, race, settle and close is unchanged. Form answer validation moves inside the presented effect. It is synchronous and fails with the same AskUserValidationError, so the row still settles as 'failed'. `host(request, owner)` is now built before admit, but every production host is lazy. Only form-service drops its Deferred import; both files drop Exit.
- **ask-user-9: Drop the explicit tuple return type on the registry admission `Ref.modify`**
  - Where: `src/questionnaire/async-service.ts:225-249`
  - Proposal: Let TypeScript infer the union from the two `as const` returns.
  - Size: 8 src. Risk: none. Effort: S.
  - Why behavior holds: `admitted` still narrows. Keep the similar controlAsync annotation in service.ts:56-58, which is load-bearing.

### Source: application (21 src)

- **ask-user-2: One local `runCurrent` for five `isCurrent ? run : reject` ternaries**
  - Where: `src/application.ts:138-145, 168-175, 183-190, 196-219`
  - Proposal: Define `runCurrent(effect, signal, message?, current = slot.isCurrent(token))` inside `onActivated`. The async start becomes `isCurrent && !canQueue ? busy : runCurrent(...)`.
  - Size: 21 src. Risk: none. Effort: S.
  - Why behavior holds: error types and messages are the same, and currency is still evaluated on each call. On async start, a non-current slot still rejects with the closed error before busy is considered. The helper stays at the named host boundary.

### Source: UI (10 src)

- **ask-user-11 (adjusted): Local render helpers in async-tool-render and a shared `selectListTheme`**
  - Where: `src/ui/async-tool-render.ts:117-124, 154, 164-169, 224-229, 239-242`, `src/ui/dialog.ts:53-62` and `src/ui/form-dialog.ts:60, 85-94, 194`
  - Proposal: Add `requestLine`, `notificationLine` and `rawResult`, typed from the existing projection ReturnTypes. Add `selectListTheme(theme, marker = "")` to ui/layout.ts using a separate `import type { SelectListTheme }` line, then use it in dialog.ts and form-dialog.ts and delete `listTheme()`. The repeatWarning constant is optional because it saves no lines.
  - Size: 10 src. Risk: none. Effort: S.
  - Why behavior holds: rendered strings and colors are identical, and the marker parameter keeps the SELECTION_MARKER placement.

### Tests: presentation and render (110 test)

- **T-ask-user-3: Scheduler wiring test via `createToolPresentationHarness` and a shared `register()`**
  - Where: `tests/compact-summary.test.ts:1-5, 285-357` and `tests/presentation-conformance.test.ts:34-52, 62-67, 132-137, 263-268`
  - Proposal: Give `register()` optional scheduler and settings arguments. Move the 73-line hand-built test into presentation-conformance as about 22 harness-driven lines, and add `detailsFor(toolName, outcome, row)` to replace three nested ternaries. compact-summary then loses its deep pi-code-previews imports.
  - Size: 45 test. Risk: low. Effort: M.
  - Why behavior holds: the harness calls the real registered renderCall and renderResult and forwards `invalidate`. The afterEach reset replaces the try/finally. Keep `toolCallTiming: false`.
  - Spot-check: confirmed. The test is a clone of pi-background-task's.
- **T-ask-user-7: tool.test.ts uses the harness instead of a hand-rolled render context**
  - Where: `tests/tool.test.ts:23-77, 158-164, 221-223, 229-230, 241-243`
  - Proposal: `captureTool` returns the ToolDefinition, and a small `render(tool, "call" | "result", value)` built on the harness at width 240 replaces `output`/`resultOutput`.
  - Size: 32 test standalone, 22 counted (overlaps T-5 and T-10). Risk: low. Effort: S.
  - Why behavior holds: rendering goes through the same shell-wrapped path, and `execute()` is still called directly. Only the registration-shape guard goes away.
  - Spot-check: confirmed the 55 lines of local fixtures.
- **T-ask-user-10 (adjusted): Fold the isolation and six-item boundary tests into their siblings**
  - Where: `tests/tool.test.ts:133-147, 192-211, 213-225, 227-257` and `tests/async-tool-render.test.ts:79-93, 160-171, 209-261`
  - Proposal: In tool.test, put the hostile getter part between 'safe' and 'second'. In async-tool-render, also add a trailing 'after' part with a matching assertion, and render `renderAsyncMessage({ content })`. Move the six-item acceptance lines into the oversized tests.
  - Size: 25 test. Risk: low. Effort: S.
  - Why behavior holds: isolation, fallback, sanitization and the 6-accepted/7-rejected bound stay asserted for both renderers.
- **T-ask-user-15: Let `summarize()` take args and phase, and fold the duplicated error-flag cancellation test**
  - Where: `tests/compact-summary.test.ts:25-33, 36-43, 47-53, 123-129, 164-170, 186-195, 267-268`
  - Proposal: Extend `summarize()` so the three tests that bypass it can use it. Loop the cancellation test over `isError` [false, true] and delete the first test.
  - Size: 18 test. Risk: none. Effort: S.
  - Why behavior holds: every input and assertion survives.

### Tests: dialog and host-dialogs (104 test)

- **T-ask-user-2 (adjusted): RPC tests get an `rpc()` helper, a hoisted `multiple` request and merged twins**
  - Where: `tests/host-dialogs.test.ts:24-39, 46-341` (including 145-155, 208-243, 246-248, 263-265, 287-289, 308-310 and 332-341) and `tests/host-form-dialogs.test.ts:47-55, 75-81, 116-123`
  - Proposal: `rpc(ui, request?, options?)` fills in the select/input/notify filler. Declare one `multiple` request instead of four. Use `it.each` for the note keep and remove twins (208-243) and for dismissal versus explicit Cancel (145-155 and 332-341), keeping that distinction in the case names. Move `scriptedSelect` to support only if host-form-dialogs keeps its dismiss-on-exhaustion semantics; otherwise leave that file alone.
  - Size: 37 test. Risk: low. Effort: M.
  - Why behavior holds: every scripted RPC path keeps its outcome assertion.
  - Spot-check: confirmed 15 hand-built RPC contexts and four `multiple` declarations.
- **T-ask-user-9: `submitted()` and `cancelled` outcome builders**
  - Where: `tests/support/questionnaire.ts:1-30`, 9 sites in `tests/dialog.test.ts` (lines 122-393) and 7 sites in `tests/host-dialogs.test.ts` (lines 60-301)
  - Proposal: Export the builders from support and add a local `chooseB` answer, spread with `{ ...chooseB, note }` for the note variants.
  - Size: 30 test standalone, 27 counted (T-2 deletes the site at 238-241). Risk: none. Effort: S.
  - Why behavior holds: the builders produce identical objects, and toEqual is unchanged.
- **T-ask-user-11: Parametrize the nonsettling-custom abort tests**
  - Where: `tests/host-dialogs.test.ts:367-383, 420-446, 448-476`
  - Proposal: Add `mountOnCustom(host, after?)` and run the two abort tests as one `it.each` over `replacement`.
  - Size: 22 test. Risk: none. Effort: S.
  - Why behavior holds: both cases keep exactly one `done` with the cancelled outcome and the surviving replacement token.
- **T-ask-user-21 (adjusted): `expectWithin` and `pageViews` helpers**
  - Where: `tests/dialog.test.ts:176-179, 242-250, 275-281, 299-303` and `tests/form-dialog.test.ts:45-51, 78-85, 107-109, 242-252`
  - Proposal: Add `pageViews(component, width, pages, { height?, join = "\n" })`. Use `join ""` for form-dialog 78-85 and 242-252, and keep a `views.every(host)` check there.
  - Size: 10 test. Risk: low. Effort: S.
  - Why behavior holds: the same bounds and reachability checks run on every page.
- **T-ask-user-19 (adjusted): Delete 'discards completed drafts when cancelled'**
  - Where: `tests/dialog.test.ts:333-340`
  - Proposal: Delete only this test, because 156-166 already covers it. Keep the width `it.each` at 396-402, or reduce it to [120]. Width 120 is the only bound check on the two-column preview layout used at width 92 and above (render.ts:210).
  - Size: 8 test. Risk: low. Effort: S.

### Tests: async-service.test.ts (82 test)

- **T-ask-user-4: Delete the standalone 'cancellation after final acknowledgement' test**
  - Where: `tests/async-service.test.ts:216-258, 753-756`
  - Proposal: Delete the test and widen line 756 to `if (prior === "none" || published)` for the no-message check. Optionally add a one-line outcome equality to the second-await branch.
  - Size: 40 test. Risk: low. Effort: S.
  - Why behavior holds: the matrix at 664-772 forces a post-publish interrupt for prior 'pending' across budgets 8 and 16 and both successor modes. 'waiter' is never published after 'sent', so the widened assertion is sound. The busy claim is still covered at 184-186.
  - Spot-check: confirmed.
- **T-ask-user-1: Extract the repeated scaffolding**
  - Where: `tests/async-service.test.ts` at 48-73, 91-94, 106-108, 120-127, 138-152, 175-178, 199-202, 218-221, 233-256, 275-280, 286-315, 328-339, 350-358, 381-391, 403-407, 458-462, 482-486, 511-515, 631-635 and 793-802
  - Proposal: Turn `statusOf` into `control(service, action, requestId?)`. Add a `startMounted()` helper or a `mounted` fixture option. Hoist `immediateHost` and `failingDelivery(attempts)` to module scope, and let `acquireService` take an optional explicit Scope. Skip `interruptAfterCommit` if T-4 lands, because it would have one caller left.
  - Size: 45 test standalone, 30 counted (with T-4 and T-20). Risk: none. Effort: M.
  - Why behavior holds: every assertion, pause point, scheduler budget and TestClock step stays. The test at 191 compares a whole `{ requests }` result, so both sides must use the helper.
  - Spot-check: confirmed all the repeated blocks.
- **T-ask-user-20: Merge the two retention tests**
  - Where: `tests/async-service.test.ts:456-478, 480-507`
  - Proposal: Run the concurrent `startAsync` plus await-of-oldest step, under MaxOpsBeforeYield 16, after the MAX+3 eviction loop.
  - Size: 12 test. Risk: low. Effort: S.
  - Why behavior holds: the registry state after the loop is identical to the second test's setup, with the oldest retained ID being `ids[3]`.

### Tests: shared support fixtures (70 test)

- **T-ask-user-5: Reuse the support theme and opaque fixture; share the event-bus and activity fakes**
  - Where: `tests/tool.test.ts:23-32`, `tests/presentation-conformance.test.ts:10-16`, `tests/async-tool-render.test.ts:11-12`, `tests/async-delivery.test.ts:14-15`, `tests/proxy.test.ts:29-44`, `tests/host-form-proxy.test.ts:19-34`, `tests/activity.test.ts:10-35`, `tests/form-service.test.ts:160-170` and `tests/support/host.ts:7-29`
  - Proposal: Import `theme` and `opaqueHostFixture` from support. Add `makeEventBus()` and `makeActivityFixture()` to tests/support and use them in the four files that clone them.
  - Size: 38 test. Risk: none. Effort: S.
  - Why behavior holds: the two buses are byte-identical, and the support theme is a superset of the local ones.
  - Spot-check: confirmed.
- **T-ask-user-14: Move the no-UI owned-form advertisement test onto the application harness**
  - Where: `tests/host-form-tui.test.ts:8-10, 122-154` and `tests/application.test.ts:71-85`
  - Proposal: Add `events: makeEventBus()` to the harness and assert that `queryOwnedFormCapability` returns undefined when there is no UI. Depends on T-5.
  - Size: 20 test. Risk: none. Effort: S.
  - Why behavior holds: the test still runs through the real registration path. Other tests are unaffected because the capability code is skipped without a session ID.
- **T-ask-user-16: Hoist `formOwner`, `emptyForm` and `asyncRequest` into support/questionnaire.ts**
  - Where: `tests/form-dialog.test.ts:17`, `tests/form-service.test.ts:13-20, 40-44`, `tests/host-form-dialogs.test.ts:11`, `tests/host-form-proxy.test.ts:12-18`, `tests/host-form-tui.test.ts:12-13`, `tests/application.test.ts:115-127` and `tests/service.test.ts:43-47, 104-108, 120`
  - Proposal: Export the three fixtures from support and import them. Keep `operationId: "operation"`.
  - Size: 16 test standalone, 12 counted (overlaps T-8). Risk: none. Effort: S.
  - Why behavior holds: the values are identical. The dialogs and TUI files use different 'o'/'r' IDs, but no assertion reads them.

### Tests: TUI ownership and application (51 test)

- **T-ask-user-6 (adjusted): `openPresentation` and `waitMounted` helpers**
  - Where: `tests/tui-ownership.test.ts:36-42, 68-75, 87-93, 110-117, 133-141, 355-357` and `tests/host-form-tui.test.ts:18-27, 54-61, 76-83`
  - Proposal: Add the helpers to tests/support/host.ts and use the combined start-and-wait form at these sites. host-form-tui 101-111 keeps its explicit pre-mount `customCalls`/`gate.ended` sequence.
  - Size: 30 test. Risk: low. Effort: M.
  - Why behavior holds: the helper stops before `onHandle`, so each test still controls mount timing.
- **T-ask-user-17 (adjusted): `openMounted` and `tuiHarness` in application.test.ts**
  - Where: `tests/application.test.ts:229-245, 278-299, 340-356, 364-386`
  - Proposal: Use `openMounted` at 242-245, 294-299, 353-356 and 383-386, not at 413-418, which must keep its `customCalls === 2` wait so it does not call the stale first mount. Add `tuiHarness` with pass-through overrides.
  - Size: 12 test. Risk: low. Effort: S.
- **T-ask-user-22: Remove the duplicate coalesced-prompt gate test**
  - Where: `tests/tui-ownership.test.ts:392-401` and `tests/host-ui.test.ts:13-39`
  - Proposal: Delete the tui-ownership test and add a `canOpen()` assertion to host-ui.test.
  - Size: 9 test. Risk: none. Effort: S.
  - Why behavior holds: `canQueue = own || canOpen()`, so host-ui already proves the gate stays closed.

### Tests: protocol and validation (46 test)

- **T-ask-user-13: Table-drive validation.test.ts and assert positions instead of exact messages**
  - Where: `tests/validation.test.ts:57-95, 97-129`
  - Proposal: One table of `[mutate, position, reasonWord, privateStrings]` rows. Include the 'empty <field>' reason so the blank-before-duplicate ordering stays asserted.
  - Size: 22 test. Risk: low. Effort: S.
  - Note: these are agent-facing messages, so dropping exact equality is optional rather than required by the testing policy.
- **T-ask-user-18: Table-drive the decoder rejections and add an `askFails` helper**
  - Where: `tests/form-protocol.test.ts:11-54` and `tests/proxy.test.ts:51-77, 117-183, 208-220, 303-309`
  - Proposal: Loop each decoder over its rejected inputs and add a local `askFails` helper for the repeated failure blocks. The accessor-touch check stays separate.
  - Size: 18 test. Risk: none. Effort: S.
- **T-ask-user-23 (adjusted): Merge the email and URI rejection `it.each` blocks**
  - Where: `tests/form-validation.test.ts:73-132`
  - Proposal: One `it.each` over `[format, value]` pairs.
  - Size: 6 test. Risk: none. Effort: S.

### Tests: service FIFO (35 test)

- **T-ask-user-8: Merge the duplicated FIFO 'cancelled queued caller never mounts or steers' tests**
  - Where: `tests/service.test.ts:27-88` and `tests/form-service.test.ts:22-79`
  - Proposal: One test that passes the activity observer as the 4th layer argument and the form host as the 5th, then admits async, cancelled owned and form callers, and live owned, ordinary and form callers.
  - Size: 35 test. Risk: low. Effort: M.
  - Why behavior holds: every assertion from both tests survives, and the observer works with a form host because `admittedForm` is optional.
  - Spot-check: confirmed the two scripts match (about 120 lines become about 75-85).

### Tests: external-editor.test.ts (22 test)

- **T-ask-user-12: Extract an `editorScript(source, name?)` fixture that reuses `makeTuiHost().tui`**
  - Where: `tests/external-editor.test.ts:15-26, 31-40, 57-69, 86-94, 113-124, 138-150`
  - Size: 22 test. Risk: none. Effort: S.
  - Why behavior holds: the same real-process coverage remains.

### Structural notes (unverified)

- **Owned-call registries (about 0 LOC):** host-proxy.ts and host-form-proxy.ts are parallel owned-call registries. The finders prototyped shared helpers, and the code grew by 14 lines because check ordering and error mapping differ. Not recommended.
- **Hostile-input detachment (about 40 LOC):** protocol.ts uses Raw\* structs with captureArray, and form-protocol.ts uses a bounded `capture()`. Unifying them would need parameterized bounds, because a 6×4 questionnaire with 4000-char previews exceeds 64 KiB. It would also change whether accessor-bearing and class-instance inputs are accepted.
- **Double validation of owned forms (about 10 LOC):** host-form-proxy and form-service.askForm both decode and validate the request and outcome. Removing one copy would move coverage and change which layer rejects, and so whether the Activity row reads failed or submitted.
- **`metadata` helper (about 6 LOC):** host-delivery.ts `metadata` reimplements `projection` from ui/tool-render-projection.ts. Reusing it needs a boundary-to-ui import or a moved helper.
- **Combined source prototype (about 220 LOC):** all source findings together touched 18 files (+411/−626, about 215 net, plus 5 for QuestionnaireQuery). tsc, oxlint --deny-warnings, oxfmt, 266/266 tests and effect-tsgo are clean, and the pi-subagents and pi-mcp ask-user tests pass (31 and 29). This total includes the disputed ask-user-4.
- **Cross-package event-bus fake (about 40 LOC):** pi-background-task and pi-subagents also clone the multi-listener event-bus fake from T-5, in their activity-provider tests. testing.md favors pi-cosmic-core/testing over pi-ask-user/tests/support.
- **pi-code-previews test helpers (about 120 LOC):** the scheduler wiring test clones pi-background-task/tests/compact-summary.test.ts:494-554. Also, 19 test files in 7 packages deep-import pi-code-previews config state and defaults. `withCodePreviewSettings(overrides, fn)` and a scheduler-conformance helper in pi-code-previews/testing would cover both.
- **Per-renderer projection tests (about 25 LOC):** shared projections are tested once per renderer (single-vs-list precedence, hostile-part isolation). One focused projection test could replace some copies. T-10 already folds part of the isolation duplication.

### Needs a decision

- **ask-user-4 (split, confirmed/rejected): Use the thunk form of `Effect.try` in four best-effort cleanup sites**
  - Where: `src/boundary/host-activity.ts:12, 45-55`, `src/boundary/host-form-dialogs.ts:161-166`, `src/boundary/host-tui.ts:98-105` and `src/boundary/host-form-tui.ts:44-65`
  - Size: 19 src on top of ask-user-1, or 27 on its own.
  - For: `Effect.ignore` without `log` discards the typed AskUserHostError, so the four messages are dead. host-external-editor.ts already uses the thunk form, and the prototype is clean.
  - Against: docs/architecture/effect-v4.md prescribes `Effect.try` with a schema-backed boundary error that is recovered on purpose. The workspace has about 91 `Effect.try({` sites against 5 thunk uses, which makes host-external-editor the exception. The typed error keeps failures redacted and ready for future logging.
  - Decision needed: does that convention apply to best-effort cleanups whose failures are swallowed?
