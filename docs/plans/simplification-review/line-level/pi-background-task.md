## pi-background-task

pi-background-task has 4,439 source LOC and 4,657 test LOC (`wc -l` over `src/` and `tests/` at 1a866fa). Verification confirmed 26 findings: 11 in source and 15 in tests. None were disputed, and one (T-background-task-16) was dropped. No two findings target the same code, so deduplication merged nothing. The removable total is **139 source LOC and 676 test LOC**. Source savings are small and spread out. The largest are the Code Mode protocol's repeated bounded-string schemas (22), reusing core's `makeScopedConfigStore` (18) and a single copy of the action and state vocabularies (15). Most removable lines are in tests: repeated render scaffolding that `createToolPresentationHarness` already covers, `it.each` rows that only re-test the output schema, tests whose coverage duplicates a sibling test, and hand-written call chains in the task-service and local-process suites. I spot-checked the 8 largest findings (T-1, T-3, T-4, T-2, T-6, T-11, T-5, T-10) against the code, and all of them hold. None were demoted.

| Category                 | Src LOC | Test LOC | Findings |
| ------------------------ | ------: | -------: | -------: |
| test-redundancy          |       0 |      356 |        7 |
| test-fixture-duplication |       0 |      153 |        4 |
| verbose-code             |      42 |       97 |        6 |
| shared-helper-reuse      |      31 |       70 |        3 |
| duplication              |      37 |        0 |        3 |
| indirection              |      17 |        0 |        2 |
| boilerplate              |      12 |        0 |        1 |
| **Total**                | **139** |  **676** |   **26** |

Ordering notes: the figures are additive, but several findings are measured or written on top of others.

- bt-3 was measured on top of bt-2, and bt-5 after bt-4.
- T-4 relies on T-5's `registeredTool` helper. It also takes over T-1's leftover `animationFixture` and `AnimationCallback` and counts their removal.
- T-6 deletes two tests whose fork and exit-wait calls were included in T-7's scratch measurement. T-7's 35 does not count its unmeasured `emitAndRead` savings, which offset that overlap.
- T-8 and T-9 both edit compact-summary.test.ts:79-112, but for different lines: T-8 folds in a test, T-9 removes the casts.

Paths are relative to `packages/pi-background-task/` unless noted. "bt-N" is `background-task-N`, and "T-N" is `T-background-task-N`.

### Tests: compact summary and tool presentation (13 src, 290 test)

- **T-1: Delete the compact-summary renderer it.each that repeats the conformance collapse/expand check**
  - Where: `tests/compact-summary.test.ts:405-492`, `tests/presentation-conformance.test.ts:30-45`
  - Proposal: Delete the 88-line it.each. Add the unique fixtures (logs exited, logs failed, status exited code 2) as rows in the conformance `fixtures` array, and wrap that test's `args` in `Object.freeze`.
  - Size: 0 src / 84 test. Risk: low. Effort: S.
  - Why behavior holds: presentation-conformance.test.ts:47-108 already registers the real tool and checks that the body is hidden when collapsed and shown when expanded, and that the result is unchanged, across every mode, style and isError value. The frozen args keep the args-immutability check.
  - Spot-check: confirmed. Conformance lines 91-105 make the same assertions.
- **T-4: Use `createToolPresentationHarness` for the hand-rolled compact-expansion and scheduler render tests**
  - Where: `tests/compact-expansion.test.ts:1-79`, `tests/compact-summary.test.ts:399-403, 494-556`
  - Proposal: Move the logs-cursor test into presentation-conformance using the harness (about 35 lines instead of 78), and delete compact-expansion.test.ts. Rewrite the scheduler test with `harness.call(args, { executionStarted: true, isPartial: true, invalidate })` and `harness.result(done)` (about 30 lines instead of 63). Drop `animationFixture`, `AnimationCallback` and the now-unused imports.
  - Size: 0 src / 70 test (verifier recount about 75). Risk: low. Effort: M. Depends on T-5 (helper) and T-1.
  - Why behavior holds: the same assertions remain: the cursor header appears once, all log lines are present, the result is unchanged, the owner's scheduler is used, ticks invalidate, and settling releases the scheduler. The harness forwards `() => context.invalidate()`, so an overridden invalidate still counts. The `registerMessageRenderer` stub is dead code.
  - Spot-check: confirmed against pi-code-previews/src/testing/tool-presentation.ts. `result()` flips isPartial to false, which is the settle transition the release assertion needs.
- **T-5: Collapse the two single-warning conformance tests into one it.each with a shared registration helper**
  - Where: `tests/presentation-conformance.test.ts:47-63, 110-156, 158-201`
  - Proposal: Add `registeredTool(mode, style, runner?)`, which sets the preview settings, registers, and returns the tool. Replace tests 2 and 3 with `it.each` over `{ args, details, marker, once(expanded) }`, and use the helper in test 1 too.
  - Size: 0 src / 40 test. Risk: none. Effort: S.
  - Why behavior holds: the assertions and fixtures are unchanged: each warning appears once when collapsed and when expanded, per-task attribution holds, the raw-output label is present, and results are unchanged. The merged test is slightly stricter, since test 3 now also checks for its marker.
  - Spot-check: confirmed. Tests 2 and 3 are structural clones, each with an 8-line registerTool capture.
- **T-8 (adjusted): Remove compact-summary semantic tests that repeat the status it.each**
  - Where: `tests/compact-summary.test.ts:150-170, 379-396, 127-133, 79-94`
  - Proposal: Delete 150-170 and 379-396. Add one multi-state counter assertion to the 46-78 list test (`counters` has length 1 and contains "2 exited" and "1 stopping"). Fold 127-133 into 79-94. If substring checks move to issue codes, keep the earliest/next cursor value check at 302-304.
  - Size: 0 src / 38 test. Risk: low. Effort: S.
  - Why behavior holds: per-state outcomes stay covered by the it.each at 171-184 and by 185-197. The added assertion keeps multi-state counter aggregation (compact-summary.ts:250-257), which 379-396 was the only test to cover.
- **T-9: Call the pure projection directly and add logs/wait detail builders**
  - Where: `tests/compact-summary.test.ts:9-43, 79-112, 209-275, 277-378`
  - Proposal: Make `project` call `projectBackgroundTaskCompactSummary({ phase, args, result: { details }, isError })` directly. This drops the 12-field context and the two `as Input["context"]` casts. Add `logs(state, fields, truncation?)` and `wait(outcome, snapshot, fields)` builders with shared cursor defaults.
  - Size: 0 src / 38 test. Risk: low. Effort: S.
  - Why behavior holds: the projection under test is unchanged, and the wrapper's isError forwarding is still exercised by presentation-conformance, which renders with isError true and false. Combined with T-14, isError forwarding is no longer unit-tested directly, which the verifiers judged low risk.
- **T-14: Drop the wrapper-equivalence check in code-mode-presentation**
  - Where: `tests/code-mode-presentation.test.ts:3-6, 93-112`
  - Proposal: Delete the 20-line block that asserts the one-line `backgroundTaskCompactSummary` forwarder equals the pure projection, along with its import. Keep `pure`.
  - Size: 0 src / 20 test. Risk: none. Effort: S.
  - Why behavior holds: receipt-to-summary parity is still asserted against `pure`, and the registered wrapper still runs end to end in presentation-conformance.
- **bt-3: Extract repeated compact-summary notices and the non-zero-exit test**
  - Where: `src/ui/compact-summary.ts:80-188, 326-348`
  - Proposal: Add `logLossNotice(id, bytes)`, `cleanupUnconfirmedNotice(id)` and `runtimeTimeoutNotice(id)`. Merge the double `droppedBytes > 0` check in `cursors()`, and use `const nonZeroExit = value.exitCode != null && value.exitCode !== 0`. The logs case uses `state === "timed_out" ? runtimeTimeoutNotice(id) : {failed}`.
  - Size: 13 src / 0 test (measured on top of bt-2). Risk: none. Effort: S.
  - Why behavior holds: notice text, codes, kinds, descriptions and push order are unchanged. A differential test over more than 1,000 projection cases found deep-equal results.

### Code Mode door and adapter (70 src, 162 test)

- **bt-1: Factor the repeated bounded-string and task-id schemas in the protocol**
  - Where: `src/code-mode/protocol.ts:31-112`
  - Proposal: Add `maxChars(maximum)` and `TaskId` (min 1, max `maxIdChars`, in the same order) and use them for the 10 inline max-length fields and the 3 output `id` fields. The input `id` keeps its max-only check.
  - Size: 22 src / 0 test (301 to 279 lines after oxfmt). Risk: none. Effort: S.
  - Why behavior holds: `Schema.toJsonSchemaDocument` for the input, output and presentation schemas is byte-identical, so the guest contract pi-code-mode consumes does not change.
- **bt-2: Keep one copy of the task action and task state lists**
  - Where: `src/tools/schema.ts:5-14`, `src/code-mode/presentation.ts:18-27`, `src/code-mode/protocol.ts:36-44, 99`, `src/task/model.ts:1-8`, `src/ui/compact-summary.ts:14-23, 252`, `src/task/bounds.ts:1-11`
  - Proposal: Move `BACKGROUND_TASK_ACTIONS` and a new `BACKGROUND_TASK_STATES` (`as const`) into the import-free `task/bounds.ts`. Use them in `StringEnum`, `Schema.Literals`, and the compact-summary counter loop, and derive `BackgroundTaskState` in model.ts with `import type`. Widen the ARCHITECTURE.md sentence on what bounds.ts owns.
  - Size: 15 src / 0 test (1081 to 1066 lines across 6 files). Risk: none. Effort: S.
  - Why behavior holds: the literals and their order are the same, so JSON Schema documents, TypeBox enums and counter order are unchanged. bounds.ts has no imports, so no cycle appears. The literals cannot live in protocol.ts, which would create a cycle.
- **bt-4: Use pi-cosmic-core `freezeSnapshot` instead of the local `deepFreeze`**
  - Where: `src/code-mode/output.ts:85-98, 114-117`
  - Proposal: Delete `deepFreeze` and return `{ _tag: "Accepted", output: freezeSnapshot(decoded) }`.
  - Size: 13 src / 0 test (117 to 104 lines). Risk: low. Effort: S.
  - Why behavior holds: the schema-decoded output is plain data, so core's ProjectionError paths cannot be reached. The result is still deep-frozen and the caller's input is not. The only cost is one extra clone of an already size-bounded value.
- **bt-5: Build the logs guest output by removing `events` instead of copying fields**
  - Where: `src/code-mode/output.ts:14-30`
  - Proposal: `const { events: _events, ...logs } = details.logs; return { action: details.action, text: result.text, logs };` for logs, and `{ text, ...details }` otherwise. 17 lines become 6.
  - Size: 11 src / 0 test (104 to 93 lines, measured after bt-4). Risk: none. Effort: S.
  - Why behavior holds: `BackgroundLogSlice` has exactly the six keys, so the admitted JSON byte length is identical. `truncation` sits on `details`, not on `details.logs`, so it is still left out. The same rest-omit pattern already appears in local-process.ts.
- **bt-6: Reuse `containThenable` in `observeBackgroundTaskPresentation`**
  - Where: `src/code-mode/protocol.ts:232-246`, `src/code-mode/presentation.ts:152-172`
  - Proposal: Move `containThenable` into presentation.ts, which protocol.ts already imports from, and export it. Shorten observe to `try { if (isFunction(observer)) containThenable(observer(receipt)); } catch {}`.
  - Size: 9 src / 0 test (473 to 464 lines). Risk: none. Effort: S.
  - Why behavior holds: the narrowing, the no-op `then.call` and the swallowing are the same. The public `src/protocol.ts` door does not re-export the helper.
- **T-3: Remove code-mode-output tests that repeat output-schema and allowance checks**
  - Where: `tests/code-mode-output.test.ts:137-191, 215-221, 85-105, 20-54`
  - Proposal: Delete the non-Natural-numeric it.each (137-191) and the text-allowance test (215-221). Replace the 21-line spawn-error test with one row in the round-trip table at 20-54.
  - Size: 0 src / 80 test. Risk: low. Effort: S.
  - Why behavior holds: the output schema's numeric constraints are tested in code-mode-protocol.test.ts:110-142. Lines 204-213 remain the proof that a decode failure becomes Refused, and allowance refusal stays in 56-66 and 193-202. The table's `toEqual` still round-trips `error`.
  - Spot-check: confirmed. `projectBackgroundTaskCodeModeOutput` only checks byte fit and decodes the schema, and the protocol test's `invalidOutputs` exercise the same schema.
- **T-2 (adjusted): Shrink the Code Mode capability lifecycle test**
  - Where: `tests/application.test.ts:434-617` (446-452, 454-473, 477-534, 536-560)
  - Proposal: Add `discover(sessionId)`, `nested(input, max = 4_096)` and `topLevel(input)` helpers. Delete the command-too-large and name-too-large start rows and the empty-list block at 536-560. **Keep** the respond-rejection check at 446-452 and the id-too-large row.
  - Size: 0 src / 60 test. Risk: low. Effort: M.
  - Why behavior holds: service and `startOutputFits` enforce the command and name bounds, and the protocol test covers them. The kept rows are the only proof that the listener uses the containing `respond` and that the adapter decodes input. Session scoping, shared state, deactivation and revocation all stay.
  - Spot-check: confirmed. The test is 184 lines, and 17 row lines, 25 empty-list lines and six 6-10 line execute calls make 60 plausible.
- **T-13: Use small factories in the normalizer rejection test**
  - Where: `tests/code-mode-protocol.test.ts:165-218`
  - Proposal: Add `query(fields)` and `capability(fields)` base factories and loop over the invalid overrides. Keep the boundary-accepted cases and the hostile-getter literal explicit, because spreading would evaluate the getter.
  - Size: 0 src / 22 test. Risk: none. Effort: S.
  - Why behavior holds: the same accept and reject cases run through the same normalizers.

### Task service and local process (20 src, 127 test)

- **T-6: Delete four task-service tests that other tests already cover**
  - Where: `tests/task-service.test.ts:484-498, 519-532, 851-859, 875-886`
  - Proposal: Delete "returns completed when a task exits before an output match", "interrupts a wait without mutating the task", "enforces active capacity" and "rejects starts after the service scope closes".
  - Size: 0 src / 52 test. Risk: low. Effort: S.
  - Why behavior holds: these are covered by 419-466 (output wait, then exit, then completed/exited), 215-237 (interrupted waiters leave the task running), 618-647 (a stricter capacity test with the error tag, while the slot is held by a stopping task) and lifecycle-stress.test.ts:243-245 (BackgroundRuntimeClosedError after close, in every iteration).
  - Spot-check: confirmed for all four overlaps.
- **T-10: Add spawn and collect-until-exit helpers for the live local-process tests**
  - Where: `tests/local-process.test.ts:18-19, 305-509`
  - Proposal: Add `spawn(command, overrides = {})` (cwd ".", 64 KiB ingress by default) and `collectUntilExit(handle)`, and rewrite the ten live tests to use them.
  - Size: 0 src / 40 test. Risk: none. Effort: S.
  - Why behavior holds: this is a mechanical refactor. Commands, ingress overrides (1,024), timeouts and assertions are the same. `Effect.result` wrapping and the scope-release test's own layer still work.
  - Spot-check: confirmed. There are 11 `yield* LocalProcess` sites and four 7-line `Effect.all` collect blocks.
- **T-7: Add fork, exit-wait and emit-and-read helpers to task-service tests**
  - Where: `tests/task-service.test.ts` (161-170, 196-202, 227-229, 253-270, 382-386, 400-409, 472-474, 504-506, 572-578, 591-608, 625-627, 718-763, 818-823)
  - Proposal: Add `const forkNow = Effect.forkScoped({ startImmediately: true })`, `exitWait(id, waitSeconds = 30)` next to `outputWait`, and `emitAndRead(service, control, id, afterCursor, text, stream)`.
  - Size: 0 src / 35 test (forkNow and exitWait alone: 887 to 853). Risk: none. Effort: S.
  - Why behavior holds: each helper runs the same Effect sequence, so timing, TestClock and ownership assertions are unchanged. The verifier found 27 fork sites, not the 30 the finder reported.
- **bt-8: Add an invalid-command error helper for the service validation checks**
  - Where: `src/task/service.ts:461-484, 619-650, 102`
  - Proposal: Add `const invalidCommand = (message) => new InvalidBackgroundCommandError({ message })` and write each of the 8 checks as `if (...) return yield* invalidCommand("...")`, without braces.
  - Size: 12 src / 0 test (verifier scratch runs measured 14 and 15). Risk: none. Effort: S.
  - Why behavior holds: the error class, messages, check order and short-circuiting are the same. `return yield*` keeps the Effect diagnostics unchanged.
- **bt-11: Remove trivial indirections in the task service and log buffer**
  - Where: `src/task/log-buffer.ts:27-29`, `src/task/service.ts:538, 564-579, 746, 787-796`, `tests/log-buffer.test.ts:7-48`
  - Proposal: Replace `LogBuffer.empty()` with `new LogBuffer()`. Set `stop: requestStop`. Write the list filter as `filter === "all" || isActiveTaskState(s.state) === (filter === "active")`.
  - Size: 8 src / 0 test (the 4 test call sites keep the same line count). Risk: none. Effort: S.
  - Why behavior holds: the contract type still hides `requestStop`'s defaulted `outcome` parameter, and no caller passes a third argument. The filter results are identical for every value.

### /tasks command and manager UI (9 src, 72 test)

- **T-11: Merge the two /tasks command harnesses, table the action-failure tests, and drop the core-duplicate notify test**
  - Where: `tests/application.test.ts:80-99, 153-250, 681-692, 705-742`
  - Proposal: Add one `tasksCommandHarness({ tasks?, actions? })` whose vi.fn `custom` captures the surface lazily, and have status tests assert `custom` was not called. Make the stop and clear feedback tests one `it.effect.each`. Delete 681-692, and replace `extensionContextFixture` with `hostFixture<ExtensionContext>`.
  - Size: 0 src / 50 test. Risk: low. Effort: M.
  - Why behavior holds: the controller routes `status` before any `ctx.mode` check (controller.ts:148-150), so a TUI-mode harness still proves status never opens the manager. Notification-rejection containment is tested in pi-cosmic-core host-session.test.ts:37-57. The merged harness must open the surface lazily, so status tests do not hit the "did not open synchronously" throw.
  - Spot-check: confirmed. The harnesses repeat the ctx, registerCommand and bridge wiring, and the two feedback tests differ only in action, state and keys.
- **T-12: Remove manager-component tests that other stop-confirmation and navigation tests cover**
  - Where: `tests/manager-component.test.ts:99-106, 241-254`
  - Proposal: Delete "stops a task only on the second x press" and "opens the inspector on Enter, returns on Esc, and closes on the next Esc".
  - Size: 0 src / 22 test. Risk: low. Effort: S.
  - Why behavior holds: these are covered by 71-93 and 125-135 (two-press stop, first press a no-op, the stopped id) and by 209-239 and 256-274 (Enter and Esc visibility, and close on the second Esc at five widths).
- **bt-9: Replace the manager's state switch with a lookup table**
  - Where: `src/ui/manager.ts:60-85`
  - Proposal: Add a `STATE_PRESENTATION` table keyed by state, one line per state with a glyph function, and a 4-line accessor that calls `glyph(frame)`. This is the same pattern as pi-subagents RUN_STATUS.
  - Size: 9 src / 0 test (a verifier scratch run measured 12). Risk: none. Effort: S.
  - Why behavior holds: each state keeps its glyph, color and label, and indexing by `BackgroundTaskState` still fails to compile if a state is missing.

### Config and runtime wiring (27 src)

- **bt-7 (adjusted): Build the config store on the shared `makeScopedConfigStore`**
  - Where: `src/config/store.ts:18-84`
  - Proposal: Replace the internals with `makeScopedConfigStore({ errorFactory, label, spanPrefix: "BackgroundTaskConfig", projectConfigDirectory, basename: "pi-background-task.json", decode: (value) => decodeConfig(value), resolve: (metadata, project, global) => ({ ...metadata, ...normalizeConfig({ ...global, ...project }) }) })`, with no `defaultDocument`. The layer becomes `Layer.effect(this, AgentDirectory.use((d) => store.resolveConfig(cwd, d, projectTrusted)))`. Drop the helper imports, `mapDocumentError` and `CONFIG_BASENAME`. Pass `decode` as a lambda: the generic `decodeConfig` breaks inference.
  - Size: 18 src / 0 test (85 to 62 lines). Risk: low (verifiers; the finder said medium). Effort: S.
  - Why behavior holds: trust gating (no project I/O when untrusted), the overlay, normalization and the error types are unchanged. Four packages already use the helper. The observable differences are that the log-warning wording and span names change, the two documents are read concurrently, and the service value carries five metadata fields that nothing reads.
- **bt-10 (adjusted): Drop the single-field layer options object and the duplicated runner type**
  - Where: `src/layer.ts:17-24, 33`, `src/application.ts:62-69`, `src/boundary/host-code-mode.ts:9, 42-45`
  - Proposal: Pass `publish` directly to `makeBackgroundTaskLayer` and delete `BackgroundTaskLayerOptions`. Type `run` as `BackgroundTaskToolRunner["run"]`, and delete the now-unused `effect/Path` import and the `BackgroundTaskService` value import (which otherwise fails with TS6133).
  - Size: 9 src / 0 test (verifier scratch: 11). Risk: none. Effort: S.
  - Why behavior holds: only types and wiring change, and nothing outside these files imports the removed names.

### Cross-package test kit (25 test)

- **T-15: Share the activity host fake with pi-subagents**
  - Where: `tests/activity-provider.test.ts:30-60`, `packages/pi-subagents/tests/activity-provider.test.ts:19-49`
  - Proposal: Publish `fakeActivityHost(sessionId)` from a Vitest-free pi-cosmic-ui test subpath, such as `./activity/testing`, and import it in both packages.
  - Size: 0 src / 25 test, net and workspace-wide: about 62 test lines removed and about 33 lines added in pi-cosmic-ui. Risk: none. Effort: M.
  - Why behavior holds: the fake is line-for-line identical in both packages. The costs: it needs a package.json exports entry and an ARCHITECTURE.md note, and the subpath ships because pi-cosmic-ui publishes `src/`.

### Structural notes (unverified)

- Code Mode capability plumbing is duplicated across packages: `decodeSafely` (in pi-background-task, pi-mcp and pi-cosmic-ui), a byte-equivalent `containThenable` and versioned query normalizer (pi-mcp), and the host adapter skeleton (`makeMcpCodeModeHost`). Shared pi-cosmic-core helpers would remove about 70 LOC. This is cross-package and would supersede bt-6's local move.
- task/model.ts interfaces (the snapshot, wait result and log metadata types) repeat protocol schemas field for field. Deriving them with `Schema.Type` would save about 25 LOC, but it reverses the documented ownership, so it needs an ownership decision first.
- The TypeBox tool parameters in tools/schema.ts mirror `BackgroundTaskCodeModeInputSchema` (about 70 LOC). Generating one from the other would change the model-visible tool JSON Schema, so this is not proposed.
- The compact-summary `Details` schema (about 40 LOC) is deliberately lenient so tool results from older sessions still render. Keep it separate.
- `TaskManagerComponent` render and handleInput nearly duplicate pi-subagents fleet.ts:467-520. This could move into pi-cosmic-ui `ListDetailShell` (about 20 LOC, cross-package).
- The keybinding-label adapter is written out at about 7 call sites across 4 packages. A pi-cosmic-ui helper would save about 30 LOC.
- The fake LocalProcess and service layers in task-service.test.ts and lifecycle-stress.test.ts could share a support file (about 45 LOC), but merging risks weakening the stress-test semantics.
- The owner-scheduler wiring test is cloned in pi-ask-user and pi-subagents. A pi-code-previews/testing helper would save about 25 LOC, cross-unit. See T-4.
- The manager-component resize and reachability test clones pi-subagents fleet-component.test.ts:81-105. Testing it once in list-detail-shell.test.ts would save about 20 LOC.
- The `/tasks` suites in application.test.ts test settings/controller.ts. Moving them to a controller test file is 0 LOC and only puts the tests next to their subject.
- The duplicated `renderResult`/`expandedContent.renderResult` extraction in tools/background-task.ts is not a reduction: the helper draft came out 2 lines longer.

### Needs a decision

No findings were disputed and no spot-checks failed. These confirmed findings still carry a trade-off the maintainer should accept explicitly:

- **bt-7:** the read-failure warning wording changes, span names change, and the two documents are read concurrently rather than one after the other. The verifiers judged none of this observable from the tool or UI.
- **bt-2:** `task/bounds.ts` grows from "character limits" into the shared action and state vocabulary, so ARCHITECTURE.md needs its ownership sentence widened.
- **T-9 with T-14:** together they remove the last direct unit check of the wrapper's `isError` forwarding. Coverage continues through presentation-conformance and the shell's error reconciliation.
- **T-15:** this adds a published, Vitest-free test-kit subpath to pi-cosmic-ui, which becomes a new public surface.
- Rejected in verification: T-16, which would have removed internal-call assertions in config.test.ts. The trusted test's recorded `exists:`/`read:` operations are the positive control for the untrusted no-project-I/O security test, and the remaining savings were below the threshold.
