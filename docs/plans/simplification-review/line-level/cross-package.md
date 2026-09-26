## Cross-package

Reviewers confirmed 32 cross-package findings, split on 2 (X-dup-8, X-dup-13) and dropped 2. The dropped pair, X-shared-10 and X-shared-11, would prune public `index.ts`/`testing.ts` exports from pi-cosmic-core, and CLAUDE.md says to keep those stable. Three finder units (X-dup, X-shared, X-boiler) scanned the same code independently, so most mechanisms were reported two or three times. Deduplication leaves 23 entries. **19 are counted, for about 631 source lines and 0 test lines.** The other 4 (X-boiler-9, X-shared-7, X-shared-8, X-shared-9) are fully covered by broader per-package findings, so their lines are counted in those packages, not here. The totals also subtract lines that a per-package finding already rewrites differently: 40 from the `invokeHostCallback` sweep (10 sites), 17 from X-dup-5's environment picker, 8 from X-dup-11, and 3 each from the extension hops and the footer watch helper. 12 per-package findings are fully subsumed by entries here and must be dropped from their packages' totals.

There are three themes:

- core helpers that exist but go unused: `invokeHostCallback` and `freezeSnapshot`
- a session-capability event-query protocol that five providers and five consumers each hand-roll, which belongs in core
- small shared adapters for pi-cosmic-ui and the platform layer

I spot-checked the eight largest entries against the code, and all eight held, so none were demoted. Everything is effort S or M with risk none or low, except the Windows taskkill terminator (C1). It is medium risk: it only runs on Windows, and this macOS host cannot exercise it.

| Category            | Entries | Src LOC | Test LOC |
| ------------------- | ------: | ------: | -------: |
| shared-helper-reuse |       7 |     289 |        0 |
| duplication         |      11 |     297 |        0 |
| indirection         |       1 |      45 |        0 |
| **Total**           |  **19** | **631** |    **0** |

**Per-package findings subsumed here (drop from their shard totals):**

- core-rest-12 (10) → A1
- background-task-6 (9), ask-user-10 (11) and mcp-tools-results-7 (15) → B1, B2 and B3 together
- sub-backend-19 (14) → C2
- background-task-4 (13) → D3
- mcp-connection-discovery-11 (11) → D4
- sub-settings-rest-12 (12) → E1
- mcp-ui-manager-7 and mcp-auth-9 (counted as 9 in the mcp section) → E4
- mcp-connection-discovery-3 and mcp-ui-manager-9 (counted as 18 in the mcp section) → G1

**How the findings interact (each line counted once):**

- **A1 is 225 gross and 185 counted.** Ten of its sites are also rewritten by per-package findings, some with a different fix. At the verifier's figure of about 4 lines per block, that is 40 lines deducted. The sites:
  - `pi-better-openai/src/settings/controller.ts:81-85,351-355` (better-openai-3 removes the throw both guards catch)
  - herdr `host-notifier.ts:9-13` (herdr-btw-9 part d makes the same rewrite)
  - herdr `host-link-store.ts:70-74` (herdr-btw-3 restructures `revalidateOwner`)
  - one of the two code-mode `theme.fg` guards, at `ui/status.ts:189-193` and `ui/result-read-renderer.ts:62-66` (codemode-ui-rest-3 merges the two renderers)
  - code-mode `host-render-ticker.ts:109-113` (codemode-ui-rest-10 drops that try)
  - core `synchronous-ingress.ts:67-71` (core-rest-2 deletes `reportDefect`)
  - one of core `duplex-process.ts:220-224` and `duplex-process-io.ts:57-61` (core-platform-4 merges both into one `callObserver`)
  - mcp `layer.ts:37-41` (mcp-connection-discovery-7 makes the same rewrite)
  - subagents `host-activity-widget.ts:60-64` (sub-boundary-host-git-15 deletes the `onChange` call)
- Two disputed per-package findings also touch A1 sites: sub-tools-exec-ui-6 (`subagent.ts` `releaseSafely`) and sub-supervisor-writer-10 (`mcp-contract.ts`). Pick one fix per site.
- **F1 counts 45, not 48.** ui-activity-app-4 already folds the cosmic-ui register hop; that hop is about 3 of X-dup-4's "about 10 lines from the three register hops".
- **E3 counts 10, not 13.** ui-activity-app-9 also removes the `stop` helper in `host-status.ts`.
- **C2 counts only the shell-name predicate, at 18 (X-boiler-11's figure).** The other half of X-dup-5 (35 − 18 = 17) is a generic `selectEnvironment`, and it overlaps sub-herdr-cli-process-1 (40, subagents), which adds a subagents-local `pickEnvironment` at the same sites.
- **H2 counts 4, not 12.** better-xai-dirmodels-5 and ui-manager-7 already cover the xai and cosmic-ui halves of X-dup-11; the verifier's split is 15 field lines minus 3 import lines, 4 per package.
- **B1 counts 60, the larger of X-dup-1 (55) and X-boiler-2 (60).** Their scopes only partly overlap: X-dup-1 adds the presentation and notify rewrites, and X-boiler-2 adds the host-code-mode listeners and the `QuestionnaireQuery` deletion. The true union is likely higher.
- **Order:** B3 (core decode helper) → B1 (provider module) → B2 (consumer helper, which depends on B1).
- **Other overlaps:**
  - ask-user-1 (80, in the ask-user section) rewrites `host-tui.ts` and `host-form-tui.ts`. E4 moves `finishOwnedOverlay` out of `host-tui.ts`. They work in either order.
  - G1's `notifyListeners` could also serve the cosmic-ui `host-status.ts` and ticker-pool listener loops, but A1 already rewrites those, so don't count them twice.

Paths are relative to the repository root.

### A. Host-callback guards (pi-cosmic-core `invokeHostCallback`): 1 entry, src 185

- **A1 · X-boiler-1 + X-shared-1**: Replace the hand-rolled single-statement try/catch guards with the existing `invokeHostCallback`.
  - Locations: about 80 blocks across 10 packages. X-boiler-1 lists them all; X-shared-1's 40 sites are almost all a subset. Representative sites:
    - `packages/pi-ask-user/src/application.ts:121-130`
    - `packages/pi-subagents/src/boundary/host-activity-widget.ts:60-70,194-198,251-255,299-303`
    - `packages/pi-subagents/src/boundary/host-refresh-ticker.ts:24-51`
    - `packages/pi-code-mode/src/boundary/host-ui.ts:87-99`
    - `packages/pi-mcp/src/boundary/sdk-stdio-transport.ts:115-143`
    - `packages/pi-code-previews/src/boundary/shiki.ts:60-64,100-104`
    - `packages/pi-cosmic-ui/src/boundary/host-activity.ts:57-63` (`safe`)
    - `packages/pi-cosmic-core/src/runtime/session-runtime.ts:45-52` (`runBestEffort`) and `runtime.ts:104-108`
  - Proposal:
    - Swallow blocks become `invokeHostCallback(() => stmt, undefined)` and return blocks become `return invokeHostCallback(() => expr, <same constant>)`. Assignments become `const x = invokeHostCallback(() => f(), d)`.
    - Keep `safe` (17 call sites) and `runBestEffort` as one-line aliases. Use pi-better-openai's existing `safeHostUi` for its statement sites. Wrap values that `Predicate.isFunction` narrows to `Function` as `() => stop()`.
    - Exclude multi-statement guards, OS calls (`process.kill`, `closeSync`, `stream.destroy`) and the decode sites that B3 owns.
    - Keep one-line comments that record an ownership decision.
  - **src 185 / test 0 · risk none · effort M.** The 225 gross is within the verifier range of 180-230, depending on how many comments are kept. It already allows for about 45 import lines. Reviewers may want to skip about 9 pure-computation sites (form-validation URL parsing, mcp-contract, subagents `config/schema.ts` and others), because the helper's name and doc describe host callbacks.
  - Why behavior holds: the helper is exactly `try { return cb() } catch { return fallback }`. Callbacks run synchronously at the same point, and every fallback is a constant or the variable's previous value. Every package already depends on core, and there is no import cycle because `host-session.ts` imports only Predicate.
  - Subsumes core-rest-12.

### B. Session-capability event query protocol (new pi-cosmic-core module): 3 entries, src 121

- **B1 · X-dup-1 + X-boiler-2**: Share the provider side: query decoding, thenable containment and the listeners.
  - Locations:
    - `packages/pi-background-task/src/code-mode/protocol.ts:200-219,232-275`
    - `packages/pi-mcp/src/code-mode/protocol.ts:147-203`
    - `packages/pi-background-task/src/code-mode/presentation.ts:152-172`
    - `packages/pi-background-task/src/boundary/host-code-mode.ts:72-83`
    - `packages/pi-mcp/src/boundary/host-code-mode.ts:62-72`
    - `packages/pi-cosmic-core/src/host-session.ts:60-80`
    - `packages/pi-ask-user/src/boundary/host-proxy.ts:23-27,136-149`
    - `packages/pi-ask-user/src/boundary/host-form-proxy.ts:24-28,133-140`
    - `packages/pi-subagents/src/boundary/host-ask-user.ts:20-27,135-139`
    - `packages/pi-ask-user/src/questionnaire/protocol.ts:41-45`
  - Proposal:
    - Add `pi-cosmic-core/src/session-capability.ts`. Do not put it in `coordination/`, which holds concurrency primitives. It exports a generic `containThenable<V>`, `invokeBestEffort<A>(cb)` and a factory `makeSessionCapabilityProtocol({ version, maxSessionIdChars? })` that returns `{ normalizeQuery, decodeCapability }`. Optionally add an `answer`-style listener installer.
    - bt and mcp keep `normalize*CodeModeQuery` and their types as aliases, because about 20 tests import them.
    - `observeBackgroundTaskPresentation` and `notifyAtHostBoundary` use `invokeBestEffort`.
    - The ask-user host-proxy and host-form-proxy and the subagents relay use a `{version: 1}` protocol. Keep a try around the ask-user listeners.
    - Delete the unreferenced `QuestionnaireQuery`, and update the core ARCHITECTURE host-session line.
  - **src 60 / test 0 · risk low · effort M.**
  - Why behavior holds: bt (max 256) and mcp (max 1024) accept and reject the same queries, and ask-user and subagents stay unbounded. Min length 1 rejects only an empty id, which never matched. What changes:
    - ask-user and subagents `respond` now contains thenables.
    - The subagents relay swallows a throwing `respond` that Pi's event bus used to log with `console.error`.
    - Queries decode before `current()` is checked.
  - Subsumes background-task-6, the containThenable/respond part of mcp-tools-results-7, and the `QuestionnaireQuery` part of ask-user-10.
- **B2 · X-dup-3 + X-boiler-3**: Share the consumer side (emit a query, collect candidates, select one).
  - Locations:
    - `packages/pi-ask-user/src/questionnaire/protocol.ts:203-257`
    - `packages/pi-ask-user/src/questionnaire/form-protocol.ts:182-230`
    - `packages/pi-code-mode/src/boundary/host-background-task.ts:66-86`
    - `packages/pi-code-mode/src/boundary/host-mcp.ts:105-124`
  - Proposal: Add `querySessionCapability(events, channel, {version, sessionId}, accept, limit = Infinity) → { candidates, failed }` to the B1 module, with a structural `{ emit }` events type and a generic `accept`. The call sites select as follows:
    - Relay and capability take `candidates.at(-1)`.
    - The owned form uses limit 2 and `!failed && length === 1`.
    - The code-mode bt and mcp dispatchers use limit 2 and map `failed || length === 0` and `length !== 1` to their existing errors.
  - **src 21 / test 0 · risk low · effort M.** The scope is the same in both findings, so I kept the lower figure: X-boiler-3 estimates 36 and the X-dup-3 verifiers 21 and 40.
  - Why behavior holds: last-wins, exactly-one and the cap of 2 give the same results. Only hostile responders see a difference, and it is fewer getter reads. Depends on B1.
  - Subsumes the `queryProvider` part of ask-user-10.
- **B3 · X-dup-2 + X-boiler-4**: One tolerant decode helper in core.
  - Locations:
    - `packages/pi-cosmic-ui/src/schema/decode.ts:1-11`
    - `packages/pi-cosmic-ui/src/protocol/protocol.ts:266-275`
    - `packages/pi-background-task/src/code-mode/protocol.ts:221-230`
    - `packages/pi-mcp/src/code-mode/protocol.ts:80-89`
    - `packages/pi-code-mode/src/tools/format.ts:52-59`
    - `packages/pi-ask-user/src/ui/tool-render-projection.ts:9-19`
    - `packages/pi-ask-user/src/boundary/host-delivery.ts:16-26`
    - 10 inline `Option.getOrUndefined(Schema.decodeUnknownOption(...))` sites:
      - bt `presentation.ts:60-62`
      - openai `codex-auth.ts:59-61`
      - herdr `herdr-client.ts:147-149` and `link.ts:64-66,76-78`
      - mcp `tool-render-details.ts:171-174`, `host-code-mode.ts:99-101,112-116`, `issues.ts:32-35` and `lifecycle.ts:94-96`
  - Proposal:
    - Move the Exit-based `decodeUnknownOrUndefined`, with a try around `decodeUnknownExit`, into core and export it.
    - Delete the cosmic-ui copy and repoint its 3 importers. Delete the three `decodeSafely` copies.
    - Make code-mode `decodeOption` an alias so its 33 call sites stay as they are.
    - Reduce ask-user `projection` to `(schema) => (input) => decodeUnknownOrUndefined(schema, input)`, and drop the Option imports that become unused.
  - **src 40 / test 0 · risk low · effort S.**
  - Why behavior holds: schema successes and failures decode the same way. The difference is hostile getters and proxies: they make the Option adapter throw, and now return undefined at `decodeOption`'s 33 sites and the 10 inline sites. That fails closed and matches `decodeOption`'s documented "never a throw". mcp `host-code-mode.ts:99` then raises its typed input error instead of a defect. If exact throw behavior matters, keep `decodeOption` Option-based, which saves about 5 fewer lines.
  - Subsumes the `decodeSafely` part of mcp-tools-results-7. Compatible with codemode-tools-11.

### C. Process and platform helpers (pi-cosmic-core): 3 entries, src 88

- **C1 · X-dup-6**: One bounded Windows `taskkill` process-tree terminator.
  - Locations: `packages/pi-background-task/src/boundary/local-process.ts:128-212`, `packages/pi-subagents/src/boundary/process-tree.ts:56-154`.
  - Proposal:
    - Add `pi-cosmic-core/src/platform/windows-process-tree.ts` with `runTaskkill(pid, mode, { spawn?, timeoutMillis = 2000, isComplete? })`. It fails with a tagged `TaskkillFailure` of Spawn, Error, Exit{code} or Timeout. Raw spawn goes through core's `node-builtins.ts`.
    - Keep bt's `attempt()`-guarded synchronous cleanup: detach, late-error listener, kill, unref.
    - bt maps every failure to `processError("terminate")`. subagents keeps its already-exited short-circuit, treats Exit as success when its child has exited, and maps each tag to its exact code and message. Spawn and Error stay separate so the two messages survive.
    - Rewrite one package's spawn fake, and update the bt ARCHITECTURE boundary line.
  - **src 60 / test 0 · risk medium · effort M.**
  - Why behavior holds: only Windows error and interruption edges change. These differences must be unified on purpose:
    - the completion event (`exit` in bt, `close` in subagents)
    - `SIGKILL` versus `kill()`
    - when the helper is unref'd
    - how a detach failure is handled
- **C2 · X-boiler-11 + X-dup-5**: Share the Herdr interactive-shell predicate.
  - Locations: `packages/pi-herdr-btw/src/btw/validation.ts:21-37,138-156`, `packages/pi-subagents/src/backend/herdr-shell-readiness.ts:11-46`.
  - Proposal: Export the 15-name set and its normalizer as `isInteractiveShellProcessName(name)` from a small, pure core module, for example `src/platform/shell-process-names.ts`. Alternatively, export X-dup-5's full `hasAvailableHerdrShell({shellPid?, foregroundProcessGroupId?, foregroundProcesses})`, with herdr-btw adapting its snake_case fields at the call site. The subagents readiness unit test moves to core.
  - **src 18 / test 0 · risk none · effort S.**
  - Why behavior holds: the set and the normalizer are byte-identical, and the null and undefined checks agree.
  - Subsumes sub-backend-19. The `selectEnvironment` half of X-dup-5 is not counted here: it covers the four allowlist copies at btw `herdr-client.ts:183-207` and subagents `herdr-cli.ts:264-294`, `herdr-environment.ts:1-47` and `herdr-harness.ts:120-127`. If both it and sub-herdr-cli-process-1 go ahead, host that picker in core so herdr-btw can reuse it.
- **C3 · X-boiler-12**: Share the surrogate-safe and UTF-8 prefix helpers.
  - Locations: `packages/pi-subagents/src/run/state.ts:9-21,28-41`, `packages/pi-mcp/src/ui/content-preview.ts:45-52`, `packages/pi-mcp/src/results/normalize.ts:14-26`.
  - Proposal:
    - Add `safeTextPrefix` and `utf8Prefix` (from mcp's `prefixBytes`) to a small core text module. Use TextEncoder or code-point arithmetic; core may not import `node:buffer`.
    - subagents `state.ts` re-exports `safeTextPrefix` for its roughly 30 internal call sites, and `clipUtf8Text` becomes `${utf8Prefix(value, budget)}…`.
    - mcp's content-preview uses `safeTextPrefix`, and `prefixBytes` re-exports the core helper.
    - Keep the per-package `utf8ByteLength`/`utf8Bytes` definitions; they have about 20 importers.
  - **src 10 / test 0 · risk low · effort S.**
  - Why behavior holds: the binary search finds the same longest code-point prefix, and a lone surrogate counts as 3 bytes either way. mcp `results/projection.ts` uses a different surrogate rule and stays as it is.

### D. Snapshot freezing (core `freezeSnapshot`): 4 entries, src 86

- **D1 · X-shared-2**: code-mode compact evidence hand-rolls copy-and-freeze.
  - Locations: `packages/pi-code-mode/src/tools/issue-evidence.ts:17-29`, `packages/pi-code-mode/src/tools/compact-evidence.ts:64-81,309,345-366`, `packages/pi-code-mode/src/tools/retention.ts:1,30,38`, `failure-evidence.ts:58-63`, `mcp-evidence.ts:32-33`.
  - Proposal: Delete `freezeIssues`, `freezeReceipt`, `copyCompactAttention`, `copyFailurePresentation` and `copyMcpEvidence`. Call `freezeSnapshot` at the 3 compact-evidence sites, and in `retention.ts` for `row.compact`, `compactAttention`, `failurePresentation` and `mcpEvidence`. Do not freeze the whole retained-details object, because that would reach the unvalidated `resultRead` and `initialPreview`.
  - **src 28 / test 0 · risk low · effort S.**
  - Why behavior holds: every input is schema-decoded plain data (finite Natural counts, literals, bounded arrays), so the result is the same detached, deep-frozen clone. No tests reference the helpers.
- **D2 · X-shared-3**: pi-subagents clones subtrees before `freezeSnapshot`, which already clones.
  - Locations: `packages/pi-subagents/src/run/state.ts:62-83`, `packages/pi-subagents/src/boundary/host-profile-resolution.ts:451-459`.
  - Proposal: Write `const snapshot = freezeSnapshot(view)` and keep the WeakMap memo. Pass `routeCandidates` and `skippedCandidates` straight to `freezeSnapshot`.
  - **src 23 / test 0 · risk low · effort S.**
  - Why behavior holds: `freezeSnapshot` already clones every level. The only visible change is that explicit `key: undefined` properties disappear, and no test and no `in`/hasOwn check observes them.
- **D3 · X-shared-4**: Local deep-freeze helpers in background-task, subagents and code-previews.
  - Locations: `packages/pi-background-task/src/code-mode/output.ts:85-97,116-117`, `packages/pi-subagents/src/settings/profile-model-catalog.ts:57-69`, `packages/pi-code-previews/src/config/state.ts:4-17`.
  - Proposal:
    - bt: `output: freezeSnapshot(decoded)`, and delete `deepFreeze`.
    - subagents: `freezeCatalogSnapshot = (revision, models, scoped = models) => freezeSnapshot({...})`, and delete `freezeProjectedModel`.
    - code-previews: `codePreviewSettings = freezeSnapshot(next)`, and delete `freezeSettings` along with its SAFETY cast.
  - **src 23 / test 0 · risk low · effort S.**
  - Why behavior holds: all three schemas produce finite plain data, and the results stay deeply frozen. Two things change, and nothing observes either: bt now freezes a detached clone instead of the decoded value, and when `scoped === models` the two catalog arrays become the same frozen array.
  - Subsumes background-task-4.
- **D4 · X-shared-5**: pi-mcp `freezeMetadata(structuredClone(...))`.
  - Locations: `packages/pi-mcp/src/discovery/pagination.ts:64-74`, `packages/pi-mcp/src/discovery/collect.ts:11,88-110`.
  - Proposal: Call `freezeSnapshot({...})` inside the existing `Effect.try`. Delete `freezeMetadata` and the pre-spread of diagnostics, and keep `isContainer`.
  - **src 12 / test 0 · risk low · effort S.**
  - Why behavior holds: the metadata has already passed the bounded JSON walk and the schema decode. Any failure still maps to `boundaryError("output-limit")`.
  - Subsumes mcp-connection-discovery-11.

### E. Shared UI adapters (pi-cosmic-ui): 4 entries, src 62

- **E1 · X-boiler-6 + X-dup-7 + X-shared-6**: One full-screen keybinding adapter.
  - Locations:
    - `packages/pi-background-task/src/settings/controller.ts:92-101`
    - `packages/pi-subagents/src/settings/controller.ts:126-135`
    - `packages/pi-subagents/src/settings/profile-dashboard.ts:274-283`
    - `packages/pi-subagents/src/settings/proxy-controller.ts:152-156`
    - `packages/pi-cosmic-ui/src/boundary/host-activity.ts:360-368`
    - `packages/pi-mcp/src/manager/controller.ts:168-170`
    - `packages/pi-mcp/src/boundary/host-auth-panel.ts:130-132`
  - Proposal:
    - Export `fullScreenKeybindingOptions(keybindings)` from `pi-cosmic-ui/manager/key-labels`. It takes a structural `{ matches(data, id); getKeys?(id) }` parameter, keeps method-call binding, and returns `{ matchesKeybinding, keybindingLabel }`.
    - Spread it at 6 sites; the auth panel uses `keyLabel: adapter.keybindingLabel`. Drop the Predicate and `FullScreenSelectionKeybindingId` imports that become unused.
    - Alternative (X-shared-6, label only, about 24 lines): pass the owner object as `fullScreenKeybindingLabel`'s third parameter and call `keybindings?.getKeys?.(id)`. 2 test assertions change shape.
  - **src 28 / test 0 · risk low · effort S.**
  - Why behavior holds: labels and matching are identical on the pinned Pi 0.86. The 3 sites without a `getKeys` guard (mcp manager, auth panel, subagents proxy) would now fall back to the default label on a host without `getKeys`, where today they throw.
  - Subsumes sub-settings-rest-12.
- **E2 · X-dup-10**: Shared revision-checked activity provider registration.
  - Locations: `packages/pi-background-task/src/boundary/host-activity.ts:77-119`, `packages/pi-subagents/src/boundary/host-activity.ts:142-206`.
  - Proposal: Add `registerRevisionedActivityProvider(events, { sessionId, providerId, isCurrent, items, detail, act, subscriptions, starting?, onAvailability? })` to `pi-cosmic-ui/src/activity/protocol.ts`. Pass `current` to `onAvailability` so subagents keeps `setActivityAvailable(current() && available)`. subagents keeps its literal action narrowing inside `act`.
  - **src 15 / test 0 · risk low · effort M.**
  - Why behavior holds: ActivityService maps every provider rejection that is not an ActivityError to its own `failed()` error, so the rejection messages can be unified without anyone seeing it. Lookup, action gating and the detail fallbacks are unchanged.
- **E3 · X-dup-9**: Idempotent host-state watch helper.
  - Locations: `packages/pi-better-openai/src/application.ts:148-158`, `packages/pi-better-xai/src/application.ts:84-94`, `packages/pi-cosmic-ui/src/boundary/host-status.ts:73-83`.
  - Proposal: Export `makeHostStateWatch(client, listener) → { start, stop }` from `pi-cosmic-ui/client`, with `start: () => { stop ??= client.onHostStateChange(listener) }`. Replace the three hand-rolled pairs.
  - **src 10 / test 0 · risk none · effort S.** This is 13 less the 3 lines that overlap ui-activity-app-9.
  - Why behavior holds: `onHostStateChange` always returns a function, so `??=` equals the existing "already watching" guard. This covers most of the finders' note on the parallel openai and xai usage-footer wiring (about 15 lines).
- **E4 · X-dup-12 + X-boiler-5 (narrowed)**: Share `finishOwnedOverlay` and the inert guard component.
  - Locations: `packages/pi-ask-user/src/boundary/host-tui.ts:14-23`, `packages/pi-ask-user/src/boundary/host-form-tui.ts:10`, `packages/pi-cosmic-ui/src/boundary/host-activity.ts:64,300-311`, `packages/pi-mcp/src/boundary/host-ui.ts:17,52-62`, `packages/pi-mcp/src/boundary/host-auth-panel.ts:14,48-60`.
  - Proposal:
    - Add `pi-cosmic-ui/src/boundary/host-overlay.ts` with a `./boundary/host-overlay` package export. It holds `finishOwnedOverlay(tui, handle, done)`, moved verbatim from ask-user, and one `inertOverlayComponent()`. mcp-ui-manager-7 suggested `host-viewport.ts` as the home instead, and mcp-auth-9 `host-input-dock.ts`.
    - The three inline sites capture `const done = hostDone` and call the helper inside their existing try/catch. The local `neutral`/`inert` copies become imports.
    - Update `docs/architecture/pi-boundaries.md` and the owned-overlay lines in ARCHITECTURE.md.
  - **src 9 / test 0 · risk low · effort S.** The scope is the same, so I kept the lower estimate: X-dup-12 says 9 and the narrowed X-boiler-5 says 15-20.
  - Why behavior holds: the hide → inert guard → done → guard.hide order and the catch → reject paths are unchanged.
  - Subsumes mcp-ui-manager-7 and mcp-auth-9. The full lifecycle extraction is under Needs a decision.

### F. Extension entrypoints: 1 entry, src 45

- **F1 · X-dup-4 + X-boiler-7**: Replace the pass-through `extension.ts` functions and register hops with default re-exports.
  - Locations:
    - `packages/{pi-ask-user,pi-background-task,pi-code-mode,pi-cosmic-ui,pi-code-previews}/src/extension.ts:1-7`
    - `packages/{pi-herdr-btw,pi-mcp}/src/extension.ts:1-6`
    - `packages/pi-better-openai/src/extension.ts:1-12`
    - `packages/pi-cosmic-ui/src/application.ts:68-70`
    - `packages/pi-better-openai/src/application.ts:88-90`
    - `packages/pi-code-previews/src/application/lifecycle.ts:93-95`
    - `packages/pi-ask-user/index.ts:2`, `packages/pi-code-previews/index.ts:7`
  - Proposal:
    - Use `export { registerX as default } from "./application.ts"`, the form better-xai and directory-models already use. ask-user and code-previews keep their named `askUser` and `codePreviews` aliases.
    - Delete the three register → `*WithDependencies` hops by giving `*WithDependencies` a default dependencies parameter.
    - Keep `registerBetterOpenAIApplication` as an alias, or update `compaction-context.test.ts` (2 lines).
    - Leave pi-subagents alone: its lazy child gate is real logic.
  - **src 45 / test 0 · risk low · effort S.**
  - Why behavior holds: the Pi 0.85 and 0.86 loaders call `await factory(load.api)` with one argument and never read the factory's name or length. Return values, including code-previews' Promise, are unchanged.

### G. pi-mcp listener sets: 1 entry, src 26

- **G1 · X-boiler-8**: Shared snapshot-notify and scoped-subscribe helpers.
  - Locations: `packages/pi-mcp/src/auth/flow.ts:68-81`, `packages/pi-mcp/src/discovery/service.ts:77-80,476-485`, `packages/pi-mcp/src/results/service.ts:39-47,235-245`, `packages/pi-mcp/src/manager/service.ts:36-48,185-194`, `packages/pi-mcp/src/activity/service.ts:80-83`. mcp-connection-discovery-3 adds `packages/pi-mcp/src/connection/registry.ts:658-667,699-712`.
  - Proposal:
    - Add `notifyListeners(listeners, ...args)` (snapshot, has-check, `invokeHostCallback`) to core `coordination/`.
    - Add `scopedListener(set, listener, guard = identity)`, an acquireRelease add/delete in which the registry passes `withLock`. Put it in core as a generic scoped-resource primitive, or keep it local to pi-mcp, since only pi-mcp uses it.
    - results keeps its closed check through `Effect.suspend`.
    - Leave discovery's unguarded `changed` loop as it is.
  - **src 26 / test 0 · risk low · effort S.** The registry sites would add a few more lines; the mcp section estimates about 33 for the subscribe side alone at five sites.
  - Why behavior holds: manager and results are unchanged. activity and auth/flow switch from iterating the live set to iterating a snapshot, which differs only when a listener adds another listener during delivery.
  - Subsumes mcp-connection-discovery-3 and mcp-ui-manager-9.

### H. Small helper reuse: 2 entries, src 18

- **H1 · X-boiler-10**: Export pi-code-previews `getTextContent` and reuse it.
  - Locations: `packages/pi-code-previews/src/tools/data/results.ts:17-26`, `packages/pi-background-task/src/tools/background-task.ts:62-67,116-121`, `packages/pi-better-openai/src/image/register.ts:87-91`, `packages/pi-better-openai/src/image/compact-summary.ts:37-40`, `packages/pi-subagents/src/tools/compact-parent-summary.ts:71-75`.
  - Proposal: Export it from `index.ts` with a `ReadonlyArray` parameter and replace the 5 inline filter/map/join chains. Leave openai `presentation.ts:28`, which strips each part, and the subagents `render.ts` separator as they are.
  - **src 14 / test 0 · risk none · effort S.**
  - Why behavior holds: `join` already renders undefined as "", and all 5 files already import pi-code-previews.
- **H2 · X-dup-11 (openai part)**: Declare `ResolvedConfig extends ScopedConfigMetadata` in `packages/pi-better-openai/src/config/schema.ts:13-18`.
  - **src 4 / test 0 · risk none · effort S.**
  - Why behavior holds: it is a type-only change. The fields become readonly, and nothing assigns them. better-xai-dirmodels-5 and ui-manager-7 cover the xai and cosmic-ui halves.

### Covered by per-package findings (0 counted here)

- **X-boiler-9 (45)**: derives ExecutionReceipt(s), CodeModeStatus, ResultReadPresentation/InitialPreviewPresentation and CompactIssue(s)/CompactIssueClaim from their schemas. This is fully covered by codemode-tools-3 (18), codemode-tools-4 (13), codemode-tools-5 (17, which also drops implied checks) and previews-tools-8 (19), 67 lines in total.
- **X-shared-7 (19)**: builds the bt config store on `makeScopedConfigStore` and uses `resolveCommittedConfig` in code-mode. This is covered by background-task-7 (18) and codemode-ui-rest-6 (8). Use `AgentDirectory.use`, not `asEffect`, which does not exist in effect rc.112.
- **X-shared-8 (8)**: returns the openai usage decision in core's shape. This is covered by better-openai-12 (8), which also drops the always-true `clearUsage` option.
- **X-shared-9 (38 src / 9 test)**: deletes `renderToolSections`, `isCompactIssues` and the `withoutFailureBodyIssues` alias. This is covered by ui-activity-app-6 plus T-ui-22 (33/10) and previews-tools-13 (9). One piece is left: drop `"./manager/settings-adapter"` from `packages/pi-cosmic-ui/package.json:46` (1 line; ARCHITECTURE already calls the adapter private). Keep `./manager/viewport`, which `README.md:76` documents.

### Structural notes (unverified)

- **Owned-overlay lifecycle, ~150-250 lines:** re-implemented in 6 hosts: cosmic-ui activity, mcp `openMcpOverlay` and the auth panel, the ask-user TUI host, and the code-mode and better-xai settings surfaces. The ordering of close, dispose and abort differs per site; E4 is the safe first step.
- **Two Herdr CLI clients, ~120-150 lines of overlap:** btw `herdr-client.ts` (444 lines) and subagents `herdr-cli.ts` (857 lines) plus `herdr-environment.ts` share the runner wrapper, exit/timeout mapping, error envelope and schemas. Error codes (case), bounds and protocol gates differ, so unifying them changes observable codes.
- **POSIX process-group termination, ~120 lines of overlap beyond C1:** in bt `local-process`, subagents `process-tree`, and core `duplex-process`/`process.ts`. Error types, timeouts and cleanup ordering differ.
- **Owned abort-signal forwarding, ~30 lines:** hand-rolled 6+ times: core `ownAbortSignal` (private), cosmic-ui `snapshotHostAbortSignal`, the code-mode execution owner, the ask-user proxies, the subagents catalog, and mcp keychain/stdio. Hostile-signal handling differs per site.
- **Own-data-property readers, ~20-30 lines:** about 7 copies in mcp and subagents with different result shapes. A tri-state core reader could replace them; sub-config-profiles-10 already merges three of them within subagents.
- **"Commit to the preferred scope with the other scope as fallback", ~20-30 lines:** core usage-controller, openai `persistFast`, cosmic-ui `modifyFooterConfig` and code-mode `applyChange` could share a ScopedConfigStore method, but their strictness differs.
- **Settings-list-surface host-guard wiring, ~25 lines:** better-xai, code-mode and cosmic-ui controllers. A cosmic-ui helper taking (tui, theme, keybindings) could supply it.
- **Full-screen manager opener, ~15-20 lines beyond E1:** bt `openTaskManager` and three subagents openers (viewport, custom overlay, attach, ticker, dispose). Refresh and ticker policy differs.
- **ask-user owned-call registry, ~40-50 lines:** `host-proxy.ts` and `host-form-proxy.ts` duplicate it. This is intra-package, so the ask-user review owns it.
- **Missing core test helper, ~30 test lines:** a recording option on `makeInMemoryDocuments` would save about 15 lines each in bt `config.test.ts` and code-mode `store-atomic.test.ts`.
- **Preview-settings loader type, ~10 lines:** restated 6 times, but optional and required `signal` variants differ.
- **Compact custom-message presentation, ~10 lines:** ask-user `async-tool-render` and openai image presentation. Padding and width handling differ.
- **Unused re-exports in pi-code-previews, ~9 lines:** `index.ts`/`testing.ts` re-export 8 package-author types with no consumer, plus `CompactIssuesSchema`. Removing them narrows the documented API.
- **Tolerant raw config reads, ~10 lines:** cosmic-ui `readRawConfigTolerantly` and code-mode `readOtherScope` could use core `readConfigOrWarn(path, true, ...)`, but the call reads awkwardly.
- **One more decode copy, ~5 lines:** subagents `tools/details-schema.ts:627-642` `safeDecode` is not in B3's list.
- **Whole-details `freezeSnapshot` in `retention.ts`, ~24 lines, left out:** it would deep-freeze the unvalidated `resultRead` and `initialPreview`, and a ProjectionError would land on the failure path. D1 takes the safe part.
- **Micro duplicates below the reporting bar, ~10 lines total:**
  - `boundedMiddle` (cosmic-ui and subagents model pickers)
  - subagents `windowStart` versus `listWindowStart`
  - `exactDecodeOptions` ×3, `PositiveIntegerSchema` ×3
  - `BoundedId`/`BoundedPath`, `JsonObjectSchema` ×2, `shellQuote` ×2
  - `.then(() => undefined)` ×12
- **Checked and not worth doing (0 lines):**
  - the 67 Effect service declarations, which are the boundary seams tests replace
  - 106 tagged errors, which are nominal types
  - openai `host-ui` aliases (44 call sites)
  - subagents locks and process transport versus core primitives (different semantics; Windows support)
  - bt/subagents TaggedErrors, the code-previews diff parser versus the cosmic-ui git parser, the bt manager versus the subagents fleet, mcp stdio, openai/xai usage formatting, and the compact-description tables

### Needs a decision

- **X-dup-8: move the subscription-usage config into core (20 lines; one verifier adjusted, one rejected).**
  - For: openai and xai repeat the usage type, `DEFAULT_USAGE_CONFIG` (60000/true/true), a 9-line tolerant decoder and the help/diagnostics verbs.
  - Against: core ARCHITECTURE and the `makeUsageSettingDescriptors` comment say provider schemas and defaults stay provider-owned and wording is caller-supplied. Only a type-only `SubscriptionUsageConfig` (about 6 lines) fits the docs; it pairs with H2 and better-xai-dirmodels-5.
- **Full `openOwnedOverlay` extraction (X-boiler-5's unnarrowed variant, about 45-55 lines, medium risk).**
  - For: generalizing mcp `openMcpOverlay` would retire the cosmic-ui activity overlay's duplicate state machine.
  - Against: the activity overlay publishes `binding.close`, and `release()` calls it synchronously. The shared helper would need a close-exposure hook. Without one, a released binding leaves a mounted overlay whose Effect never resumes.
- **Sharing the Herdr environment key lists through core (part of X-dup-5, dropped by its verifier).**
  - For: 18 keys repeat across btw and subagents.
  - Against: each allowlist is package-owned security policy, the lists are not a clean prefix (XDG keys are interleaved), and sharing them couples two packages' environment policy.
