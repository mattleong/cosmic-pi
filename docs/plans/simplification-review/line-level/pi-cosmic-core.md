## pi-cosmic-core

The 43 confirmed findings reduce to 41 entries, which together remove about **386 source lines and 606 test lines** (net, using the verifiers' conservative figures). Two pairs were merged because they rewrite the same code: core-rest-2 with T-core-2, and core-platform-3 with T-core-7. Three partial overlaps are counted once: core-rest-4 is counted at 9 lines after core-rest-3, core-rest-7's test lines are counted at 6 after T-core-4, and T-core-15 is counted at 17 after core-platform-2. The 8 largest entries were spot-checked against the code. All 8 held, so none were demoted.

The largest source reductions are:

- deriving the duplex option types from their defaults (45)
- removing the test-only `updateObject` (42)
- sharing the process-group helpers (32)
- making `modifyObject` required (30)

Most of the test reduction comes from sharing fixtures; T-core-1 alone removes 90 lines.

**API narrowing.** 11 confirmed findings, worth about 211 source lines, narrow published types or signatures but remove no export name: core-rest-3, 5, 6, 7, 8 and 10, and core-platform-1, 2, 3, 11 and 13. The maintainer should accept that narrowing and record it in the change notes. Three disputed findings would delete public exports or reverse a documented decision; they are listed under "Needs a decision".

**Other packages.** The source totals include small edits in pi-mcp, pi-better-openai, pi-better-xai, pi-cosmic-ui, pi-code-previews and pi-subagents. Those edits must land in the same change as the core edit.

The T-core figures are net test lines. T-core-15 and T-core-16 include the small helpers they add under `src/testing/`.

| Category                 | Entries | Src LOC | Test LOC |
| ------------------------ | ------: | ------: | -------: |
| dead-code                |       7 |     116 |      109 |
| verbose-code             |       7 |     100 |       50 |
| duplication              |       5 |      72 |        8 |
| over-generalization      |       3 |      35 |       10 |
| redundant-validation     |       1 |      30 |       25 |
| shared-helper-reuse      |       3 |      18 |       17 |
| indirection              |       1 |       8 |        0 |
| test-policy-violation    |       3 |       7 |       44 |
| test-fixture-duplication |       6 |       0 |      230 |
| test-redundancy          |       4 |       0 |       93 |
| boilerplate              |       1 |       0 |       20 |
| **Total**                |  **41** | **386** |  **606** |

A merged entry is filed under the category of its source-side finding. Paths are relative to `packages/pi-cosmic-core/` unless they name another package.

### JSON document store (platform/json-document, schema-document, testing/layers): src 97 / test 88

**core-platform-3 + T-core-7: Make `modifyObject` required, delete the unreachable "unavailable" fallbacks, and add one test `modify` helper**

- Where:
  - `src/platform/json-document.ts:73-97`
  - `src/config/scoped-config-store.ts:140-143`
  - `pi-code-previews/src/config/document-store.ts:123-129`
  - `pi-better-xai/src/auth/auth.ts:125-128`
  - `pi-subagents/src/config/store.ts:729-730`
  - `pi-mcp/src/config/store.ts:139-147`
  - `tests/platform.test.ts:79-91, 186-197, 222-233, 255-266`
  - `tests/json-document.test.ts:101, 188-194`
- Change: Make `modifyObject` required on `JsonDocumentStoreContract` and keep `export type AtomicJsonDocumentStoreContract = JsonDocumentStoreContract`. Call it directly in the five consumers; xai keeps `writeError` for its later catchTag. Replace the four guarded modify blocks in platform.test.ts with one `modify(modification)` helper.
- LOC: src 30 / test 25. core-platform-3's 12 guard lines are part of T-core-7's 25, so they are counted once. Risk low, effort M.
- Why behavior holds: every store in the workspace (live, in-memory and all test fakes) already implements `modifyObject`, and no test asserts the fallback messages. An external store without `modifyObject` now fails at type-check time instead.

**core-platform-2: Remove the test-only `JsonDocumentStore.updateObject` from the contract**

- Where:
  - `src/platform/json-document.ts:81-85, 274-294`
  - `src/testing/layers.ts:213-233, 249-250`
  - `tests/json-document.test.ts:118-125, 160-162, 219-231`
  - `tests/platform.test.ts:98-129`
  - `tests/scoped-config.test.ts:208`
  - forwarders and setup calls in the tests of pi-code-previews, pi-better-openai, pi-code-mode, pi-mcp, pi-background-task, pi-cosmic-ui and pi-better-xai
- Change: Delete `updateObject` from the contract, the live layer and `makeInMemoryDocuments`. Port the core tests for byte limits, cross-Layer serialization and fail-closed decoding to `modifyObject`. Drop the fake forwarders. The 118-125 operation can simply be deleted.
- LOC: src 42 / test 11. Risk low, effort M.
- Why behavior holds: no `src` file in any package calls it. Both implementations are the same thin `modifyObject` + `Effect.try` wrapper. The change narrows a published contract.

**T-core-6: Fold platform.test.ts (JsonDocumentStore only) into json-document.test.ts with one fake FileSystem**

- Where: `tests/platform.test.ts:1-59`, `tests/json-document.test.ts:1-89, 98-126, 179-187, 242-261`
- Change: Add one `documentLayer(initial, chunkBytes?)` on `FileSystem.make(FileSystem.makeNoop(...))` that returns the mutable fake, so tests can still inject faults. Move platform.test.ts's ten tests into json-document.test.ts, delete platform.test.ts, and share a `trackedModification(document)` helper. Apply after T-core-7.
- LOC: test 35. Risk low, effort M.
- Why behavior holds: every assertion is kept. The merged fake must keep `Effect.yieldNow` in readFile and the sequenced `/tmp/document-N` temp paths.

**core-rest-8: Replace the 63-line full-Map `JsonDocumentMapView` with a narrow owned interface**

- Where: `src/testing/layers.ts:33-48, 61-123`
- Change (verifier-adjusted): the proposed `Pick<Map,…>` fails type-checking (TS2416 on `set`). Instead, define an `InMemoryDocumentMap` interface (size/get/has/set/delete/keys/values) and an object-literal `documentView(stored)` factory that keeps clone-on-read and clone-on-write.
- LOC: src 17. Risk low, effort S.
- Why behavior holds: all 22 consuming test files use only these members. The change narrows a `pi-cosmic-core/testing` type.

**T-core-15: Record path operations in `makeInMemoryDocuments` instead of hand-wrapping stores**

- Where:
  - `tests/scoped-config.test.ts:98-120, 185-219`
  - copies in `pi-cosmic-ui/tests/config.test.ts:125-147`, `pi-background-task/tests/config.test.ts:20-44`, `pi-code-mode/tests/store-atomic.test.ts:241-266` and `pi-mcp/tests/config/store.test.ts:311-333`
- Change: Add a `readonly operations: readonly string[]` log. Log only at the public service entry points, not inside the `modifyObject` that `updateObject` delegates to. Tests then assert on `memory.operations`.
- LOC: test 17 in core. The finding's 18 includes the scoped-config.test.ts:208 forwarder already counted under core-platform-2. The finder estimates about 80 more lines in the other four packages. Risk low, effort S.
- Why behavior holds: the probe and no-I/O assertions keep their meaning, and recording at execution time is stricter. Skip the `updateObject` hook if core-platform-2 lands.

**core-platform-14: Inline single-use pass-through wrappers in the document modules**

- Where: `src/platform/json-document.ts:5, 145-155, 161-163`, `src/platform/schema-document.ts:18-19, 148-173`, `src/platform/node.ts:15-21`
- Change (adjusted):
  - Expose `readObjectUnlocked` as `readObject` under the span name `JsonDocumentStore.readObject`.
  - Map NotFound to `Effect.succeed(undefined)` and drop the Option import.
  - Export `fileLayer` directly.
  - In schema-document, inline only `decodeSchemaObject` and keep the `mapError` thunk.
- LOC: src 8. Risk low, effort S.
- Why behavior holds: results and errors are identical. Only Effect.fn span names change, and effect-v4.md says those are "not a contract".

### Coordination (synchronous-ingress, subscription-refresh, refresh/process coordinators): src 35 / test 138

**core-rest-2 + T-core-2: Remove the SynchronousIngress `onDefect` option and parameterize the ingress tests**

- Where: `src/coordination/synchronous-ingress.ts:22-27, 57, 62-76`, `tests/synchronous-ingress.test.ts:146-239, 241-329`
- Change:
  - Delete `onDefect` and `reportDefect`. `catchCause` becomes `hasInterruptsOnly ? failCause : logWarning(<fixed text>)`.
  - Collapse the four scope/shutdown × idle/active tests into one 2×2 loop.
  - Delete the two tests that exist only for the observer. Fold the keep-alive check into the fixed-diagnostic test, and rewrite "no defect on shutdown" with `makeCapturedLogger`.
  - Drop every `Effect.timeout("500 millis")`: TestClock never fires them, and the Vitest timeout still catches hangs.
- LOC: src 15 / test 65. core-rest-2's 38 test lines fall inside T-core-2's rewrite, so they are counted once. Risk low, effort M.
- Why behavior holds: none of the 9 production callers passes `onDefect`, so every one already takes the logWarning path. The offers-during-shutdown test (204-216) and the interrupt/closed assertions stay.

**T-core-5: Share the gated-first-run operation in the refresh-coordinator tests and merge the falsy/undefined follow-up cases**

- Where: `tests/refresh-coordinator.test.ts:52-80, 82-109, 111-135, 137-161`
- Change: Add a local `gated<R>()` that returns `{ started, release, requests, operation }`. Replace 111-161 with `it.effect.each([[1, 0], [undefined, undefined]])` and assert that `requests` equals `[first, next]`.
- LOC: test 35. Risk low, effort S.
- Why behavior holds: joiner interruption, coalescing, late merges and failure/interrupt replay stay covered. Follow-ups are now asserted through the recorded list.

**T-core-9: Merge the same-key serialization and owner-interruption process-coordinator tests**

- Where: `tests/process-coordinator.test.ts:21-48, 74-100`
- Change: Loop over `["release","interrupt"] as const` with a key per ending and a single `Deferred.succeed` / `Fiber.interrupt` branch.
- LOC: test 22. Risk none, effort S.
- Why behavior holds: both proofs stay: exclusion while an owner holds the lock, and release on completion and on interruption.

**core-rest-6: Fix the subscription-refresh request type to `RefreshRequest` and remove the duplicate merge functions**

- Where:
  - `src/coordination/subscription-refresh.ts:8-34`
  - `src/usage-controller.ts:12, 271-278`
  - `pi-cosmic-ui/src/protocol/service.ts:73-77, 137-144, 170-177`
  - `tests/subscription-refresh.test.ts:7-13`
- Change: Drop the `Request` generic and the `mergeRequest` option, and call `makeRefreshCoordinatorWith<RefreshRequest, E>(mergeRefreshRequest)` internally; the coordinator stays generic. Remove `ProbeRequest`, the local merge, and the type argument and `mergeRequest` from both cosmic-ui instantiations (gitRefresh and pullRefresh). The count includes the import, which wraps onto several lines.
- LOC: src 8 / test 10. Risk low, effort S.
- Why behavior holds: the force-OR merge is identical. The cosmic-ui fetches read only `force`, so the extra `notify: false` is never observed. The exported generic arity changes.

**core-rest-7: Remove members of SubscriptionRefresh, UsageRefreshController and PiManagedRuntime that nothing outside tests reads**

- Where:
  - `src/coordination/subscription-refresh.ts:14, 21-23, 38, 61, 80-82`
  - `src/usage-controller.ts:159, 172, 414, 420`
  - `src/runtime/runtime.ts:160, 184`
  - `tests/subscription-refresh.test.ts:38, 58, 103, 153, 177`
  - `tests/session-runtime.test.ts:40-42, 80-82, 276-278`
- Change:
  - Drop the `equals` option and use `Object.is` directly.
  - Drop `wake` and `revision` from the returned object, so it collapses to `{ request, invalidate, startPolling }`.
  - Drop `authPath` and `invalidate` from UsageRefreshController, and `runSync` from PiManagedRuntime.
  - In tests, use `invalidate` instead of `wake`.
  - Also edit `docs/architecture/pi-boundaries.md:125`, which lists `runSync`.
- LOC: src 12 / test 6. The finding claims 12 test lines; 6 of them are runSync fake lines that T-core-4's `fakeRuntime` helper already collapses. Risk low, effort S.
- Why behavior holds: no workspace consumer reads any removed member, and `invalidate` releases the same latch as `wake`.

### Processes (duplex-process\*, process.ts, process-close.ts): src 97 / test 45

**core-platform-1: Derive the duplex option types from `DUPLEX_PROCESS_DEFAULTS`, table-drive normalization, and drop `maxBufferBytes`**

- Where: `src/platform/duplex-process.ts:20-55, 70-88, 97-190, 289-332`, `pi-mcp/src/boundary/sdk-stdio.ts:378`
- Change (adjusted):
  - Add `type DuplexProcessLimits = { readonly [K in keyof typeof DUPLEX_PROCESS_DEFAULTS]: number }` and make both option interfaces extend it (Partial for the input).
  - Rewrite `snapshotOptions` as one `limit(key, value?, allowZero?)` line per key, keeping the stderr-queue fallback and allowZero.
  - Spread the normalized options into the close and io option objects.
  - Remove `maxBufferBytes` from the defaults, both interfaces and sdk-stdio.
  - **Keep** the `DUPLEX_PROCESS_DEFAULTS` export in index.ts.
- LOC: src 45. Risk low, effort S.
- Why behavior holds: defaults, validation and the 'Invalid child process options.' error are unchanged. `maxBufferBytes` was only a fallback, and the sole caller sets both dependent limits explicitly. The public type and the exported constant each lose one key.

**core-platform-4: Share the process-group signalling and observer-call helpers, and collapse duplex micro-duplication**

- Where:
  - `src/platform/duplex-process.ts:201-225, 250-256, 331`
  - `src/platform/duplex-process-io.ts:53-62, 111, 299-314`
  - `src/platform/duplex-process-close.ts:52-60`
  - `src/platform/process.ts:10, 133-152`
  - `src/platform/process-close.ts:1-25`
- Change:
  - Move `signalGroup` into process-close.ts.
  - Use it for `requestGroupTermination`, keeping the pid guard at the call site, and for the Unix sweep (`present || absent`).
  - Replace the two duplex observer wrappers with one `callObserver`.
  - Inline `childExit`.
  - Do the stdout/stderr byte accounting with `Stream.tap`.
- LOC: src 32. Risk none, effort S.
- Why behavior holds: the errno-to-result mapping is identical. In rc.112, `Stream.tap` is `mapEffect(…, a => Effect.as(f(a), a))`, so accounting runs at the same point. Observer throws are still swallowed.

**core-platform-10: Compact the bounded-process output plumbing**

- Where: `src/platform/process.ts:76-101, 123-131, 243-261`
- Change: `boundedOutput(streamName, handle, limit, collector, total)` reads `handle[streamName]` and drops the redundant outer `Math.max(0, limit)`. `decodeOutput` becomes `new TextDecoder().decode(Buffer.concat(c.chunks))`.
- LOC: src 16. Risk none, effort S.
- Why behavior holds: the inner clamp gives the same `remaining` for negative, NaN and Infinity limits, and the decoded bytes are the same.

**T-core-10: Remove the redundant TERM-escalation duplex test and share the cleanup-recorder and spawn-suppression setup**

- Where: `tests/duplex-process.test.ts:443-453, 157-171, 160-163, 179-182, 219-222, 245-251, 269-277, 294-308, 324-335, 349-364`
- Change: Delete 443-453 and add a SIGKILL exit assertion to the idempotent-close test. Add `tracked(mode, overrides)` and `suppressEvents(child, ...events)`.
- LOC: test 20. Risk none, effort S.
- Why behavior holds: SIGKILL escalation stays asserted in three tests, and the suite spawns one fewer real process.

**T-core-12: Add request and fake-handle builders to the process-runner tests**

- Where: `tests/process-runner.test.ts:14-80, 104-126, 157-169`
- Change: Add `runNode(script, overrides)` over `runBoundedProcessScoped` and `fakeHandle(overrides)` over `ChildProcessSpawner.makeHandle`.
- LOC: test 20. Risk none, effort S.
- Why behavior holds: the overflow, signal, deadline and cleanup-reporting assertions are all kept.

**core-platform-13: Remove the always-true `BoundedProcessResult.dispatched` field**

- Where:
  - `src/platform/process.ts:63, 295`
  - `pi-better-openai/src/boundary/sharp.ts:92`
  - `pi-mcp/src/boundary/schema-validator.ts:138`
  - `pi-subagents/src/boundary/local-cli-harness.ts:385` and `herdr-cli.ts:384-397`
  - tests: core `process-runner.test.ts:30`, pi-better-openai `sharp.test.ts:28, 50`, pi-mcp `schema-validator.test.ts:44`, pi-herdr-btw `herdr-client.test.ts:32`
- Change: Delete the field, the dead `!result.dispatched` checks and the strip map. herdr-cli maps a success to `{ ...result, dispatched: true }` for its own CommandResult. Drop the fakes' field and the sharp `{ dispatched: false }` test case.
- LOC: src 4 / test 5. Risk none, effort S.
- Why behavior holds: a failure before dispatch already goes to the BoundedProcessError channel, so the checks cannot fire with the real runner.

### Usage and subscription formatting: src 28 / test 104

**T-core-1: Share one usage-controller fixture between usage-controller.test.ts and usage-visibility.test.ts**

- Where: `tests/usage-controller.test.ts:15-182`, `tests/usage-visibility.test.ts:19-88`
- Change (adjusted):
  - Move both controller tests into usage-visibility.test.ts.
  - Generalize `fixture` with an optional `visible` and a typed options override that is generic in R, and export one `unusedHttp`.
  - In test 1, apply `provideBuiltLayer(testLayer)` only to building the fixture, then call `refresh` after the Layer has closed.
- LOC: test 90. Risk low, effort M.
- Why behavior holds: the trust-defaults-false, captured-vs-conflicting HTTP, Missing-outcome and default-synchronizeState assertions stay. The adjusted Layer scoping keeps the escaped-refresh proof.

**T-core-18: Drop exact-copy and layout assertions and the duplicated settings-completion case**

- Where:
  - `tests/subscription-format.test.ts:7-10`
  - `tests/settings-completion.test.ts:1-2, 23-27, 49-65`
  - `tests/usage-controller.test.ts:108`
- Change (adjusted):
  - Replace the clock-layout regex with one positive test: with showResetTimes true, the line differs from and is longer than the false line. It checks no glyph and no clock format.
  - Merge 49-65 into an `it.effect.each` that asserts InvalidSettingError with the matching id.
  - Delete 23-27.
  - Import everything from @effect/vitest.
  - Loosen or drop usage-controller:108, coordinating with T-core-1.
- LOC: test 14. Risk none, effort S.
- Why behavior holds: failures stay typed and scoped to the setting id, and the sibling-preserving patch is still covered at 67-76.

**core-rest-5: Remove the unreachable 'compact' reset style and the ignored `includeDate`/`_options`**

- Where:
  - `src/subscription-format.ts:58-63, 125-130, 136-162`
  - `pi-better-openai/src/usage/format.ts:141-144`
  - `pi-better-xai/src/usage/format.ts:118-121`
  - `tests/subscription-format.test.ts:8`
- Change: Drop `resetStyle` and always call `formatShortReset`. Remove its `_options` parameter and `UsageWindowLine.includeDate`. The providers pass `options` straight through. Keep `formatCompactReset`, which xAI's `formatUsageDetails` uses.
- LOC: src 12. Risk low, effort S.
- Why behavior holds: both callers already pass 'short', and the short format ignores includeDate. The exported default changes only for callers outside the workspace.

**core-rest-11: Reuse the shared status-text shape and default merge in usage-projection**

- Where: `src/usage-projection.ts:52-60, 103-107, 125-138`
- Change: Type the `withUsageEligibility` options with `UsageEligibilityStatusTexts` and write `const texts = { hiddenStatusText: "Usage hidden.", ...decision.statusTexts }`.
- LOC: src 10. Risk none, effort S.
- Why behavior holds: exactOptionalPropertyTypes forbids an explicit undefined, so the spread equals the ternary plus the conditional assignment.

**core-rest-13: Define the local-day DateTime format options once in `formatResetClock`**

- Where: `src/subscription-format.ts:30-39`
- Change: Add `const LOCAL_DAY = { year: "numeric", month: "2-digit", day: "2-digit" } as const` and turn both calls into one-liners.
- LOC: src 6. Risk none, effort S.
- Why behavior holds: the Intl options are the same, so the comparison keys are the same.

### Runtime (runtime.ts, session-runtime.ts): src 20 / test 55

**T-core-4: Collapse the session-runtime fake runtimes, host-runtime casts, probe layers and rejection checks**

- Where: `tests/session-runtime.test.ts:19-94, 139-214, 216-239, 241-304, 306-363`
- Change: Add `fakeRuntime(run, dispose)`, `hostRuntime(layer = Layer.empty)` holding the single SAFETY cast, and `rejects(p)`. Use `makeLifecycleProbe("acquire","release")` instead of hand-built Layers, and drop the PiSessionRuntimeError mappers that serve no purpose.
- LOC: test 40. Risk none, effort S.
- Why behavior holds: every lifecycle assertion is unchanged.

**T-core-17: Delete the runtime test that only exercises Effect's ManagedRuntime**

- Where: `tests/runtime.test.ts:93-107`
- Change: Delete the test and its now-unused imports.
- LOC: test 15. Risk none, effort S.
- Why behavior holds: release through core's `makePiManagedRuntime` stays covered at session-runtime.test.ts:96-137 and 216-239.

**core-rest-10: Make makePiRuntime's application layer required and drop the no-layer overload**

- Where: `src/runtime/runtime.ts:130-150`, `tests/runtime.test.ts:44`
- Change: Use a single signature whose body is `ManagedRuntime.make(applicationLayer.pipe(Layer.provideMerge(Layer.merge(PiApi.layer(pi), loggerLayer))))`. The test calls `makePiRuntime(pi, Layer.empty)`.
- LOC: src 10. Risk low, effort S.
- Why behavior holds: `Layer.empty` (rc.112) yields the same PiApi-plus-logger runtime. Only an external call without a layer stops type-checking.

**core-rest-12: Replace the local try/catch best-effort wrappers with `invokeHostCallback`**

- Where: `src/runtime/session-runtime.ts:44-51, 86-87, 102, 157`, `src/runtime/runtime.ts:104-108`
- Change: Delete `runBestEffort` and replace its calls with `invokeHostCallback(fn, undefined)`, including the `removeEventListener` release.
- LOC: src 10. Risk none, effort S.
- Why behavior holds: the semantics are identical: the callback runs synchronously and a throw is swallowed. host-session.ts is pure, so there is no cycle. The addEventListener try/catch stays.

### Cross-process lock and SafeFile: src 49 / test 23

**core-platform-5: Collapse the repeated admission-check, option-validation and uncertain-commit blocks in the cross-process lock**

- Where: `src/platform/cross-process-lock.ts:6-8, 33-36, 54-64, 74-99`, `src/platform/cross-process-lock-node.ts:31, 36-41, 141-156, 170-176, 199-235`
- Change (adjusted):
  - Define one `timedCheck`.
  - Add `invalidMillis(ms)`.
  - Write `failure = (cause: unknown) => cause instanceof CrossProcessLockError ? cause : new CrossProcessLockError({ reason: "unavailable" })`. The parameter must be named `cause` to pass anti-slop/no-unknown-parameters.
  - Make `code(...expected)` variadic and give the retire catch a single return.
  - Add `uncertainOnFailure(commit)` and drop `return stat`.
- LOC: src 22. Risk low, effort S.
- Why behavior holds: filesystem order, fencing and error reasons are unchanged. The clock reads move inside `restore`, which adds interruption points only before `acquire`, when no ownership exists yet.

**core-platform-6: Define SafeFile's repeated read/open failure steps once**

- Where: `src/platform/safe-file.ts:32-48, 62-134`
- Change: Add two message constants and `readStep(evaluate)`, shrink `failRead` to one line, and write the early exits as `safeFileError('open'|'size', OPEN_FAILURE)()`.
- LOC: src 20. Risk none, effort S.
- Why behavior holds: operations, messages, the error class, check order and concurrency are unchanged.

**core-platform-7: Drop the exported `closeSafeFileHandle` test seam**

- Where: `src/platform/safe-file.ts:28-30, 50-54, 145`, `tests/safe-file.test.ts:10, 109-123`
- Change: Inline `nodePromise('close', …, () => handle.close()).pipe(Effect.ignore)` in the release. It needs a typed failure, so not `Effect.promise`. Delete the interface, the export and the internal-mapping test.
- LOC: src 7 / test 15. Risk none, effort S.
- Why behavior holds: close failures are still ignored. The deleted test checked a mapping nobody can observe. The seam is not exported from index.ts.

**T-core-19: Remove the duplicated exit-wait logic in the cross-process-lock child harness**

- Where: `tests/cross-process-lock.test.ts:25-35, 68-76`
- Change: Add one `exitOf(child)`. `kill` becomes SIGKILL followed by `exitOf`, and `exited` becomes `exitOf(child).pipe(Effect.timeout("10 seconds"))`.
- LOC: test 8. Risk none, effort S.
- Why behavior holds: `signalCode` is checked synchronously before the listener is added, and SIGKILL on an exited child is a no-op.

### Cross-cutting test support: test 70

**T-core-3: Replace the per-file temp-directory and fixture-I/O boilerplate with one tests/support helper**

- Where: `tests/host-logger.test.ts:11-37, 50-120, 142-162`, `tests/safe-file.test.ts:13-39, 41-107`, `tests/cross-process-lock.test.ts:20-24`
- Change: Add a scoped `tempDirectory(prefix)` built with acquireRelease. `Effect.promise` replaces `testFileSystem(label, …)`.
- LOC: test 40. Risk none, effort S.
- Why behavior holds: a fixture failure becomes a defect, which still fails the test. No test inspects TestFileSystemError.

**T-core-11: Share scoped spy and console-silence helpers instead of hand-written acquireRelease and try/finally blocks**

- Where:
  - `tests/native-context.test.ts:212-219, 233-247`
  - `tests/duplex-process.test.ts:70-81, 185-196, 529-539`
  - `tests/host-logger.test.ts:53-66`
  - `tests/runtime.test.ts:62-88`
- Change: Add tests/support/spies.ts with `scopedSpy(make)` and `silencedConsole`, which returns `calls()`.
- LOC: test 20. Risk none, effort S.
- Why behavior holds: the no-TTY-output assertion keeps its meaning, and every spy is restored when its scope closes.

**T-core-16: Share the paused and interrupting scheduler fixtures**

- Where:
  - `tests/duplex-process.test.ts:83-108`
  - `tests/projection.test.ts:20-32`
  - `tests/refresh-coordinator.test.ts:20-32`
  - `pi-mcp/tests/boundary/sdk-stdio.test.ts:65-90`
  - `pi-ask-user/tests/async-service.test.ts:647-662`
- Change: Publish `pausedScheduler()` from `pi-cosmic-core/testing`; it has no Vitest dependency. Add `interruptingScheduler(shouldInterrupt)` to replace the two MixedScheduler builders.
- LOC: test 10 in core only. The finder estimates about 40 more in pi-mcp and pi-ask-user. Risk none, effort S.
- Why behavior holds: scheduler behavior is identical. The testing.ts export is additive.

### Config (scoped-config-store, scoped-store, tolerant-fields): src 26 / test 40

**core-rest-3: Remove config fields and options that nothing outside tests uses (`committedScope`, `extensionsDirectory`, `preferred`, `raw`)**

- Where:
  - `src/config/scoped-config-store.ts:39-40, 83-84, 90, 196-199`
  - `src/config/scoped-store.ts:13-14, 20, 27, 62`
  - `src/config/tolerant-fields.ts:27-28, 67-71`
  - `tests/scoped-config.test.ts:25, 49-52, 74, 94, 117, 225-248`
- Change: Derive the commit scope from `configPath`, inline "extensions", and drop `preferred` and `raw`. Delete the matching assertions and the explicit-'global' commit case, which cannot happen in production.
- LOC: src 17 / test 25. Risk low, effort S.
- Why behavior holds: nothing outside the core tests produces or reads these members. Prototype safety is still covered through `value`.

**core-rest-4: Simplify the scoped config store internals**

- Where: `src/config/scoped-config-store.ts:103-113, 209-220`
- Change (adjusted):
  - Call `scopedDocumentPaths(cwd, agentDir, options)` and drop `basename` from the destructure.
  - Decode committed and fallback once and return the scope ternary.
  - Leave `readConfigOrWarn` (document-ops.ts:40-45) unchanged.
- LOC: src 9. It is 13 on its own; about 4 lines overlap core-rest-3's configPaths spread. Risk none, effort S.
- Why behavior holds: the paths and overlay order are the same, and decode is a pure tolerant decode.

**T-core-14: Deduplicate the scoped-config store options and path resolution in tests**

- Where: `tests/scoped-config.test.ts:63-121, 140-169`
- Change: Declare one `storeOptions`, annotated so the lambdas keep their contextual types, and spread it with `defaultDocument` for testStore. Hoist `projectPaths`.
- LOC: test 15. Risk none, effort S.
- Why behavior holds: the tests construct the same stores and paths.

### HTTP platform: src 22 / test 27

**T-core-8: Add layer and request builders to the http-platform tests and merge the two redacted decode-failure tests**

- Where: `tests/http-platform.test.ts:21-27, 29-138, 176-299, 301-352, 354-436`
- Change: Add `toClient`, `json(…)`, `streaming(…)`, `okRequest` and `countingClient()`. Merge 88-121 into one `it.effect.each`. The invalid-JSON row must expect operation 'response' (it fails through responseReadError), and the schema row 'decode'.
- LOC: test 30. Risk none, effort S.
- Why behavior holds: all redaction, span, encode and stream assertions are kept.

**core-platform-11: Drop the unused `JsonHttpRequest.acceptStatus` and the test-only `StreamingHttpClient.requestRawBytes`**

- Where:
  - `src/platform/json-http.ts:17-18, 58, 118`
  - `src/platform/streaming-http.ts:33-42, 55-68, 90-91`
  - `src/testing/layers.ts:304-307, 349`
  - `tests/http-platform.test.ts:69, 357-400`
- Change: Inline the 2xx check and remove `requestRawBytes` from the contract, the live layer and the test layer. Make `execute`'s body required, and port the five streaming tests to `requestJsonRawBytes`.
- LOC: src 14 / test −3. Risk low, effort S.
- Why behavior holds: no production caller is affected. The change narrows published contracts.

**core-platform-12: Share JSON request-body encoding between the live and test HTTP layers**

- Where: `src/platform/json-http.ts:148-155`, `src/platform/streaming-http.ts:92-105`, `src/testing/layers.ts:329-336, 349-364`
- Change (adjusted): Export `withStreamingJsonBody(execute)` and use it in both the live and test layers. Add the JSON-side `withJsonRequestBody` only if its generic `execute` type stays compact. Apply after core-platform-11, and do not re-export the helper from index.ts.
- LOC: src 8. Risk none, effort S.
- Why behavior holds: the error classes and messages are identical, and sharing the code keeps the test layers in lockstep with production.

### Security and projection: src 12 / test 16

**core-rest-9: Factor the duplicated CSI and terminal-string skip loops in `stripTerminalControls` into two helpers**

- Where: `src/security.ts:47-99`
- Change: Add `skipControlSequence(value, start)` and `skipTerminalString(value, start, acceptC1Terminator)`. The ESC-introduced string form must pass `false`.
- LOC: src 12. Risk low, effort S.
- Why behavior holds: the helpers return the same index each loop reached before (the final byte; BEL, 0x9c or the backslash; or the input length). This is a security sanitizer, so security.test.ts must pass unchanged.

**T-core-13: Consolidate the projection failure assertions into one `it.each` with a ProjectionError helper**

- Where: `tests/projection.test.ts:115-151, 221-254`
- Change: Add a `projectionFailure(value)` helper and one `it.each([name, value, path])` that asserts `.path`; the symbol-keyed root's path is `$`.
- LOC: test 16. Risk low, effort S.
- Why behavior holds: exact-path assertions are stronger than the current substring match. The only checks lost are the reason text, which the testing policy treats as copy.

### Structural notes (unverified)

- `index.ts:229-251` re-exports every testing helper that testing.ts also exports, and no consumer imports them from the main barrel. Blocked by the stable-exports rule. (~23)
- Several value exports on the main barrel have no importer: `DUPLEX_PROCESS_DEFAULTS`, `duplexProcessError`, `formatShortReset`, `isContainedPath(With)`, `makePiRuntime` and `sectionSettingValue`. There are also about 60 type-only exports with no importer. `makeFrozenUsageProjection`/`resetFrozenUsageProjection` duplicate what each provider already defines. Blocked by the stable-exports rule. (~40)
- The same commit flow (resolve, read the fallback, `modifyConfig`, `resolveCommittedConfig`) is repeated in `usage-controller.ts:366-400`, `pi-better-openai usage/controller.ts:125-155` and `pi-cosmic-ui config/store.ts:102-150`. A `ScopedConfigStore.commit` could replace all three, but the copies handle fallback-read errors differently. (~35)
- `pi-background-task/src/config/store.ts:48-83` reimplements `makeScopedConfigStore.resolveConfig`. Migrating it changes the warning text and makes the two reads concurrent. (~25, in that package)
- `stripTerminalControls` (security.ts) and `sanitizeTerminalStyledFragments` (security/terminal-styled.ts) are separate parsers with different ESC-intermediate, tab and SGR handling. Unifying them would change sanitizer edge cases. (~60)
- The bounded bytes-to-UTF-8-text logic is duplicated in `json-document.ts:125-144` and `json-http.ts:64-79`, but their error plumbing differs. (~8)
- `JsonHttpClient.execute` and `StreamingHttpClient.execute` repeat the same request construction, but each keeps distinct errors and span names. (~8)
- `testing/layers.ts` cloneDocument re-implements the live store's serialized-size and limit checks. A shared `serializedWithinLimit` would keep the two stores in lockstep. (~6)
- An Effect Schema for DuplexProcessOptions could replace `snapshotOptions`, as an alternative to core-platform-1. It is not clear this would be shorter. (~15)
- A third errno kill-probe exists at `cross-process-lock-node.ts:84-91` (`dead(pid)`). It could reuse `signalGroup` after core-platform-4, but the lock's Node boundary intentionally keeps its own synchronous door. (~5)
- The IPC child-process harness in `cross-process-lock.test.ts:20-80` is copied in `pi-mcp/tests/auth/credential-transactions.test.ts:1-62`, which also imports core's node-builtins through a relative path. An `ipcFixture` in `pi-cosmic-core/testing` could serve both. (~50)
- Hand-written mkdtemp/rm temp-directory setup appears in about 35 test files across the workspace, mostly in pi-subagents, and pi-code-previews has its own helper. A shared `tempDirectory(prefix)` in `pi-cosmic-core/testing` would extend T-core-3 across packages. (~150)
- `runtime.test.ts:13-36` and `session-runtime.test.ts:54-64` each define `makeHostileSignal`. Sharing one would change one case from a throw on property access to a throw on call. (~10)
- The finder's note that sharing JSON-body encoding saves only 1-2 lines per site is superseded by the confirmed core-platform-12. (—)
- Local hygiene: `packages/pi-cosmic-core/pi-cosmic-core` is an untracked self-referential symlink; git status shows the same in pi-ask-user, pi-code-previews and pi-cosmic-ui. `dist/` exists locally but is gitignored. (0)

### Needs a decision

- **core-platform-9: Replace the ProcessCoordinator service with a direct `withProcessLock` (src 24 / test 12).**
  - For: the lock registry is a module-global Map, so every Layer instance exposes the same function. JsonDocumentStore is the only consumer, no test swaps in a fake, and the requirement on JsonDocumentStore.layer disappears.
  - Against: it deletes the public `ProcessCoordinator`/`ProcessCoordinatorContract` exports, which README:15 documents, and changes the output type of `nodeFilePlatformLayer`. pi-boundaries.md:157 names this coordinator as the intended home, and effect-v4.md prefers Context.Service. A version that keeps the exports saves only about 3-5 lines.
- **core-rest-1: Define `UsageControllerStore` as a `Pick` of ScopedConfigStore (src 19).**
  - For: it is type-only with no runtime effect. It removes a 17-line duplicate interface and the line-195 drift check; a verifier recounts about 22-23 lines.
  - Against: it reverses a documented decision. ARCHITECTURE.md and the hardening commit ab656ef made this an "unconstrained structural compatibility contract". It also adds a `Resolved extends ScopedConfigMetadata` constraint to a type exported from index.ts.
- **core-platform-8: Remove the unused `isContainedPath`/`isContainedPathWith` and the three-way containment relation (src 16).**
  - For: nothing in any package calls them, and folding the relation into a boolean leaves the strict predicates' results unchanged.
  - Against: both are root exports of a published package, which the stable-exports rule protects. The export-preserving variant saves about 8 lines by one verifier's count and about 2 by the other's.
