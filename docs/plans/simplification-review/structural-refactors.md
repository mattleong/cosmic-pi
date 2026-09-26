# cosmic-pi structural refactors: synthesized review

This report covers the structural-refactor pass of the cosmic-pi simplification review. Three independent reviewers (behavior, feasibility/LOC, justification) vetted each proposal. This document merges overlapping proposals, folds in every reviewer's required changes, ranks the result, and orders it into landable batches. It is a plan only. No repository file was changed.

## How to read the numbers

- All LOC figures are **net lines removed**. A negative number means lines are added.
- "Vetted" is the conservative figure recorded by the review data: the lowest source and test savings any reviewer accepted.
- When proposals overlap, the merged entry uses the **lowest** vetted figure among its sources, or subtracts the overlap explicitly. No line is counted twice. Every such adjustment is stated in the entry.
- "Architect estimate" is the original proposal figure, shown for comparison only.
- Test-kit additions under `src/testing/` count as source lines, because they live under `src/` in published packages.

## Summary

### Totals

35 proposals were accepted. After merging, 28 refactors remain: 12 of the proposals overlapped and were folded into 5 merged entries (E-sup, E-rpc, E-proctree, E-surface, E-footer).

|                                                                                     |     Source |      Tests |
| ----------------------------------------------------------------------------------- | ---------: | ---------: |
| All accepted refactors (vetted)                                                     | **−4,528** | **−3,539** |
| Excluding the two shared test kits (X-tests-R1/R2)                                  |     −5,068 |     −2,739 |
| With the test kits at the narrowed scope reviewers recommend (≈ +80 and +40 source) |   ≈ −4,948 |     −3,539 |

The workspace has about 130k source lines and 130k test lines, so this is roughly 3.5% of source and 2.7% of tests. More important, it removes a set of duplicated mechanisms (listed under Themes) that each had to be kept in sync by hand.

The 3 disputed proposals (vetted −125 source, +31 tests combined) and the 2 rejected proposals are **not** in these totals.

### By package

Entries confined to one package:

| Package                          | Entries                                                            |     Source |      Tests |
| -------------------------------- | ------------------------------------------------------------------ | ---------: | ---------: |
| pi-subagents                     | E-sup, E-rpc, sub-run-R1, sub-settings-R1..R4, sub-presentation-R2 |     −1,604 |       −342 |
| pi-cosmic-ui                     | E-footer (ui-R2 + ui-R1), ui-R3                                    |     −1,035 |       −755 |
| pi-better-xai + pi-better-openai | providers-R1                                                       |       −355 |       −440 |
| pi-mcp                           | mcp-core-R1, mcp-core-R2, mcp-boundary-R1, mcp-core-R3             |       −323 |       −141 |
| pi-code-mode                     | code-mode-R1, R2, R3                                               |       −315 |       −330 |
| pi-code-previews                 | previews-render-R1                                                 |       −163 |        −53 |
| pi-ask-user                      | ask-user-R1                                                        |       −114 |         +5 |
| pi-background-task               | background-task-R3                                                 |        −75 |         +2 |
| **Subtotal**                     |                                                                    | **−3,984** | **−2,054** |

Cross-package entries. The reviewers did not vet a per-package split for these, so they are shown whole.

| Entry                                                 | Packages                                         |   Source |      Tests |
| ----------------------------------------------------- | ------------------------------------------------ | -------: | ---------: |
| sub-infra-R1 (writer lease on CrossProcessLock)       | pi-subagents, pi-cosmic-core                     |     −575 |       −470 |
| E-surface (one owned custom-UI surface host)          | pi-cosmic-ui plus 7 consumers                    |     −234 |       −120 |
| core-R2 (one JSON-document contract and scoped store) | pi-cosmic-core plus 5 consumers                  |     −170 |        −75 |
| E-proctree (one process-tree terminator)              | pi-cosmic-core, pi-subagents, pi-background-task |      −60 |          0 |
| providers-R2 (shared provider settings command)       | pi-cosmic-ui, pi-better-xai, pi-better-openai    |      −45 |        −20 |
| X-tests-R1 (thin presentation test helpers)           | pi-code-previews plus 6 consumers                |     +330 |       −420 |
| X-tests-R2 (shared Pi host test fixtures)             | pi-cosmic-core plus ~11 consumers                |     +210 |       −380 |
| **Subtotal**                                          |                                                  | **−544** | **−1,485** |

### Themes that explain most of the excess

Each accepted entry is assigned to one primary theme below. The five themes add up exactly to the totals above.

| Theme                                                                                     | Entries                                                                                                          | Source |  Tests |
| ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------- | -----: | -----: |
| A. Feature packages rebuilding mechanisms that core, Pi, or another package already owns  | sub-infra-R1, E-rpc, E-sup, providers-R1, E-surface, core-R2, mcp-core-R1, mcp-core-R2, E-proctree, providers-R2 | −2,376 | −1,346 |
| B. Dormant, retired, or superseded features and compatibility layers still shipped        | ui-R2, sub-settings-R1, code-mode-R1, previews-render-R1, code-mode-R2                                           | −1,118 |   −813 |
| C. Asynchronous Effect layers wrapped around synchronous host work                        | ui-R1, ui-R3                                                                                                     |   −660 |   −240 |
| D. Hand-copied plumbing, and bespoke copies of shared components, inside one package      | sub-run-R1, sub-settings-R2..R4, mcp-boundary-R1, ask-user-R1, sub-presentation-R2, background-task-R3           |   −918 |    −25 |
| E. Test scaffolding copied per package, and production fallbacks kept only for test fakes | X-tests-R1, X-tests-R2, code-mode-R3, mcp-core-R3                                                                |   +544 | −1,115 |

**A. Parallel platform mechanisms.** The same protocol is implemented twice:

- pi-subagents has a second cross-process lease (writer-lease.ts, 834 lines) next to core's CrossProcessLock, and a second JSONL RPC stack (rpc-session.ts, 500 lines) next to its own process-transport.
- Delegated Pi reaches its parent through an extra helper process speaking a private MCP dialect, although it could use the Effect RPC client directly.
- Both provider packages keep their own auth.json credential stack next to Pi's model registry. xAI also writes that file, which races Pi's lock.
- The Pi overlay close workaround is copied into five places and missing from five others.
- A Windows taskkill terminator exists twice, and group-signal classification about six times.
- The JSON-Schema policy exists twice, bounded-JSON walkers four times, and scoped config resolution twice in core.

**B. Retired features still shipped.** Examples:

- Footer media surfaces have had no producer since the package was created.
- A pre-dashboard editor protocol remains after the dashboard replaced it.
- code-mode keeps three superseded details formats and legacy runtime hooks, plus an expanded-ownership path that production never reaches.
- A third word-emphasis refinement level changes output in a few blocks per ten thousand.

**C. Asynchronous layers around synchronous work.** The footer registry and the working-row timer do only synchronous host callbacks. Wrapping them in Effect services, ingress queues, and forks created race windows, and those windows then needed double-checking protocols.

**D. Plumbing inside a package.** Examples:

- Fifteen run-module dependency bags.
- Synthetic action re-tagging undone at every boundary.
- Model rows projected three times.
- Two copies of the SDK connection state machine.
- Two copies of the owned-request pipeline in ask-user.
- The task contract written three or four times.

**E. Test scaffolding.** Fake hosts, themes, settings save/restore blocks, execution environments, and service fakes are copied per package. In pi-mcp, production contracts keep optional members and fallback branches only because test fakes omit them.

## Merges and overlap adjustments

| Merged entry                                                               | Source ids                                | How LOC was reconciled                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------------------------------- | ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E-sup: delegated Pi talks to the supervisor in-process                     | sub-exec-R1, X-process-R1                 | Same design. Lowest vetted: 250 source (both), 130 tests (X-process-R1).                                                                                                                                                                                                                                   |
| E-rpc: delete rpc-session.ts                                               | sub-exec-R2, X-process-R2                 | Same deletion. Lowest vetted: 460 source and 115 tests (X-process-R2, without the optional model-catalog step).                                                                                                                                                                                            |
| E-proctree: one process-tree terminator                                    | core-R1, background-task-R1, X-process-R3 | Same subsystem. Lowest vetted: 60 source and 0 tests (background-task-R1). The other vetted figures were 150/30 and 97/25.                                                                                                                                                                                 |
| E-surface: one owned custom-UI surface host                                | X-presentation-R1, ui-R4, ask-user-R2     | X-presentation-R1 (200/120) is a superset of ui-R4 (35/10), so ui-R4 is not added. ask-user-R2's host merge overlaps the ask-user part of X-presentation-R1. Only its dialog hide/resume move is added: dialog.ts −16 and form-dialog.ts −18, measured by ask-user-R2's behavior reviewer. Total: 234/120. |
| E-footer: retire footer media surfaces, then make the registry synchronous | ui-R2, ui-R1                              | ui-R2's vetted 375/515 was measured "as sequenced after ui-R1". ui-R1's 340/210 was measured on today's code. Their sum, 715/725, is the shared end state and does not depend on landing order.                                                                                                            |
| providers-R2 (standalone entry)                                            | providers-R2                              | Vetted 70/20 includes deleting xAI host-ui.ts and adding a guarded opener, which E-surface already counts. About 25 lines are removed here: 71 deleted minus the ~48-line opener in providers-R2's feasibility helper breakdown. Counted as 45/20.                                                         |
| sub-settings-R4 (standalone entry)                                         | sub-settings-R4                           | sub-settings-R1 already removes `sectionKeyLabel`/`matchesSectionKey` from the save form that R4 deletes. About 5 lines are deducted. Counted as 135/38 (vetted 140/38).                                                                                                                                   |

Other overlaps need no LOC adjustment but do constrain ordering:

- core-R2 touches xAI auth.ts, which providers-R1 largely deletes. If providers-R1 lands first, core-R2's xAI edits disappear, including about 15 test lines of `updateObject` conversions.
- E-proctree changes writer-lease's `probeProcess`, which sub-infra-R1 deletes, and it changes rpc-session.ts, which E-rpc deletes. Those two sub-steps become moot.
- code-mode-R3's `registeredView` and theme helper overlap X-tests-R1/R2. Use the shared helpers; the line difference is negligible.
- X-tests-R2's `makeCustomSurfaceUi` would overlap providers-R2's move of the settings-controller tests. The narrowed X-tests-R2 scope drops that helper.

## Ranking

The ranking weighs lines and concepts removed against risk and effort. Dependencies are handled in the roadmap, not here.

|   # | Entry               | Ids                                       | Source | Tests | Risk   | Effort | Why it ranks here                                                                                               |
| --: | ------------------- | ----------------------------------------- | -----: | ----: | ------ | ------ | --------------------------------------------------------------------------------------------------------------- |
|   1 | E-footer            | ui-R2, ui-R1                              |   −715 |  −725 | low    | M+M    | Deletes a dormant subsystem, a pre-session buffer, an ingress queue, and an Effect service.                     |
|   2 | sub-infra-R1        | sub-infra-R1                              |   −575 |  −470 | medium | M      | Deletes an 834-line duplicate of a security-sensitive lock protocol.                                            |
|   3 | providers-R1        | providers-R1                              |   −355 |  −440 | low    | M      | Deletes two credential stacks and fixes a real lost-update and double-refresh race on auth.json.                |
|   4 | E-sup               | sub-exec-R1, X-process-R1                 |   −250 |  −130 | medium | L      | Removes a process hop and a private MCP dialect. It unblocks E-rpc (together: −710/−245).                       |
|   5 | E-rpc               | sub-exec-R2, X-process-R2                 |   −460 |  −115 | low    | M      | Deletes the second JSONL RPC stack and fixes a 10 s stall on numeric Codex error codes. Requires E-sup.         |
|   6 | ui-R3               | ui-R3                                     |   −320 |   −30 | low    | M      | Three state stores and a two-phase admission protocol become one module.                                        |
|   7 | sub-settings-R1     | sub-settings-R1                           |   −265 |   −65 | low    | M      | Removes a retired editor protocol and a second, receipt-less write path.                                        |
|   8 | E-surface           | X-presentation-R1, ui-R4, ask-user-R2     |   −234 |  −120 | medium | L      | Five hand copies of an ownership protocol become one. Fixes a real stuck-overlay bug on five unguarded screens. |
|   9 | code-mode-R1        | code-mode-R1                              |   −200 |  −120 | medium | M      | Retires three superseded details formats and a second lifecycle protocol.                                       |
|  10 | core-R2             | core-R2                                   |   −170 |   −75 | low    | M      | One JSON-document contract; drops five unreachable guards and a duplicate resolver.                             |
|  11 | mcp-core-R1         | mcp-core-R1                               |   −165 |   +20 | low    | M      | Two copies of the JSON-Schema policy become one, which ends the drift between them.                             |
|  12 | previews-render-R1  | previews-render-R1                        |   −163 |   −53 | low    | M      | Deletes a third refinement level that changes output in a few blocks per ten thousand.                          |
|  13 | sub-run-R1          | sub-run-R1                                |   −160 |   +15 | low    | L      | Replaces ~300 lines of restated dependency types with producer-derived types.                                   |
|  14 | sub-settings-R4     | sub-settings-R4                           |   −135 |   −38 | low    | M      | Removes a bespoke form that duplicates the name dialog. Needs UX sign-off.                                      |
|  15 | sub-settings-R2     | sub-settings-R2                           |   −130 |    −3 | low    | M      | Model rows are projected once instead of three times; removes six matchers and dead text.                       |
|  16 | sub-settings-R3     | sub-settings-R3                           |   −120 |     0 | low    | M      | Removes a second menu system and a second destructive-confirmation path.                                        |
|  17 | code-mode-R2        | code-mode-R2                              |   −115 |   −60 | low    | M      | Removes a dead ownership path (which duplicates the Program) and one duplicated view.                           |
|  18 | ask-user-R1         | ask-user-R1                               |   −114 |    +5 | low    | M      | One owned-call registry and one queued runner replace copies that have already drifted.                         |
|  19 | mcp-core-R3         | mcp-core-R3                               |     +4 |  −165 | low    | L      | Shared service fakes; contracts drop members that are optional only for fixtures.                               |
|  20 | mcp-boundary-R1     | mcp-boundary-R1                           |   −100 |     0 | medium | L      | One SDK connection driver; changes cancellation-critical close code.                                            |
|  21 | E-proctree          | core-R1, background-task-R1, X-process-R3 |    −60 |     0 | low    | M      | Few lines, but it removes a duplicated safety-critical subsystem (range −60 to −150).                           |
|  22 | sub-presentation-R2 | sub-presentation-R2                       |    −84 |    −6 | low    | M      | One tool catalog replaces a synthetic discriminant and three per-tool switches.                                 |
|  23 | background-task-R3  | background-task-R3                        |    −75 |    +2 | low    | M      | The task contract is defined once; persisted log details stop duplicating output.                               |
|  24 | mcp-core-R2         | mcp-core-R2                               |    −62 |    +4 | low    | M      | One bounded-JSON walker replaces three with drifting accounting.                                                |
|  25 | code-mode-R3        | code-mode-R3                              |      0 |  −150 | low    | M      | One execution harness replaces about 20 hand-built environments.                                                |
|  26 | providers-R2        | providers-R2                              |    −45 |   −20 | medium | M      | Shared settings command shell. Narrowed scope only.                                                             |
|  27 | X-tests-R2          | X-tests-R2                                |   +210 |  −380 | low    | M      | Shared casts, identity theme, and deferred helper. Narrowed scope is +40 source.                                |
|  28 | X-tests-R1          | X-tests-R1                                |   +330 |  −420 | low    | L      | Public settings and context helpers; ends deep imports into pi-code-previews/src. Narrowed scope is +80 source. |

## Accepted refactors

Entries follow the ranking order above. Each lists the reviewer-required changes merged from all three lenses. Where the lenses disagreed, the entry states the resolution taken here and why. The "Needs a decision" section repeats the conflicts that the maintainer should settle.

---

### 1. E-footer: retire footer media surfaces, then make the footer registry a synchronous store

- **Ids:** ui-R2 (retire the dormant media-surface subsystem) + ui-R1 (replace the Effect registry, protocol ingress, and pre-session buffer with one synchronous store)
- **Packages:** pi-cosmic-ui
- **Vetted LOC:** source −715, tests −725. That is ui-R1 −340/−210 plus ui-R2 −375/−515 as sequenced.
  - Architect estimates: ui-R1 −350/−260; ui-R2 −380/−515 after R1, or about −495 before R1.
  - Reviewers measured ui-R2 standalone at −470 to −555 source and −575 to −595 tests.
- **Risk / effort:** low / M + M

**Problem.** Footer contributions pass through three stacked layers. Each layer does only synchronous work:

1. A bounded pre-session buffer (`protocol/host.ts`, 150 lines). Its drain can yield, which is why it needs reservation, restoration, and reset-generation logic.
2. A core `makeSynchronousIngress` queue per session runtime.
3. `FooterRegistryService` (`registry.ts`, 315 lines): a SynchronizedRef with uninterruptible `serialized` transitions, a Scope per surface, and a mutable bridge object.

This asynchrony leaks outward. application.ts forks `setRenderRequest` with an `isCurrent` recheck, and `clearRenderRequest` goes through `slot.fork`, which is a no-op during `onDeactivated`.

About 380 source lines and 500 test lines support "surface" (media) contributions: image-line layout, attach/detach/dispose resources, the `footer.mediaPlacement` setting, and five host-callback operations. Nothing produces a surface. The only producer ever written (the Better OpenAI pets footer) was deleted in a377f77, the commit that created pi-cosmic-ui. Surfaces are also the only reason the registry needs render-request installation, attach suppression, and reentrancy handling.

**Target design.**

Step 1 (ui-R2):

- Remove the surface kind end to end:
  - protocol types, schema and receiver plumbing (`decodeUpsertSafely` becomes the existing `decodeSafely`);
  - the canonicalization receiver binding (canonicalization becomes a WeakSet identity check plus `Object.freeze`);
  - the registry's surface lifecycle;
  - component placement, and layout.ts lines 86–181;
  - the five `surface-*` host-callback operations;
  - `mediaPlacement` in config and settings.
- A surface upsert then fails decoding and is ignored like any other invalid upsert.
- `COSMIC_UI_PROTOCOL_VERSION` stays at 2.

Step 2 (ui-R1):

- The registry becomes a plain synchronous module, `makeFooterRegistry(callbacks)`, with `snapshot/upsert/remove/invalidate/requestRender/clear`.
- A small trampoline queues reentrant protocol events behind the current operation.
- `protocol/host.ts`, `FooterRegistryService`, and `FooterRegistryBridge` are deleted.
- application.ts calls the store directly from its existing `onProtocolEvent` handlers.
- Render-request ownership moves into `footer/installation.ts`. `requestRender()` calls the active instance's `tui.requestRender` through `callbacks.invoke`.
- Core `makeSynchronousIngress` stays, because other packages use it.

**Justification.** Together these delete a whole dormant subsystem, including the most intricate terminal-escape logic in the footer (image-line regexes and cursor balancing). They also delete a buffer state machine, an ingress worker, an Effect service, a bridge object, per-surface Scopes, and the forked render-request protocol. The registry ends as a keyed map of frozen text/status values of about 55–85 lines. The package already keeps comparable synchronous host state in `footer/installation.ts` and `host-activity.ts`.

State the justification as simplification only. The two "real gaps" ui-R1 claimed cannot be observed in Pi 0.86:

- Pi reloads extensions after `session_shutdown`.
- The deactivation no-op is harmless, because runtime disposal clears the registry anyway.

**Behavior changes.**

- `/cosmic-ui` loses the inert "Media placement" row.
- Third-party `kind: "surface"` upserts are ignored.
- A stale `footer.mediaPlacement` key on disk is ignored and left in place.
- Protocol events now apply synchronously inside `pi.events.emit`, so renders happen slightly sooner.
- The TUI component's `invalidate()` now runs synchronously.
- Invalidate events no longer take buffer slots. This fixes today's eviction of an upsert by later invalidates.
- The published `pi-cosmic-ui/protocol` export loses `CosmicFooterSurfaceContribution`, `CosmicFooterSurfaceRenderOptions`, `CosmicFooterPlacement`, and the `"media"` region. This breaks TypeScript consumers at compile time.
- Text and status contributions, host query/state, hidden ids, and layout are unchanged.

**Convention changes.**

- Add one narrow exception sentence to `docs/architecture/effect-v4.md`. It names this registry and ui-R3's working row as synchronous presentation state driven only by synchronous Pi events, whose only effect is a guarded host UI write. Such state must use core `synchronousNow` and the shared host ticker pool. Word it like the existing Shiki and host-query carve-outs, not as a general rule. Write it once, shared with ui-R3.
- Update:
  - pi-cosmic-ui ARCHITECTURE.md: rewrite the footer paragraphs in full (line 19), line 21, and the lifecycle-diagram line "protocol events → bounded buffer → scoped host → registry snapshot";
  - docs/architecture/pi-boundaries.md: line 115, the Cross-extension events paragraph, and the generation-guard sentence that mentions ingress;
  - README.md: line 49 (the `"mediaPlacement"` config example) and line 80 (the "or media" wording and the "Media contributions…" sentence).

**Risks.**

- This removes public protocol API: the package is published at 0.2.0. It needs maintainer sign-off and a release note. Keep the protocol version at 2, because bumping it would break text producers when versions differ.
- The trampoline must keep today's ordering: attach before publish, dispose the old entry before rendering, and suppress renders during clear.
- The Effect-first stance may resist the exception; keep it narrow.

**Reviewer-required changes.**

ui-R2:

1. Land ui-R2 **before** ui-R1, independently of it. Re-scope ui-R1 against the post-removal registry (about 84–110 lines).
2. Move render-request ownership in its own commit. Either keep `setRenderRequest` as a trivial setter with its `expectedCurrent` guard, or move it into `footer/installation.ts`. If moved:
   - add installation-level tests proving that a stale or disposed footer instance can neither receive nor clear the active request;
   - drop the registry's `HostCallbackBoundary` dependency in layer.ts.
3. Replace `decodeUpsertSafely` with `decodeSafely(UpsertData, value)`.
   - Merge the text/status normalization branches, keeping two `// SAFETY:` casts (exactOptionalPropertyTypes and the anti-slop lint require them).
   - Remove the now-unused imports (`detachCosmicFooterContributionFromReceiver`, `sanitizeTerminalStyledText`, `CosmicFooterPlacement`) and the "Surface wrappers" doc comment.
4. Tests:
   - Rewrite the surface part of `tests/host-service.test.ts` (about lines 133–190) to use text contributions only.
   - Retarget, do not delete, the extension test "shutdown during startup survives throwing surfaces and releases every probe". Keep `pending.aborted() === 2` and the last `setFooter(undefined)`.
   - Retarget the hostile-getter test to a text contribution. Observe it through render output or a requestRender spy, and keep the read-once assertions.
   - Keep the text-relevant registry coverage currently written with surface fixtures:
     - a stale owner cannot clear a replacement render request;
     - `requestRenderNow` is a no-op after scope close;
     - a throwing render request is isolated, with bounded diagnostics;
     - a canonical re-upsert keeps snapshot identity and still renders.
   - Add one small test: the snapshot is published before render is requested, removing a missing id does not render, and closing clears the snapshot.
5. Optional: drop the `FooterContributionView.invalidate → bridge.invalidate → protocolInvalidate` chain, which exists only to forward theme invalidation to surfaces.

ui-R1:

1. A same-identity upsert must still call `renderNow()`. Today's `afterPublish` hook always renders.
2. Clear on `onDeactivated` only when that token had activated: record the token in `onActivated`. Clear after `footerInstallation.uninstall()`. Keep the unconditional, generation-guarded clear in the `session_shutdown` continuation. Add an extension test: pre-session upsert, failed first start, good second start, and the contribution is still present.
3. The 128-entry cap: reviewers disagree (see Needs a decision). The recommended resolution:
   - Always bound the trampoline to 128 reentrant operations per outermost drain, dropping the excess like today's ingress overflow. Reset `pending`/`running` in `finally`.
   - Cap _distinct keys_ at 128 only while no session is active. That keeps the documented pre-session bound without adding an in-session limit.
   - Document the chosen rule in pi-boundaries.md and ARCHITECTURE.md.
4. Isolate each queued operation with try/finally so a throwing operation cannot strand queued work or escape into a producer's `pi.events.emit`.
5. Detach contributions (`detachCosmicFooterContribution`) when the event is emitted, before enqueueing, not inside the deferred closure.
6. Expose `requestRender()`. Wire the component's `invalidate` to the store, or drop that chain as in ui-R2 step 5.
7. Merge migration steps 1 and 2: do not land an unused `registry-store.ts`.
8. Port every registry test one for one, and add reentrancy tests:
   - an operation that upserts during itself;
   - a dispose that upserts during clear;
   - a self-perpetuating invalidate that must terminate.
9. These points only matter if ui-R1 lands first; they become moot once ui-R2 removes surfaces:
   - revoking a surface's captured render capability across clears (epoch check);
   - holding events that are emitted during a surface render.

**Migration steps.**

1. ui-R2, one commit: remove the surface kind end to end, together with the matching tests (retarget the hostile-getter and startup-shutdown tests). Run `pnpm --filter pi-cosmic-ui test`.
2. ui-R2: remove `mediaPlacement` from the config schema/store and the settings row. Update README.md and ARCHITECTURE.md. Package tests.
3. ui-R2: move render-request ownership into installation (or keep the trivial setter), with the installation-level stale-owner tests. Package tests.
4. ui-R1: add the synchronous store with all ported registry tests and reentrancy tests. Wire application.ts, layer.ts, and installation.ts to it. Delete `FooterRegistryService`, `FooterRegistryBridge`, `protocol/host.ts`, and the FooterProtocolBuffer tests in the same commit. `extension.test.ts` protocol and shutdown cases must pass unchanged.
5. Update ARCHITECTURE.md, pi-boundaries.md, and the effect-v4.md exception. Run `pnpm validate`. If the release carries the protocol type removal, run `pnpm version:check`.

---

### 2. sub-infra-R1: rebuild the pi-subagents writer lease on pi-cosmic-core CrossProcessLock

- **Ids:** sub-infra-R1
- **Packages:** pi-subagents, pi-cosmic-core
- **Vetted LOC:** source −575, tests −470. Architect estimate −600/−520. Reviewer range −575 to −610 source, −470 to −530 tests.
  - Split: pi-subagents about −584 source and −505 tests; core about +9 source (tryAcquire) and +35 tests.
- **Risk / effort:** medium / M

**Problem.** `src/boundary/writer-lease.ts` (834 lines) hand-rolls the same same-host lease that core's CrossProcessLock already owns, tests (547 lines), and ships to pi-mcp. It includes:

- an exclusive-mkdir slot with two-phase owner evidence (`reserved` → `spawn-started`);
- stable reads, durable O_EXCL writes, and a temp+rename phase transition;
- `kill(pid,0)` liveness, dead-owner takeover through a tombstone rename, and token-checked tombstone release;
- test-only interruption seams.

The phases map one to one: reserved = quiescent, spawn-started = native-pending. Core's version also closes writer-lease's crash window between mkdir and the evidence write. Every consumer (writer-preparation, record-cleanup, workspace-control, launch, resume) uses only `WriterLeaseContract`.

**Target design.**

- Core: add `CrossProcessLockContract.tryAcquire(namespace)`. It performs the single retry after retiring a dead quiescent owner internally, so its contract is "`undefined` means a live owner holds the slot"; the caller owns release.
- writer-lease.ts becomes a thin adapter of about 200–260 lines. It keeps:
  - the public contract;
  - canonicalization (realpath + bigint dev/ino + sha256 digest);
  - the win32 and identity checks;
  - the error classes.
- The lease holds a shared ownership phase (`reserved | spawn-started | uncertain | released`). This is needed because the writer-preparation finalizer releases the _unmarked_ copy of the lease.
- A legacy-v2 guard fails closed when a `writer-leases-v2` slot exists.
- The evidence schema, stable-read machinery, liveness probe, takeover, tombstone release, and test seams are deleted. Consumers do not change.

**Justification.** One audited implementation of a security-sensitive protocol replaces two. Future PID-reuse, ABA, and durability fixes then land once for pi-mcp and pi-subagents. CLAUDE.md already puts shared platform code in core, and core's own admission rule (multiple consumers of one contract) is met.

**Behavior changes.**

- The run lifecycle does not change.
- On-disk format and location change (v2 → v3). A leftover v2 slot, including a crash-left dead `reserved` one, now needs one-time manual recovery.
- Cross-process conflict messages no longer name the other session's run, session, or pid.
- Normal releases leave no permanent tombstone.
- Acquire, mark, and release are short synchronous commits.
- Every failed mark quarantines the pool until restart. Today some failure points release cleanly.
- Release from spawn-started needs a durable settle write first. ENOSPC or EIO at release quarantines the pool and leaves native-pending evidence that needs manual recovery.
- An unsafe root mode is rejected instead of repaired with chmod.
- EPERM liveness reads as "live".

**Convention changes.** None in CLAUDE.md. Document `tryAcquire` in core ARCHITECTURE.md. Depending on the lock-root decision, core's "Owned test boundary only" wording for `NativeLockOptions.directory` may change.

**Risks.**

- While old and new versions run side by side, exclusion only works one way: old processes cannot see v3 locks. Ship an upgrade note telling users to restart all Pi sessions.
- Synchronous fsync commits run on the host thread, which pi-mcp already accepts.
- Core release semantics differ (deferred while native-pending, silent no-op after uncertain). The adapter must fail closed. This is pinned by tests.

**Reviewer-required changes.**

1. **Lock root (needs a decision).** Behavior and feasibility prefer keeping a per-agent-directory root, `<agentDir>/subagents/writer-leases-v3`: amend `NativeLockOptions.directory`'s doc (cross-process-lock-node.ts:13) and core ARCHITECTURE.md to allow a caller-owned private production root, and create `<agentDir>/subagents` with the existing `ensurePrivateDirectory`. Justification prefers core's default per-OS-user root, namespace `pi-subagents/writer-cwd\u0000<digest>`, plus a test-only `lockDirectory` option (the pi-mcp credential-store pattern) used in writer-lease, workspace, and git-worktree tests. That also excludes writers across different agent directories. Recommended: the per-agent-directory root, because it preserves behavior, unless maintainers want cross-agent-directory exclusion.
2. Retry inside core `tryAcquire`: the adapter calls it once.
3. Make the acquire commit uninterruptible after the async legacy check: wrap `tryAcquire` plus lease construction in `Effect.uninterruptible`, so a live handle cannot leak on interruption.
4. Before calling `mutationStarted`, `mutationSettled`, or `release` on the core handle, set the shared phase to `uncertain`. Advance it only on success. Any throw then fails closed, so a later release can never succeed as a silent no-op. Prefer an opaque lease: a module-private WeakMap keyed by the lease object, with `markSpawnStarted` returning the same object. That keeps the core handle out of the public type, so test fakes never build handles. An unknown lease fails closed.
5. Remove the dead `ownerPid/ownerSessionId/ownerRunId` fields from `WriterLeaseConflictError`:
   - use a constant `activeId` in `mapWriterLeaseConflict`;
   - update the harness fake;
   - update the `writer-ownership.test.ts:472` expectation.

   Alternatively, implement the bounded core owner-label follow-up in the same change.

6. Legacy-v2 guard:
   - `lstat` the exact `writer-leases-v2/<digest>.lease` path. ENOENT proceeds; anything else is a `recovery-required` conflict.
   - The message names that path and warns that it may belong to a still-running older session, so nobody removes it until every older session has exited.
   - Mark the guard as a temporary migration shim and record its removal criterion in local-backends.md.
7. Adapter tests with a fake CrossProcessLock layer:
   - mark calls `mutationStarted`, so a dead owner after mark means recovery-required rather than reclaim;
   - a second `tryAcquire` after a retire returns a lease;
   - recovery-required maps to a conflict;
   - a failed mark followed by release fails, and the slot stays held;
   - a failed settle or release keeps failing on retry;
   - releasing a marked lease settles before it releases;
   - releasing the unmarked copy after a mark frees the slot;
   - a live conflict between two service instances;
   - the legacy guard.

   Add core `tryAcquire` tests that reuse the child fixture's `pending` mode.

8. Correct `behavior_changes` as listed above.
9. Update:
   - README.md:250 (the v2 path);
   - docs/local-backends.md: collapse the protocol-v2, ESRCH, tombstone, and PID-reuse paragraphs into a core reference plus the legacy guard, and update module responsibilities;
   - ARCHITECTURE.md (the writer-preparation sentence);
   - docs/completion-delivery.md (the tombstone wording);
   - docs/architecture/pi-boundaries.md (the writer-lease bullet);
   - the stale comments at writer-preparation.ts:97–98 and workspace-control.ts:462–463.

**Migration steps.**

1. Core: add `tryAcquire` (with the internal retry), its tests, and ARCHITECTURE.md text. Run `pnpm --filter pi-cosmic-core test`.
2. pi-subagents, preparatory: switch test code off lease internals. That means `lease.runId` in `writer-ownership.test.ts`, and the re-acquire that `run/workspace.test.ts` already performs in place of the `writerLeasePath` probe. Package tests.
3. pi-subagents: replace writer-lease internals with the adapter (opaque ownership, legacy guard, root choice). Rewrite `tests/writer-lease.test.ts`, delete `tests/fixtures/writer-lease-child.mjs`, and simplify the harness fake. Package tests.
4. Docs and comments. Run `pnpm validate`. Add the release note about restarting all sessions.

---

### 3. providers-R1: let Pi's model registry own subscription credentials

- **Ids:** providers-R1
- **Packages:** pi-better-xai, pi-better-openai (the optional pi-cosmic-core follow-up is not counted)
- **Vetted LOC:** source −355, tests −440. Architect estimate −370/−450.
- **Risk / effort:** low / M

**Problem.** Both provider packages build a second credential stack next to Pi's own. Pi 0.86 already ships the `xai` and `openai-codex` OAuth providers. `getProviderAuth` refreshes under proper-lockfile when less than 5 minutes remain and saves the result.

pi-better-xai `auth/auth.ts` (315 lines) re-implements this:

- it reads auth.json itself;
- it runs its own refresh at the same threshold, and a forced refresh on 401;
- it writes the rotated tokens back to Pi's auth.json through `JsonDocumentStore.modifyObject`, guarded only by an in-process semaphore and a rename.

That creates real hazards:

- Both sides can spend the same refresh token.
- A Pi write inside the read-compare-rename window can be lost.
- The rename replaces a symlinked auth.json and resets its mode.
- An interrupted refresh can lose a rotated token.
- Several Pi processes refresh with no shared lock.

Because the extension checks the file first, inside the refresh window it is actually the _normal_ refresher, not a rare race.

pi-better-openai `auth/codex-auth.ts` (148 lines) runs a four-way precedence resolver over the file and the registry, and carries an `authSource` field. Core `readSchemaDocument` exists only for these two readers.

**Target design.**

- Registry-only resolution in both packages.
  - xAI: `ModelRegistryAuth` keeps its member name `getApiKey`, but implements it as `Effect.tryPromise(() => getProviderAuth("xai"))` mapped to `result?.auth.apiKey?.trim() || undefined`. A rejection becomes the typed `ModelRegistryAuthError`.
  - `auth.ts` shrinks to about 40–45 lines: the error, credentials, `extractTeamIdFromJwt`, and `getXaiCredentials()`.
  - xAI's 401 path re-resolves once through the registry and retries only if the token changed.
  - OpenAI's `codex-auth.ts` shrinks to about 65–75 lines of registry parsing.
  - `authSource` is removed from projection and debug output.
  - The image service drops its `JsonDocumentStore` dependency.

**Justification.** This removes the only second writer of Pi's shared credential file and the only code that handles long-lived refresh tokens. Usage, image generation, and chat then share one credential path. It is a textbook case of replacing a hand-built mechanism with the platform feature.

**Behavior changes.**

- xAI no longer refreshes or saves tokens; Pi's locked refresh does it on each usage poll. The saved `expires` follows Pi's convention.
- A 401 on an unexpired xAI token no longer forces an extension-owned refresh. Pi's own chat has no 401 refresh either.
- When Pi's refresh fails, usage reports a sanitized lookup failure instead of using the last minutes of a file token.
- An xAI entry without `expires` is never refreshed by Pi. Only hand edits produce such entries.
- OpenAI: if the registry fails or returns nothing, there is no file fallback. A Pi refresh failure shows "Unable to read openai-codex credentials." as a Failure. Today it often ends as Missing.
- Diagnostics print `found` or the registry's source label.
- A stale `ctx.modelRegistry` no longer falls back to the file.

**Convention changes.** None to CLAUDE.md.

- Replace the xAI ARCHITECTURE.md auth bullet (line 17) and the credential paragraph (line 28) with one sentence: Pi's registry owns resolution, refresh, and persistence.
- Simplify the OpenAI codex-auth bullet. Keep the `Auth file:` diagnostic line, labelled as Pi's default store.

**Risks.** This depends on Pi's public `getProviderAuth` contract, which is present in 0.85.1–0.87.1. `getProviderAuth` takes no AbortSignal; the existing 10 s diagnostic bound abandons a slow refresh, as today. Five test files need registry doubles.

**Reviewer-required changes.**

1. Use `getProviderAuth` in **both** packages. Do not keep `getApiKeyForProvider` for OpenAI: it turns a Pi refresh failure into a misleading "Missing … Run /login". For OpenAI:
   - a rejection becomes a fixed, sanitized `CodexAuthError({operation: "registry"})`;
   - an empty `apiKey` means missing;
   - a non-empty but unparseable key is `registry-decode`.
2. Keep the xAI boundary member name `getApiKey`, changing only its implementation. That limits fixture churn; the fixture only widens its error type.
3. xAI 401 path: re-resolve exactly once; retry only when the token differs (compare the Redacted values); never resend a rejected token. If the re-resolve fails, fall through to today's `XaiUsageError({operation: "monthly"})` "(HTTP 401)" result. Today's recovery swallows registry failures; behavior-lens resolution over justification's typed-lookup alternative. Update the `XaiUsageResult` doc comment.
4. Add `packages/pi-better-openai/src/usage/format.ts` to scope: `CodexCredentialsWithSource` becomes `CodexCredentials`. Check the `fast-service.test.ts` double.
5. Keep sanitization and interruption guarantees in tests:
   - In each package, a rejecting registry yields the fixed message, and the serialized failure contains neither the token nor the rejection text. Pi `ModelsError` messages can carry provider `error_description`.
   - Keep the OpenAI test for interrupting a pending registry lookup, and the xAI test that interruption releases both HTTP resources.
6. Update every registry double to model `getProviderAuth` rejection versus `undefined`:
   - xAI: `tests/support/fixtures.ts`, `extension.test.ts`, `usage-service.test.ts`;
   - OpenAI: `domain.test.ts`, `image-service.test.ts`, `extension.test.ts`.
7. Correct the problem statement (see above), list the accepted edge cases, and add the removed hazards to the justification.
8. Leave the deletion of core `readSchemaDocument`/`DecodedDocument` (173 + 93 lines) and JsonHttpClient's `formBody` option as a separate follow-up. It needs maintainer approval because CLAUDE.md asks for stable core exports.

**Migration steps.**

1. OpenAI: registry-only `getCodexCredentials(ctx)`. Remove the file reader, the precedence resolver, `source`/`authSource`, and the usage/format/projection/debug/image plumbing. Rewrite the credential section of `domain.test.ts` and update the doubles. Run `pnpm --filter pi-better-openai test`.
2. xAI: re-implement `getApiKey` over `getProviderAuth` with typed rejection, and update fixtures.
3. xAI: switch to a registry-only `getXaiCredentials()`, simplify the 401 recovery, and delete the file, refresh, and commit code. Rewrite `auth.test.ts` and `usage-request.test.ts` around registry outcomes. Run `pnpm --filter pi-better-xai test`.
4. Update both ARCHITECTURE.md files. Run `pnpm validate`.

---

### 4. E-sup: delegated Herdr Pi connects to the supervisor channel in-process

- **Ids:** sub-exec-R1 + X-process-R1
- **Packages:** pi-subagents
- **Vetted LOC:** source −250, tests −130.
  - sub-exec-R1 vetted −250/−150 (architect −350/−230).
  - X-process-R1 vetted −250/−130 (architect −300/−150).
  - Reviewer range −250 to −315 source, −130 to −195 tests.
  - Component sizes: `supervisor-client.ts` about 180–200 lines; the in-process bridge about 95–117; the helper 492 → about 254–285.
- **Risk / effort:** medium / L

**Problem.** A Herdr-hosted Pi reaches the root supervisor through three protocols and an extra process:

1. `openPiSupervisorBridge` (329 lines) spawns `node supervisor-mcp-helper.mjs` through rpc-session.
2. It speaks a hand-built MCP JSON-RPC dialect to that helper.
3. The helper speaks Effect RPC over a loopback socket.

Supporting this path takes:

- two correlation layers and two timeout sets;
- a Pi-only `supervisor_pi_proxy` tool that is listed based on a spoofable `clientInfo.name`;
- a custom `notifications/pi_subagents` frame;
- about half of rpc-session's option surface;
- one extra process group per delegated Pi, which must be spawned, killed, and confirmed.

The Pi process already runs Effect and loads `@effect/platform-node`. The helper's Promise client is the only supervisor RPC client implementation.

**Target design.**

- Extract the helper's RPC half into `src/boundary/supervisor-client.ts`, with `openSupervisorClient(config, { onNotification })`. It is a scoped Effect that:
  - builds NodeSocket, NDJSON serialization, and RpcClient in a child connection scope;
  - forks the SupervisorWatchAssignments loop into the parent scope. The loop keeps monotonic epoch adoption, and forward-then-acknowledge for notifications.
- One shared `runSupervisorTool(client, name, args) → { text, isError }` owns:
  - the tool-to-RPC dispatch;
  - the exact result texts;
  - the 10 s / 10 min / 60 min bounds;
  - the question-reply acknowledgement.
- The helper keeps only the MCP stdio server: bounded parser, serialized writer, FiberMap exactly-once responses, and no-follow config read. Its `executeTool` becomes an Effect over the shared client.
- `openPiSupervisorBridge` is rewritten in-process over `readConfig` and `openSupervisorClient`. It keeps the `PiSupervisorBridgeClient.call(name, input)` interface, so host-pi-supervisor-extension.ts barely changes.
- The MCP-level delegated-Pi features are deleted: `proxyToolDefinition`, the `piBridge` initialize flag, proxy argument decoding in the helper, tools/list gating, and the `notifications/pi_subagents` write. `MAX_SUPERVISOR_MCP_PROXY_*` moves to `supervisor/protocol.ts`. The server-side `allowPiProxy` gate is unchanged.

**Justification.** This removes a whole transport layer and one Node+Jiti process per delegated Pi. One supervisor RPC client serves both the MCP helper and delegated Pi, so auth, epochs, acknowledgement order, timeouts, and result texts can no longer drift. The attack surface shrinks: a Claude or Codex MCP inventory can no longer contain the private method at all. Interruption becomes native Effect RPC interruption. It also leaves rpc-session.ts with a single consumer, which E-rpc then removes.

The helper hop predates the Effect RPC migration (2676a06), and no document gives a reason to keep it.

**Behavior changes.**

- No helper child process. One authenticated loopback socket from Pi, with the same token and schemas.
- The notification acknowledgement is sent after `pi.sendMessage` returns, so delivery guarantees are equal or stronger.
- Epoch and notification acks now run on the Pi event loop.
- The Claude/Codex helper never lists or accepts the proxy, even for a spoofed clientInfo.
- Agent-visible error text for failed calls changes; choose it deliberately (item 7 below). Today's `RpcCallRejectedError` message is empty.
- The Pi-side 16-call bound is kept.
- **New failure mode:** RpcClient pings every 5 s and treats a missed pong as a socket failure. With no reconnect, a delegated-Pi event-loop stall of 5–10 s at the wrong moment ends that session's channel, including report delivery. The isolated helper was immune. The same exposure already exists at the root.

**Convention changes.** None to CLAUDE.md. Documentation updates (item 13).

**Risks.** Concurrency bound, interruption semantics, and scope closure (see required changes). The ping stall risk must be accepted consciously.

**Reviewer-required changes** (merged from six reviews):

1. **Connection lifecycle.**
   - Build the socket, protocol, and RpcClient in a child scope created with `Scope.fork(parent)`.
   - Fork the watch fiber into the **parent** scope with `Effect.forkIn(parent)`.
   - On any watch or protocol failure (socket error, ping timeout, non-monotonic epoch, ack failure), complete a `closed` Deferred and close the connection scope from outside it, never from the watch fiber itself. This close is mandatory: otherwise `makeProtocolSocket`'s default retry policy redials forever.
   - After closure, every call fails promptly with `channel_unavailable`.
   - Never `Effect.die` into the Pi runtime; use a typed failure.
   - A failed or interrupted open closes the child scope immediately while the parent stays open. pi-boundaries.md and testing.md document this contract.
2. **Question-reply acknowledgement.** Once `SupervisorQuestion` succeeds, run `SupervisorAcknowledgeQuestionReply` uninterruptibly with its 10 s bound, and capture the question epoch. Today it is not tied to the abort signal.
3. **Error mapping.**
   - `SupervisorRpcFailure` passes through unchanged.
   - `RpcClientError`, `TimeoutError`, and interrupts caused by scope closure map to `delivery_outcome_uncertain`.
   - Only the caller's own interruption stays an interruption, so a question cancellation still reaches the server.
   - Before each call, fail with `channel_unavailable` when the channel is closed or the epoch is below 1.
4. **Validation.**
   - Keep the strict argument guards (`isSupervisorMcpMessageArguments/ReportArguments/ProxyArguments`, and the `SupervisorMcpProxyArguments` and `SupervisorMcpToolArgumentsByName` types) and run them before any RpcClient call, because `payloadSchema.make` throws synchronously.
   - Add an outbound encoded-frame bound (JSON-escaped `argumentsJson` plus an envelope allowance, at most `MAX_SUPERVISOR_CHANNEL_LINE_BYTES`). An oversized proxy or questionnaire call must then fail locally with a typed error instead of making the server close the connection.
5. **Result texts in one place.** Put `runSupervisorTool` and its argument/error types in `src/supervisor/` (pure), so mcp-wire does not import from `boundary/`. The helper wraps the result into `McpToolResult`. The bridge maps the exit directly and does not build JSON-RPC envelopes through `toolResponseFromExit`.
6. **Admission.** Keep the 16-call fail-fast bound in the bridge; do not queue. The server closes connections above 32 active requests, and watch/ack requests count. Keep the 10 min and 60 min outer bounds. The 15 s outer bound is redundant (the inner 10 s always fires first) and may be dropped.
7. **Error types.** The bridge defines its own errors mirroring today's observable classes: rejected (today an empty message; choose a fixed human-facing text or the bounded `SupervisorRpcFailure` message), timeout (non-empty message), transport/unavailable (non-empty message), and capacity. host-pi-supervisor-extension.ts and its test then stop importing `RpcSession*`. This is required for E-rpc. Two X-process-R1 reviewers asked to keep importing the rpc-session errors, but that only makes sense if rpc-session survives; E-rpc deletes it.
8. **Notifications.**
   - During step 1, `onNotification` returns an Effect whose failure fails the channel before the ack, preserving the helper's ack-after-stdout rule.
   - The in-process bridge wraps the extension callback (`Effect.try` + ignore) so a throw cannot kill the watch loop, then acknowledges as today.
   - After step 3 the helper passes no notification handler. Only `allowPiProxy` channels deliver notifications, and those no longer reach the helper.
9. Drop the test-only `helperPath` and `initializeTimeoutMillis` options. Remove the helper-file check from herdr-harness's Pi preflight.
10. **Record the ping/pong risk.** Either measure it (a test that blocks the loop for more than 5 s during a ping) or document the new session-fatal failure mode in ARCHITECTURE.md and the Herdr docs. A reconnect-and-reopen path is not required, but not adding one must be a conscious decision.
11. **Tests.**
    - Replace the helper-kill tests with socket-level lifecycle tests. An interrupted or failed open, and a released scope, must disconnect the peer; for example, `setAssignmentEpoch` or `deliverNotification` then fails with `supervisor_helper_unavailable`. Use a raw loopback server that never answers for the open test.
    - Add a watch-failure test: in-flight and later calls fail promptly, and the server sees no reconnecting peer.
    - Add tests for the 16-call admission bound, the in-process proxy round trip (moved from supervisor-channel.test.ts:728–787), and local rejection of an oversized frame.
    - Add a test that the helper never lists or executes the proxy, even with clientInfo `"pi-subagents-pi-bridge"`.
    - The "strictly rejects malformed bridge tool input" test is retargeted to local rejection, since host guards already own exact keys.
    - `withProxyChannel` may keep spawning the helper; drop its now-meaningless clientInfo.
12. `mcp-contract.ts` changes by only about −3 to −5 lines, because the proxy guard and types stay. Moving the proxy bounds is net zero.
13. **Documentation:**
    - ARCHITECTURE.md: the bridge-opening sentence and the helper description;
    - docs/local-backends.md: the supervisor channel and module list;
    - docs/herdr-ownership.md: the private proxy becomes the private SupervisorProxy RPC gated by `allowPiProxy`;
    - README.md lines 34 and 232 ("releases the helper" becomes "releases the supervisor connection");
    - docs/architecture/pi-boundaries.md lines 136 and 140;
    - docs/architecture/tool-presentation.md:55;
    - docs/architecture/testing.md:52.

**Migration steps.**

1. Add `supervisor-client.ts` and `runSupervisorTool`, and make the helper consume them with no MCP-visible change. The supervisor-channel and supervisor-mcp-helper tests must pass unchanged.
2. Rewrite `openPiSupervisorBridge` in-process: `readConfig`, open the client, validation, frame bound, admission bound, outer bounds, and local error types. Update host-pi-supervisor-extension.ts and its test. Port the behavior tests and replace the lifecycle tests. Delete `pi-bridge-open-fixture.mjs`. Land the doc updates in this step, not later.
3. Remove the MCP-level delegated-Pi features from the helper, mcp-wire.ts, and mcp-contract.ts. Move the proxy bounds and drop the Herdr preflight helper check. Rewrite the channel test so the MCP inventory never exposes the proxy.
4. Run `pnpm --filter pi-subagents test` and `pnpm validate`.

---

### 5. E-rpc: retire rpc-session.ts; Codex hook trust runs on the existing process transport

- **Ids:** sub-exec-R2 + X-process-R2
- **Packages:** pi-subagents (the optional step would also touch native-model-catalog.ts)
- **Vetted LOC:** source −460, tests −115.
  - X-process-R2 vetted −460/−115 (architect −550/−145).
  - sub-exec-R2 vetted −505/−182 (architect −515/−185).
  - Excludes the optional model-catalog step (about −85 more).
- **Risk / effort:** low / M. **Hard dependency on E-sup.**

**Problem.** pi-subagents has two spawn-and-JSONL process stacks.

- `process-transport.ts` (356 lines) is the hardened one: bounded parser, byte-budgeted queue, write timeouts, confirmed process-tree release. Local Pi, Claude, and Codex use it.
- `rpc-session.ts` (500 lines) is a second one, with its own spawn, kill, and confirm logic, a pending-call map, a write queue, notify acknowledgements, a stderr cap, and four tagged errors.

After E-sup, rpc-session's only consumer is `herdr-codex-hooks.ts`. That file drives the same `codex app-server --stdio --strict-config` server that local-codex drives, through a strictly sequential five-step dialog. It rebuilds the initialize params and envelope schemas that `local-codex-protocol.ts` already exports.

A real latent bug: the current `RpcFailureSchema` requires a string `error.code`, but real Codex (0.147) returns numeric codes such as −32600. Every Codex error response is therefore ignored until the 10 s timeout.

**Target design.**

- `herdr-codex-hooks.ts` acquires the process transport directly: `acquireProcessTransport`, or `acquireLocalCliTransport` with a `CodexHookRequest` frame type.
- It reuses `decodeCodexEnvelope`, `initializeRequest("initialize")`, and `initializedNotification()`.
- A sequential `callJson` sends one frame and then takes events until the matching response arrives.
- The explicit close is a force-first, cached release, with the existing cause composition.
- Delete rpc-session.ts, its test, and its fixture.

**Justification.** One spawn/kill/confirm implementation, one parser owner, one Codex envelope decoder, and one initialize frame remain. The change removes a general concurrent RPC session whose remaining workload is four request/response pairs. It follows the maintainer's own direction (8e36941, "consolidate transports") and the rule that foreign JSON-RPC stdio uses the shared bounded parser. It also fixes the numeric-code stall.

**Behavior changes** (corrected by reviewers):

- Codex JSON-RPC errors with numeric codes now fail closed immediately, with the same code, instead of stalling for 10 s.
- Server requests, foreign ids, and valid JSON that is not a Codex envelope now fail closed. Today they are ignored while the session keeps waiting.
- `initialized` drops `params: {}`, which the real server accepts.
- The cleanup `logWarning` lines disappear.
- stderr over 32 KiB no longer fails the session; it is kept as an unsurfaced 128 KiB tail.
- The parser queue bound grows from 1 MiB to 8 MiB.
- With force-first teardown, successful sessions stay close to today's timing. When signalling itself fails, the worst case for reporting `cleanup_unconfirmed` is about 4.1 s instead of about 2 s.
- Error codes seen by callers do not change.

**Convention changes.** None. Keep core's `awaitProcessClose` export (CLAUDE.md requires stable core exports).

**Risks.**

- The exact cause order `[cleanup_unconfirmed, unavailable, unavailable]` is pinned by a test. Prototypes by all three reviewers passed it unchanged.
- The reader must acknowledge every event it takes.

**Reviewer-required changes.**

1. **Sequencing.** Land only after E-sup has removed every rpc-session consumer:
   - `pi-supervisor-bridge-client.ts`;
   - the `RpcSessionError` type import in `host-pi-supervisor-extension.ts`;
   - `RpcSessionTransportError` in its test.

   Do not rebuild the bridge's concurrent correlation on process-transport inside this proposal; reviewers costed it at +100 to +180 lines. If E-sup is rejected, porting only the hooks is still worth it for the stall fix, after which the hook-only rpc-session options (about 50 lines) can be trimmed.

2. **Teardown.** Make the explicit close `transport.terminate("force").pipe(Effect.ignore, Effect.andThen(transport.release))`, mapped through the existing `cleanupCause`. Keep the cached release as the scope finalizer (`acquireRelease` with the release ignored). This keeps today's immediate SIGKILL.
   - Reviewers split between force-first and removing the fixture's `process.on("SIGTERM", () => {})`. Force-first is chosen here: it keeps the fixture as real-process coverage of forced cleanup, and it avoids adding about 200 ms to every Herdr Codex launch.
3. **Reader.**
   - Map `Queue.take`'s `Cause.Done` (the queue ends when the process closes; no `exit` event is ever enqueued) to unavailable.
   - Acknowledge every taken event. Continue on notifications.
   - Fail closed on server requests, foreign ids, error responses, decode failures, and `protocol_error`.
   - Wrap send plus await in **one** `timeoutOrElse` per call, not two sequential deadlines.
   - Use `synchronousWriteFailure: "not_sent"` (exposed through `LocalCliTransportRequest` if acquireLocalCliTransport is used), so a synchronous stdin throw becomes unavailable rather than a defect.
   - Map errors with a `Cause.map`-based helper to keep interruption and every reason.
   - Declare `selectOwnedHook`'s value parameter generic (`<ValueInput>`) for the anti-slop lint.
4. **Byte bounds.**
   - Add an optional `maxLineBytes` (512 KiB) to `ProcessTransportOptions`.
   - Pass the parsed line's byte length through `options.message(value, bytes)`. Make `bytes` optional on the wire event so existing fakes compile.
   - Keep **one** session-wide 1 MiB budget: not per call, and not measured with `JSON.stringify(...).length`. Reviewers accepted, as an alternative, dropping the lifetime cap and documenting that per-call timeouts plus the transport's 8 MiB / 512-event budget bound the session.
5. **Generic helper.** A generic `awaitJsonlFrame` in local-cli-transport.ts is only worth adding with the optional catalog step. If added, it needs separate `onProtocolError`, `onClosed` (Cause.Done), `onOverflow`, and `onTimeout` callbacks; it uses `Result`, not `Either` (v4 has none); and it gets unit tests on the fake-child harness.
6. **Tests.**
   - Keep all 13 `herdr-codex-hooks.test.ts` assertions.
   - Give "preserves interruption when explicit close also fails" an explicit timeout of about 10 s; it takes about 4.1 s when both signals are mocked to fail.
   - Delete `rpc-session.test.ts` and `rpc-session-fixture.mjs`.
   - Optionally run `pnpm --filter pi-subagents smoke:herdr-codex-hooks`.
7. **Docs and comments:**
   - docs/herdr-ownership.md: "scoped RPC session" and "RPC error translation". Keep the wording that hook trust stays interruptible.
   - ARCHITECTURE.md: "RPC process … acquisitions" now names process-transport.
   - docs/architecture/pi-boundaries.md lines 136–137.
   - docs/local-backends.md line 67 ("spawned helper RPC sessions") and line 101.
   - The header comments of process-transport.ts and local-cli-transport.ts.
8. **Optional model-catalog step** (not counted). Port `native-model-catalog.runCatalogProcess` onto the same helper, about −85 lines. It is a separate commit and needs explicit maintainer sign-off, because it reverses cb55216's move to Effect ChildProcess.
   - Keep `catalog_protocol_invalid`, `catalog_response_missing`, `catalog_output_unbounded`, `catalog_timeout`, `catalog_cleanup_unconfirmed`, and `catalog_executable_unavailable`. Map a send failure to `catalog_response_missing` or a new `catalog_transport_unavailable`.
   - List the changes: an unterminated line of up to 4 MiB now surfaces as timeout or protocol error; stderr overflow no longer fails the probe; the first Claude picker load takes about 200–400 ms longer.

**Migration steps.**

1. Add `maxLineBytes` and byte-length passing to process-transport. Run the process-transport tests.
2. Port `establishTrust` onto the transport with force-first release. Run `herdr-codex-hooks.test.ts` (the only change is the timeout on one test).
3. After E-sup lands, delete rpc-session.ts, its test, and its fixture, and update the docs.
4. Optional, separate change: the catalog step.
5. Run `pnpm --filter pi-subagents test` and `pnpm validate`.

---

### 6. ui-R3: collapse the working-row timer service, owner state machine, and working-message host into one synchronous module

- **Ids:** ui-R3
- **Packages:** pi-cosmic-ui
- **Vetted LOC:** source −320, tests −30. Architect estimate −330/−30.
  - Reviewers measured −326 to −351 source.
  - Tests measured −79 to −95 when `working.test.ts` is rewritten in place.
- **Risk / effort:** low / M

**Problem.** Pi's working row ("Working · 2m 14s · ~18.4 tok/s") is driven only by synchronous Pi events. Its only side effect is a guarded synchronous `setWorkingMessage` call. Today that state is spread over three stores and two async hops:

- a `WorkingTimerService` SynchronizedRef with a self-rescheduling ticker;
- mutable fields outside that ref;
- owner.ts, which holds activation, run generation, agent owner, and prompt owner.

Because every event is forwarded through `slot.fork`, owner.ts must check the token and ownership twice, and `releasePrompt` returns a deferred resume closure. host-working-message.ts wraps a synchronous call in `Effect.sync`.

**Target design.**

- New `src/working/row.ts`: `makeWorkingRow({ callbacks, now = synchronousNow, every = startHostUiTicker })`.
- It uses plain closure state and has `activate/deactivate/agentStart/agentEnd/canPrompt/promptStart/isPrompting/promptEnd/output/pauseOutput`.
- The formatting helpers move over unchanged. The retry rules carry over one to one:
  - a `failed` write keeps the row writable;
  - an `unavailable` write stops the ticker.
- application.ts calls the row directly in its existing handlers. Remove `WorkingTimerService` from layer.ts and from the startup value.

**Justification.** Three state stores become one, and the two-phase admission protocol disappears. Each Pi event now changes state in the same synchronous call that observed it, so the race windows the protocol guarded go away. The 1 s ticker reuses the shared host ticker pool. The same pattern already exists in pi-code-previews `tool-timing.ts`, code-mode `host-render-ticker.ts`, and the subagents render rows.

**Behavior changes.**

- Ticks come from the shared pool, whose phase is arbitrary. Updates can lag by less than 1 s, with one duplicate same-second write.
- Row writes happen inside the event handler.
- Deactivation clears the row synchronously.
- Idle runtime disposal no longer writes `setWorkingMessage(undefined)`. Pi's `resetExtensionUI` clears it on rebind.
- A replacement-time clear targets the current context. The old one was stale and its write threw anyway.
- After an `unavailable` prompt write, a successful resume keeps ticking. Today the row freezes.

**Convention changes.** Add the shared narrow effect-v4.md exception (one sentence, together with E-footer). Update:

- ARCHITECTURE.md lines 7 and 9 (the injected working-message contract, and startup passing the timer and token);
- ARCHITECTURE.md lines 51–55 and 62 (the working section and lifecycle diagram);
- pi-boundaries.md line 128, adding the working row as a ticker-pool consumer.

Either document `row.ts` as feature-local host I/O, or name it `boundary/host-working-row.ts`.

**Risks.** This is the most convention-sensitive of the accepted proposals. Port the retry rules exactly.

**Reviewer-required changes.**

1. **Context ownership.** Bind the row to the session's context MutableRef at activation: `row.activate(context)` from `onActivated`'s input, cleared in `deactivate()`. Do not read application's `currentContext`, for two reasons:
   - `onDeactivated` clears `currentContext` before the row is deactivated, so after an abort the final clear would return unavailable and leave a stale "Working · Ns".
   - On replacement, the clear would go to the new session's context.

   Add an extension test: session with an abortable `ctx.signal`, then `agent_start`, then abort; the last `setWorkingMessage` call must be `undefined`.

2. `agentStart` returns early unless a context is bound. `canPrompt`/`isPrompting` require `running`. `activate()` has no side effects, so an `agent_start` during startup is still ignored.
3. When the row is not writable, `tick` must `halt()` (unsubscribe from the pool) instead of returning early while staying subscribed.
4. No separate `deactivate()` in `session_shutdown`: `slot.shutdown()` already runs `onDeactivated` synchronously. An idempotent call is acceptable.
5. Choose the clear semantics on purpose: either write `undefined` unconditionally while bound, or list "idle disposal no longer clears" (listed above).
6. Rename the `prompting()` accessor to `isPrompting()`, which clashes less with the closure variable.
7. Tests:
   - Rewrite `working.test.ts` in place.
   - Drop the unreachable "prompt wait admitted before timer startup" case.
   - Fold the host-message boundary checks into the row's write tests: rpc gives unavailable and writes nothing; a throw gives failed plus a `working-message` diagnostic, with no secret leak.
   - Add a settlement/deactivation test showing the row clears and ticking stops.
   - `extension.test.ts` stays unchanged.

**Migration steps.**

1. Add `row.ts` and rewrite `tests/working.test.ts`. Port every scenario with fake `now`/`every`.
2. Switch the application.ts handlers and activation, deactivation, and shutdown. Remove the timer from layer.ts and the startup value. Delete working/service.ts, working/owner.ts, and boundary/host-working-message.ts. `extension.test.ts` must pass unchanged.
3. Update docs and the effect-v4.md sentence. Run `pnpm --filter pi-cosmic-ui test` and `pnpm validate`.

---

### 7. sub-settings-R1: retire the pre-dashboard editor protocol

- **Ids:** sub-settings-R1
- **Packages:** pi-subagents
- **Vetted LOC:** source −265, tests −65. Architect estimate −280/−65. Feasibility measured −329/−77 on a real diff, or −314 without the optional menu table.
- **Risk / effort:** low / M

**Problem.** The profile dashboard replaced an earlier standalone editor. The old editor's leftovers still ship as parallel paths that nothing reaches:

1. `profile-target-picker.ts` is imported only by its own test.
2. The `ProfileWorkspaceCloseResult` protocol:
   - It has actions `sets`, `select-target`, `save-session`, and `use-current`, plus position fields.
   - The workspace only ever emits `false` or `{action: "save-session"}`.
   - `editorClosed` reads only `.action`, the custom-UI result is always `false`, and `backLabel` is never passed.
3. The draft action switch handles add, clone, move, remove, disable, and reset, but nothing produces `disable`, and add/reset are intercepted before it. That makes these unreachable: `resetGlobalDraft`, `inheritProjectDraft`, the `hasOwnDeclaration`/`inspection`/`scope` inputs, and the disable/reset/preview confirmation copy.
4. Description strings are threaded through persist and selectors but never read.
5. `FleetManagerActions` keeps non-receipt twins of the receipt writes, with fallback branches and an "undo unavailable" error path. `register.ts` always supplies the receipt versions.
6. Several exports and options are unused.

**Target design.**

- Delete the target picker.
- Replace the close-result protocol with `close()` and an optional `saveSession?()` callback.
- Keep only the reachable menu actions (clone, move-up, move-down, remove) and one remove confirmation.
- Drop the description data flow.
- Make receipt writes the only `FleetManagerActions` write path, with the `*WithReceipt` members renamed to the plain names and required.
- Remove the unused exports.

**Justification.** This removes a whole retired protocol, a second route-mutation semantics that ProfileEditVisit Undo superseded, and a second write path with its own error branch. docs/settings-workspace.md already says "There is no standalone Disable action" and that Undo uses committed receipts.

**Behavior changes.** None in production. The discarded custom-UI result becomes `undefined` instead of `false`.

**Convention changes.** None.

**Risks.** This overlaps the small-cleanup review (the menu table), so coordinate. `FleetManagerActions` changes shape; it is package-internal.

**Reviewer-required changes.**

1. When merging the write members, keep the **receipt** bodies from register.ts, including their `withCurrentActivation` wrapper. The old non-receipt session writes skip it, and would drop the "Subagents session was replaced." and "Subagents are not active" guards. `patchProfile` becomes `withConfigStore((store) => store.patchProfile)` over the receipt-returning store method.
2. Make `saveSession` optional on `ProfileWorkspaceOptions`, because the dashboard's `baseOptions` is spread into every child host. Wire it as `saveSession: () => this.act({ action: "save-session" })`, since `act()` already checks current, busy, blocked, and tab. `editorClosed` becomes:
   - session target: `options.workspace.close()`;
   - saved target: `savedTarget = undefined`, then refocus and render.

   `openProfileDashboard` and `ctx.ui.custom` become void, and the controller drops `.then(() => undefined)`.

3. Delete `ProfileWorkspaceConfirmation.preview`, the `currentSummary`/`afterSummary` inputs, and the `...(confirmation.preview ?? [])` spread in profile-workspace-render.ts. Drop the `preview:` line from the bounded-render test in `profile-workspace-ui.test.ts`.
4. Drop `destructive` from the menu choices. `RouteActionsSelectorOptions.select` takes only the action, and dispatch becomes `if (action === "remove") this.arm(action); else this.performDraftAction(action)`. `performDraftAction` takes `CandidateMenuAction | "add" | "reset"`.
5. Keep these, which are still used:
   - `hasOwnProfileRouteDeclaration` (ProfileEditVisit);
   - `disableRouteDraft` (`removeRouteCandidate`);
   - `inheritSessionDraft` (`loadProfileRouteDraft`).

   Keep `ProfileWorkspaceSaveResult.receipt` and `recordSave(receipt?)` optional, because the trust-lost and conflict paths return no receipt.

6. Update tests and fixtures:
   - `tests/profiles.test.ts`: collapse each of the two store fakes (about lines 935 and 980) into one `patchProfile` that returns a document.
   - `profile-restore-store.test.ts:165`: rename.
   - Dashboard and controller fixtures: add `restoreProfileDeclaration`. Receipt stubs must return realistic receipts (`value.session`, and `value.projectDocument ?? {}` for patchProfile/restoreProfileDeclaration), not undefined.
   - Remove the assertion that the non-receipt `replaceSessionProfiles` was not called.
   - Change `close(false)` assertions to `toHaveBeenCalled()`.
   - Rename the `ProfileWorkspaceDraftAction` type import in `profile-workspace.test.ts`.
   - Remove `ProfileWorkspaceCloseResult` from the controller test's `OverlayResult`.
   - In `profile-route-editor.test.ts`, delete the `inheritProjectDraft(inherited, "worker")` assertion; `loadProfileRouteDraft` already covers it. Use literal `{kind, candidates: []}` drafts for the other checks.
7. Rewriting the menu as a table is optional style work (about −15) and overlaps the small-cleanup review. Keep conditional spreads if a smaller diff is preferred.

**Migration steps.** Each step is followed by `pnpm --filter pi-subagents test`.

1. Delete the target picker and its test, and the unused exports: `profileRouteDraftSummary`, `routeOptionCountLabel`, the save-form section-key options, `preferredScope`, and the `"candidates"` pane.
2. Remove the description data flow.
3. Shrink the draft actions, confirmation, and menu, and delete `resetGlobalDraft`/`inheritProjectDraft`.
4. Replace the close protocol with `close()`/`saveSession?()`.
5. Make receipt writes the only path and delete the fallbacks.
6. Run `pnpm validate`.

---

### 8. E-surface: one owned custom-UI surface host in pi-cosmic-ui

- **Ids:** X-presentation-R1 + ui-R4 + ask-user-R2 (only its dialog hide/resume move is counted)
- **Packages:** pi-cosmic-ui, pi-mcp, pi-ask-user, pi-code-mode, pi-better-xai, pi-background-task, pi-subagents, pi-code-previews
- **Vetted LOC:** source −234, tests −120.
  - X-presentation-R1 vetted −200/−120 (architect −330/−300). This includes the unguarded-screen step; without it, about −150.
  - ui-R4 vetted −35/−10 (architect −105/−60). Its scope is inside X-presentation-R1, so it is not added.
  - ask-user-R2 vetted −111/0 (architect −130/0). Its host merge overlaps X-presentation-R1. Only dialog.ts −16 and form-dialog.ts −18 are added.
- **Risk / effort:** medium / L

**Problem.** The same state machine around Pi's `ctx.ui.custom` is hand-written in ten places. It covers factory-once, done-once, a finish held until `onHandle` mounts, an inert component for late factories, fail-closed guard handling, and authority abort. Five guarded copies carry the pinned-Pi workaround: hide our own handle, show an inert non-capturing overlay, call `done`, then hide the inert overlay. The guarded copies are:

- MCP `openMcpOverlay`;
- the MCP auth panel;
- the ask-user questionnaire and form hosts;
- the Cosmic UI Activity manager.

The code-mode and xAI inline settings surfaces repeat the latches. Five full-screen overlays call `done` with no guard at all: `/tasks`, the `/subagents` fleet, the proxy fleet, the profile dashboard, and `/code-preview-health`.

In pinned Pi 0.86, `showExtensionCustom` closes by calling `ui.hideOverlay()`, which pops the **top** overlay. Closing one of those five screens while a collapsed ask-user dock sits above it therefore pops the dock and leaves the screen as a disposed "zombie" overlay. That is a real stuck-overlay bug. A blocking `ask_user` is not gated by the prompt gate, so it can open above `/tasks`. The profile dashboard can also call `done(false)` from its runtime finalizer before mount.

Four near-identical fake-Pi test harnesses re-prove the same rules. ask-user's dialog classes also hold the overlay handle and call `setHidden` themselves.

**Target design.**

- Add `pi-cosmic-ui/src/boundary/host-surface.ts`, exported as `pi-cosmic-ui/boundary/host-surface`, with:
  - a callback core, `mountOwnedSurface(ctx, options, settle)`, which returns a synchronous `close()`;
  - an Effect adapter and a Promise adapter;
  - `hasCustomSurface`;
  - a failure type.
- Placements:
  - `screen`: viewport plus live overlay options;
  - `dock`: the input dock with the dock-wrapped handle;
  - `inline`: the editor slot, with no guard;
  - `overlay`: plain passthrough options, for health.
- Options: `closedValue`, `isCurrent?`, `admit?`, `create(host)`, `onMounted?`, `onClose?`, `onControl?`.
- The core owns the latches, the guarded close, dock mount/dispose, viewport attach, and callback gating.
- Add a source-only, Vitest-free `pi-cosmic-ui/testing` fake that models Pi 0.86 exactly.
- Every site keeps its domain lifecycle: gates, bridges, tickers, subscriptions, and detail loading.
- ask-user dialogs lose `setOverlayHandle/resume/collapse/onCollapse` and the form's `hidden` flag. They take a `collapse` control instead, and the host owns hide/resume.

**Justification.** One owner of a subtle, security-relevant ownership protocol, and one place to delete the workaround once pinned Pi closes overlays by identity. This fixes the five unguarded screens. It also removes the four duplicate fake harnesses' duplicated rule tests.

**Behavior changes.**

- None for the guarded sites: same latches, closed values, notices, and cleanup order.
- The unguarded screens gain the owned-close guard. Closing them no longer pops an overlay stacked above them, and a factory call after close gets an inert component.
- Factory-throw handling on those screens must be chosen (item 9).

**Convention changes.**

- pi-cosmic-ui ARCHITECTURE.md lines 37, 41, 43, and 45 currently say hosts keep owned-overlay cleanup and that host guards stay caller-owned. They now say the shared surface owns owned-overlay cleanup, while callers keep domain lifecycle.
- The doc comments in host-viewport.ts and host-input-dock.ts.
- pi-boundaries.md lines 17, 21, 25, 105, 117, and 127.
- pi-ask-user ARCHITECTURE.md lines 47–56 (the `finishOwnedOverlay` section and the "Pressing `b`" paragraph).
- pi-mcp ARCHITECTURE.md lines 75 and 81.
- Document the new testing export.
- Correct the stale "Pi 0.85" comments to "pinned Pi".

**Risks.** This is cancellation-sensitive code. Keep each site's ordering: MCP disposes the component before `done`; ask-user runs abort, then finish, then dock dispose, then prompt release, then bridge clear, then the editor join; Activity restores `binding.render` after close. The shared fake must model Pi exactly, or the consolidated tests prove nothing.

**Reviewer-required changes** (merged from nine reviews):

1. **Synchronous admission.** Add an `admit?` option evaluated in the same synchronous frame as `ctx.ui.custom`. It returns false, or a release function, and a false result settles with a distinguishable `blocked` outcome. ask-user thereby keeps `canOpen()`/`enter()` next to `custom()`, as pi-boundaries.md documents; only its `awaitOpen` retry moves outside. Alternatively, ask-user may call the callback core directly inside its own `Effect.callback`.
2. **Cleanup order.**
   - `onClose` runs before `done` and only revokes callback authority.
   - ask-user keeps dock dispose, `releasePrompt`, `bridge.clear`, and the editor join after `done`, in its own `ensuring` or an `onClosed` hook. `releasePrompt` wakes waiting fibers synchronously.
   - The private form keeps `dialog.dispose()`, which clears private draft values, before finish.
   - MCP keeps component dispose before `done`.
   - `release`/`onClose` callbacks must be guarded and non-throwing.
3. **External close.** Call `onControl(close)` synchronously **before** `ctx.ui.custom`. It is used by Activity `binding.close` (deactivate, rebind), the auth panel's cancellation fiber and terminal-phase cancel, and the profile dashboard finalizer's `close(false)`. In forked code, late-bind it as `Effect.sync(() => close())`, never `Effect.sync(close)`. A prototype hit this trap: three auth-panel tests timed out.
4. Skip `onMounted` when a finish was requested before mount, not only when the surface is closing.
5. **Inline placement.** Finish calls the guarded `done` immediately, synchronously if it happens inside the factory. It never waits for `onHandle` and never installs the inert guard. Keep code-mode's `Closed/PromptInteger/Failed` result and xAI's "throwing factory means failed".
6. The core's `close` disposes the dock even before mount, so the widget is removed on a pre-mount abort. Both adapters call `close` on **every** settlement, so the surface signal is also revoked after a normal finish; ask-user revokes it before joining editors.
7. `/code-preview-health` keeps its current geometry (plain `{overlay: true}`, component-sized) through the passthrough placement, or stays out of scope.
8. Gating render on `isCurrent` is opt-in; it is new for the auth panel and Activity.
9. Promise callers map `Failed` explicitly. `/tasks`, the fleet, the proxy, and health either rethrow, keeping today's rejected command, or show a notice listed as a behavior change.
10. Scope:
    - Drop `/cosmic-ui` settings: it routes through HostCallbackBoundary diagnostics on purpose and saves about 10 lines.
    - Drop the OpenAI and code-previews inline settings.
    - The unguarded-screen migration is **core scope**, because it is the bug fix. Include the profile dashboard's external close and move the proxy fleet's `stopRefresh` into `onClose`.
    - Add a regression test with a hidden docked overlay stacked above `/tasks` or the fleet.
11. MCP: `McpOverlayHost.finish(value?)` becomes `finish(value)`; update the manager call sites. MCP keeps its component-gating wrapper locally; it is not generalized.
12. Errors: one field-less error or a caller-supplied failure thunk. Callers map to their existing messages: `ActivityError` "failed", MCP "could not be closed safely", the auth panel's `failed()`, and the ask-user/form render errors.
13. Tests:
    - The shared fake models a synchronous factory, a separate `onHandle` mount, a global-pop `done`, a non-capturing guard, and `setWidget`, with fault injection at owned hide, guard creation, `done`, and guard hide.
    - Keep one real-shape integration test per site. Keep ask-user's per-fault FIFO-release cases, the auth-panel cancellation and guard cases, MCP resize and signal/dispose-once, and Activity deactivate-close.
    - Delete only true duplicates: MCP pre-factory cancel and guard failure (about 80 lines), Activity late-mount and cleanup failure (about 35), the code-mode latch cases, and host-form-tui's late mount.
    - Update the `/tasks`, subagents application, and profile-settings-controller fakes to deliver `onHandle` and provide `tui.showOverlay`.
    - Keep the spy surface of ask-user `tests/support/host.ts` through an adapter, because nine files use it.
14. Migrate all guarded sites. ui-R4's reviewers measured phase 1 alone (Activity + MCP) at only −26 to −37; the ask-user sites migrate cleanly once the `admit` hook exists.
15. Correct the justification. The "drift" cases (late-mount hide, factory re-invocation) cannot happen in pinned Pi 0.86. The value is one owner of the workaround and the fix for the unguarded screens.
16. **ask-user-R2's dialog move.**
    - The host owns hide/resume on the dock-wrapped handle: collapse does `setHidden(true)` plus `markCollapsed`; `bridge.activate` resumes with `setHidden(false)` plus `requestRender(true)`.
    - Capture the external-editor command inside the factory, after the gate wait, and read it again on retry.
    - Type the form call as `<FormOutcome>`; put `dialog.dispose` inside the `try`; write `if` rather than `&&` in `onMounted`.
    - Add a host-level test that a hidden form drops input. That privacy guarantee now lives only in the host and dock.
    - Delete the dialog-level collapse/"ignored"/resume steps.
    - Reword "ui/ becomes pure": the dialogs still hold the TUI and Editor.

**Migration steps.**

1. Add host-surface.ts (core plus adapters, the `admit` and `onControl` hooks, and all four placements), the testing fake, and the package exports. Port the generic invariant tests from the MCP and code-mode host-ui tests, and add dock/inline cases. Run `pnpm --filter pi-cosmic-ui test`.
2. MCP overlay: wrapper plus error mapping. Shrink host-ui.test.ts to the wrapper cases. Run `pnpm --filter pi-mcp test`.
3. MCP auth panel: dock placement, `onMounted` stores the handle for consent hiding, `onControl` for cancellation. Move its harness to the shared fake.
4. ask-user questionnaire and form: dock placement with `admit`, `closedValue`, and `onMounted`, with domain cleanup kept after `done`. Include ask-user-R2's hide/resume move. Delete `finishOwnedOverlay`. Run `pnpm --filter pi-ask-user test`, including tui-ownership.test.ts.
5. Activity manager: screen placement with `isCurrent`, `onControl` feeding `binding.close`, and detail abort.
6. Inline settings: code-mode and xAI. Delete xAI's host-ui.ts.
7. Unguarded screens: `/tasks`, the fleet, the proxy, the profile dashboard, and health. Update their test fakes and add the stacked-overlay regression test.
8. Update the docs and run `pnpm validate` and `pnpm pack:dry` (new published files).

---

### 9. code-mode-R1: keep only the current (v2) details format and drop the legacy runtime hooks

> Superseded by the compact-presentation redesign (2026-09-25); see the README note.

- **Ids:** code-mode-R1
- **Packages:** pi-code-mode
- **Vetted LOC:** source −200, tests −120. Architect estimate −240/−150. About −180 source if the v1 retirement is declined.
- **Risk / effort:** medium / M

**Problem.** The UI layer carries four compatibility layers for data that current code no longer writes:

1. An MCP-only ledger (`mcpEvidence`, `tools/mcp-evidence.ts`), written for about one day.
2. v1 CompactReceipt/CompactAttention union arms, superseded since 2026-09-18.
3. Count-less details, written between fc3e187 and 0d505da on 2026-08-12.
4. Legacy runtime hooks. `onToolCallEnd` and a negative-id branch of `onToolCallStart` exist for a reload-cached built runtime that no longer exists. The in-tree runtime always passes lifecycle ids.

Every read site branches on these. `compactParentNotices` clones and strips details only to feed a v1-shaped collector.

**Target design.**

- Delete `mcp-evidence.ts`; `isCompactPiTool` becomes `(name) => tools.has(name)` in `compact-subject.ts`.
- Make the receipt and ledger schemas single v2 Structs.
- Reconcile replay evidence into one v2 path. A synthetic v2 ledger marked incomplete is used when nothing decodes, and salvaged notices are routed to `recoveredNotices`.
- Detail counts decode `counts` or fall back to the visible rows.
- Delete `onToolCallEnd` and the negative-id branch.

**Justification.** One details shape, one evidence path, and one failure mode ("malformed means incomplete"). It also deletes a second lifecycle protocol from progress code that is sensitive to concurrency. The package is unpublished on npm, so these formats exist only in local and git installs from a few days.

**Behavior changes.** Records written by current code render exactly as before. Only replay of old transcripts changes:

- v1 records from 09-16 to 09-18 (24 real successful records locally) become uncertain, show the incomplete warning, and show "returned" rows. This part needs approval.
- MCP-era records keep compacting through the kept pre-ledger gate. Their failed or cancelled executions lose the MCP warning and recovery lines.
- Count-less records from 2026-08-12 show only their visible rows.
- A current record with an injected `mcpEvidence` field is no longer downgraded.
- If a current-format ledger fails to decode, it now takes the v2 issues path. Labels change from "outer" to "code-mode", and child v2 receipt issues now appear.
- A tampered `totalToolCalls` no longer marks details as inconsistent.

**Convention changes.** None to CLAUDE.md. Remove the ARCHITECTURE.md statements about tolerant legacy decoding, `totalToolCalls` for older renderers, `mcp-evidence.ts`, and the v1 schema branches. Keep "Historical unsupported calls keep the original renderer".

**Risks.** The main risk is simplifying a gate so it also catches current or pre-ledger records. The reviewers found exactly this in the proposal (item 1).

**Reviewer-required changes.**

1. **Keep the pre-ledger success gate.**
   - Remove only the `mcpEvidence` gate and the `evidence === undefined &&` term: `details.compactAttention === undefined && (total !== details.toolCalls.length || details.toolCalls.some((c) => !isCompactPiTool(c.tool)))`.
   - Do **not** adopt `compactAttention === undefined && total > 0`. Replaying the user's sessions shows 753 real ledgerless all-`pi.*` successes (2026-08-13 to 09-15) that would lose their compact summaries, and 7 tests fail.
   - `call-rows.ts` keeps `isCompactPiTool(call.tool) && compactAttention === undefined ? "success" : "returned"`.
   - Keep the ledgerless success tests (`compact-summary.test.ts` 172–235 and 466–500) and the stripped-ledger assertion from the MCP dual-ledger test.
2. **Keep the `activity` decode**, the `CodeModeCallEntry.activity` type, the `entry.activity ?? entry.tool` label fallback, and the redaction test in replay-recovery. `activity` was written until 1045165 (2026-09-16), not only before 08-15; 874 local records would otherwise show bare tool names. One prototype removed it; the other two lenses require keeping it.
3. **v1 retirement is a separate step that needs explicit maintainer approval.** If approved:
   - `reconcileReplayEvidence` returns `{compactAttention, salvaged}`, and `recoveredNotices = [...salvaged, ...rowNotices]`, which keeps today's order. Update the bound comment on `recoveredNotices` (up to 32 more).
   - `compactParentNotices` becomes a direct list and shares one INCOMPLETE notice constant.
   - Add a regression test: a v1 receipt plus v1 ledger replay salvages both notices and reports an incomplete, uncertain outcome.
   - **Convert** rather than delete the v1 fixtures:
     - replay-recovery: the aggregate-cap overflow and per-call salvage tests;
     - compact-summary.test.ts 368–451;
     - tool-renderer.test.ts about 303–345, which needs a full v2 ledger or it renders the source twice;
     - issue-evidence: assert that a v1 receipt is rejected.
4. **Runtime hooks.**
   - Delete `onToolCallEnd` and the negative-id branch.
   - Keep `lifecycleId` optional in `codemode-runtime.ts`, since the vendored runtime declares it optional. Add a one-line guard in `onToolCallStart` instead.
   - Drop the `calls.has(id)` check.
   - Keep the `returnedOutputs` drain in `settleProgress` with a reworded comment.
   - Delete the /reload comment at execution-run.ts:74–77.
5. **Keep writing `totalToolCalls` and the aggregate `compactAttention.notices`.** `recoverCompactNotices` reads the aggregate notices to salvage malformed ledgers, and notice overflow drives `incomplete`. Drop both optional steps.
6. Count-less step: `reconcileDetailCounts(record, toolCalls) → {counts, consistent}`. `hasExactCounts && consistent` becomes `consistent`. Delete the `{...success, totalToolCalls: "bad"}` case, and remove `activity` only from fixtures where it is unused.
7. Correct the dates: `mcpEvidence` writes ended at 1045165 (2026-09-16 14:42); count-less details only fc3e187..0d505da.
8. Land as separately revertable commits in this order: runtime hooks, MCP ledger, count-less details, then v1 (if approved). Run package tests after each.

**Migration steps.**

1. Runtime hooks, deleting the two reload-cached-runtime tests in `tool-execution.test.ts` and the legacy loop in delivery-evidence.
2. MCP-only ledger, with the gate change from item 1.
3. Count-less details.
4. (With approval) v1 receipts and ledgers.
5. Update ARCHITECTURE.md. Run `pnpm --filter pi-code-mode test` after each step and `pnpm validate` at the end.

---

### 10. core-R2: one atomic JSON-document contract; makeScopedConfigStore becomes core's only scoped resolver

- **Ids:** core-R2
- **Packages:** pi-cosmic-core; consumers pi-background-task, pi-code-previews, pi-mcp, pi-subagents, pi-better-xai (test-only: pi-code-mode, pi-cosmic-ui, pi-better-openai)
- **Vetted LOC:** source −170, tests −75. Architect estimate −170/−75. Measured −185 to −211 source and −85 to −96 tests.
- **Risk / effort:** low / M

**Problem.**

1. `JsonDocumentStoreContract.modifyObject` is optional, and a second `AtomicJsonDocumentStoreContract` makes it required. Both real implementations always provide it. Five production call sites and four platform tests keep `if (!modifyObject) fail` branches that can never run.
2. `updateObject` has no production caller. It is still implemented twice, and every hand-written fake must carry it.
3. `pi-background-task/src/config/store.ts` re-implements project/global resolution that `makeScopedConfigStore` already provides. It does so through four public low-level exports, whose only consumer outside core is background-task.

**Target design.**

- A single `JsonDocumentStoreContract` with `modifyObject` required. Delete `updateObject` and the Atomic interface.
- Inline the scoped path/selection/read-or-warn helpers as private helpers of `scoped-config-store.ts` and delete `scoped-store.ts`.
- background-task uses `makeScopedConfigStore` with no default document.

**Justification.**

- This removes a parallel contract pair, five dead defensive branches, a service method nobody calls, and a duplicate hand-rolled resolver.
- Core then has one trust-gating path instead of two.
- The four exports have one consumer, which already violates core's own admission rule.

**Behavior changes.** Core and the other consumers: none. background-task:

- project and global documents are read concurrently;
- the recovery log wording changes;
- span names change.

**Convention changes.**

- This removes public exports from a published package (`pi-cosmic-core` 0.2.0): `updateObject`, `AtomicJsonDocumentStoreContract`, `scopedDocumentPaths`, `selectScopedDocument`, `readConfigOrWarn`, `readOptionalJsonObject`, the ScopedDocument option and selection types, and the `InMemoryDocuments.service` shape.
- That goes against CLAUDE.md's "keep its public index.ts and testing.ts exports stable". The maintainer must explicitly waive it. The optional `modifyObject` was a deliberate compatibility choice (6dff080). Add a synchronized version bump with a release note.
- Update core ARCHITECTURE.md line 18.

**Risks.** Out-of-workspace users of the removed exports would break.

**Reviewer-required changes.**

1. Keep `ScopedDocumentPaths` exported. It is part of the public `ScopedConfigStore.configPaths` signature, which openai and cosmic-ui use. Remove only the option/selection types.
2. Keep `makeConfigDocumentErrorFactory`/`ConfigDocumentErrorFactory` exported, because six packages use them and pi-subagents uses them without the scoped store.
   - Reviewers split on location: fold them into scoped-config-store.ts, or keep document-ops.ts holding only the factory.
   - Keeping document-ops.ts is the lower-churn choice.
3. In background-task, write `decode: (value) => decodeConfig(value)`, or make `decodeConfig(value: JsonObject)` non-generic. Passing the generic function directly fails with TS2698 in `resolve`.
   - Layer: `AgentDirectory.use((dir) => store.resolveConfig(cwd, dir, projectTrusted)).pipe(Effect.map(({ config }) => config))`.
4. Tests the proposal missed:
   - Delete the pi-code-previews test "save fails typed without atomic document modification capability" (service.test.ts:409–430). Its fake becomes unrepresentable.
   - Rewrite all four `platform.test.ts` fallbacks (lines 80, 187, 223, 256) in the form `JsonDocumentStore.use((store) => store.modifyObject(...))`.
   - Drop the `store.modifyObject!` assertions in json-document.test.ts.
   - Delete the redundant `updateObject` operation in "caps actual file bytes".
   - The better-xai `updateObject` → `modifyObject` conversions cost about +15 lines, or less with `documents.set`. They disappear if providers-R1 lands first.
5. The inlined helpers must keep two guarantees, stated as comments:
   - project precedence is decided by existence, so a malformed project document still wins `configPath`;
   - when untrusted, the project path gets no `exists` or read call.
     Keep the "inspect" mapping on exists failures. Add one store-level core test for trusted project precedence and exact paths (about 10–12 lines); today only consumer tests cover it. Write the read-or-warn helper so it does not trigger the `effectSucceedWithVoid` language-service message.
6. Correct the title and justification: "core's single scoped resolver". pi-mcp, pi-subagents, pi-code-previews, and pi-directory-models keep their own resolvers and trust gates.

**Migration steps.**

1. Make `modifyObject` required, delete the Atomic alias, remove the five production guards and the four test fallbacks, delete the code-previews dead-branch test, and retype the pi-mcp and pi-cosmic-ui tests that used the alias. Run `pnpm validate`.
2. Remove `updateObject` from the contract, the live store, and the in-memory store, and convert the tests. Run `pnpm validate`.
3. Rewrite background-task's store over `makeScopedConfigStore`. Run `pnpm --filter pi-background-task test`.
4. Inline the scoped readers, delete `scoped-store.ts` and the index exports, add the precedence test, and update ARCHITECTURE.md. Run `pnpm --filter pi-cosmic-core test` and `pnpm validate`. If versions are bumped, run `pnpm version:check`.

---

### 11. mcp-core-R1: one JSON-Schema policy shared by the parent pre-check and the validator helper

- **Ids:** mcp-core-R1
- **Packages:** pi-mcp
- **Vetted LOC:** source −165, tests +20. Architect estimate −170/0. Measured −184 to −200 source with the full policy in the parent. The reference-free parent mode costs a few lines.
- **Risk / effort:** low / M

**Problem.** The same JSON-Schema policy is written twice:

- `validation/schema-policy.ts` runs in-process before the helper is spawned;
- `boundary/schema-validator-helper.mjs` runs inside the helper.

Both carry dialect sets, keyword sets, value predicates, and applicator-position classification. The helper's copy is a strict superset, and a 200k-sample fuzz found no schema that the parent rejects and the helper accepts. The parent copy is a weaker second implementation that must be kept in sync by hand.

**Target design.**

- Move the helper's pure policy verbatim into plain-ESM `src/validation/json-schema-policy.mjs`. Plain ESM is required because the helper runs under plain Node, and Node refuses to strip TypeScript types under node_modules.
- Add a minimal hand-written `.d.mts`.
- The helper imports it.
- `schema-policy.ts` keeps only the bounded snapshot and request encoding, then calls `assertSchemaDocument`.

**Justification.** About 190 duplicated lines go, and the parent and helper enforce the same rules from one source. The helper's independent check stays in place and runs the same code.

**Behavior changes.**

- Accepted schemas are unchanged.
- Some schemas the helper already rejected are now rejected before process admission: a reachable `nullable`, a required unsupported `$vocabulary`, a non-schema `contentSchema`, a nested `$schema` that differs from the root, a bundled metaschema root `$id`, and `__proto__` under `dependencies`.
  - For `tools.call` input these change: `data.kind` goes from unavailable to invalid-input; the diagnostic goes from "MCP operation failed" to "Configuration or input rejected"; the compact line goes from "The server is unavailable." to "The request is invalid."; and the activity-log failure kind changes.
  - For elicitation only `data.kind` changes.
  - Output validation is unchanged.
- This is a consistency fix. Schemas the parent already rejects are reported this way today.
- These schemas still take the process-wide permit briefly, because `encodeRequest` runs under `processAdmission.withPermitsIfAvailable(1)`. They just no longer spawn a process.

**Convention changes.**

- None to CLAUDE.md.
- This is the first `.ts` file in the workspace that imports a `.mjs` in-process. tsc, jiti (async, static, and sync), vitest, and the pack smoke cover it.
- ARCHITECTURE.md validation paragraph: `json-schema-policy.mjs` becomes the single policy source. It is plain ESM because the helper runs it under Node. The parent applies it without reference expansion, and reference-target guards, compilation, and validation stay in the helper under its deadline.

**Risks.** New in-process CPU on Pi's thread. The next item handles this.

**Reviewer-required changes.**

1. **The parent must not expand references.**
   - The justification reviewer measured an adversarial anchor fan-out (refs × percent-encoded anchor fragments, which the `steps` counter does not count). A 503 KiB schema that passes the policy took **2.5 s** of synchronous CPU in the parent. The same schema takes 13 ms through today's parent check.
   - Give `assertSchemaDocument` a reference-free mode, e.g. `assertSchemaDocument(schema, { references: false })` backed by `const targets = references ? referenceTargets(root) : () => []`, and declare it in the `.d.mts`.
   - The parent then runs only the linear applicator walk. It costs about 0.1 ms for a typical schema and 15–75 ms for adversarial linear schemas.
   - Rejections of pointer or anchor targets, and malformed reference encodings, stay in the helper with today's `unavailable` result.
   - The other two lenses measured only linear schemas, so this requirement does not conflict with them.
2. Correct the behavior statement as above: permit use, and the full list of observable changes for tools.call and elicitation.
3. The helper's main block also uses `isPlainObject` and `isBoolean`. Export them from the shared module, or move the `{schema, data}` input check into it as `assertValidationInput`. Keep `maximumInputBytes` in the helper. Optionally export the byte, depth, and node limits so `JSON_SCHEMA_VALIDATOR_LIMITS` does not become a third copy.
4. Keep the `.d.mts` minimal: only `assertSchemaDocument`. It is not type-checked against the `.mjs` (skipLibCheck, no allowJs).
5. Verification:
   - Run the root `pnpm pack:smoke`, which runs the packed helper and loads pi-mcp through jiti/static.
   - Add `pi-mcp/src/validation/json-schema-policy.mjs` to the packed-source list in `scripts/verify-packed-core.mjs` (+1 line).
6. Tests:
   - Add applicator-reachable cases to the existing loop "rejects async extensions and malformed constraints before process admission", e.g. `{ type: "string", nullable: true }` and `{ properties: { a: { nullable: true } } }`, and assert the fake runner is not called.
   - Do **not** add a `$ref`-reached `nullable` case. With references disabled in the parent, that one stays helper-side.
   - Keep every `runHelper` test unchanged. No dedicated null-prototype test is needed.
7. Naming: avoid `schema-policy.ts` sitting next to `json-schema-policy.mjs`. For example, name the new file `schema-rules.mjs`, or rename the `.ts`, which has only two importers.

**Migration steps.**

1. Move the helper policy verbatim into the shared `.mjs`. It should export `assertSchemaDocument`, `assertDataDocument`, and the helper's predicates. The helper imports it. `runHelper` tests must pass unchanged. Run `pnpm --filter pi-mcp pack:dry`.
2. Add the reference-free mode and the `.d.mts`. Switch `encodeSchemaValidationRequest` to a plain snapshot plus `assertSchemaDocument(..., {references: false})`, then delete the TypeScript keyword, dialect, and context code. Add the pre-admission test cases. Run `pnpm --filter pi-mcp test`.
3. Update ARCHITECTURE.md and verify-packed-core. Run `pnpm validate` and `pnpm pack:smoke`.

---

### 12. previews-render-R1: delete the bounded intra-identifier text-alignment refinement

- **Ids:** previews-render-R1
- **Packages:** pi-code-previews
- **Vetted LOC:** source −163, tests −53. Architect estimate −164/−53. About −6 more in bench and docs (not counted). An optional `tokenMiddleRange` collapse saves −18 more.
- **Risk / effort:** low / M (small in practice)

**Problem.**

- Word emphasis refines changed text at three levels: tokens, identifier parts, and a third grapheme-level alignment inside tokens (`refinedTokenTextRangesByAlignment`).
- The third level carries six helpers, four tuning budgets, and a substring pre-scan, which is about 65% of `token-text-refinement.ts`.
- Differential runs over real git histories show it changes output rarely:
  - 7 of about 54,000 blocks (behavior lens);
  - 21 of 113,278 line pairs (feasibility lens);
  - 1 of 32,780 blocks in cosmic-pi (justification lens).
- Where it does change output, the old result is often worse: fragmentary or mid-word spans such as "deModeCo" and 'vistast'/'modern','st'.

**Target design.**

- `refinedTokenTextRanges` keeps its outer contract, grapheme-safe prefix/suffix, and the `shouldRefineTokenText` gate. It returns one middle gap per side.
- Delete the alignment branch and its helpers.
- Delete `textBoundarySegments`/`TextBoundarySegment` from text-boundaries.ts.
- `suffixAlignedPairs` stays, because two other callers use it.

**Justification.**

- Removes a whole refinement level for a feature that rarely changes output.
- One refinement path remains inside a token.
- The render path gets slightly cheaper.
- `docs/word-emphasis.md` itself says to prefer real examples over synthetic tuning, and to favor missing an emphasis over a misleading one.

**Behavior changes** (corrected by reviewers):

- A changed identifier whose changed middle contains a common run of 3 or more graphemes now gets one wider contiguous span per side.
- A one-sided, multi-point insertion or deletion around such a run becomes two-sided. For example, `userabcName` → `userXabcYName` changes from `[]` / `['X','Y']` to `['abc']` / `['XabcY']`.
- The path also runs on identifier parts and on soft-aligned token pairs, through the one-sided override at range-refinement.ts:112–117.
- The correct "today" output for `qwindowsvistastyle` → `qmodernwindowsstyle` is 'vistast' / 'modern','st'.
- Line pairing does not change.

**Convention changes.** Remove the line-38 bullet in `packages/pi-code-previews/docs/word-emphasis.md`. That doc ships in npm `files`. Reword the "internal-token refinement" mention at about lines 99–101.

**Risks.** This is a product judgment: the feature shipped deliberately. Needs maintainer sign-off.

**Reviewer-required changes.**

1. Update `docs/word-emphasis.md` as above, and correct the proposal's claim that no doc describes the mechanism.
2. Remove the "bounded internal token refinement" case (`fooaabarbbbaz`) at `bench/word-pathology.ts` lines 122–126.
3. Keep the test "bounded text alignment does not preserve incidental unanchored substrings", but rename it, e.g. "token text refinement requires shared token edges". It still pins the shared-edge gate.
4. Delete the internal-runs unit test, the two budget-fallback tests, and the golden case. Do not relabel the golden case to the coarser output, because the corpus holds hand-labelled ideal spans.
5. Rewrite `behavior_changes` as above. Record the real-world evidence in the commit message.
6. Land as one commit. Drop the performance claim: the bench case it cited was never eligible for this path.
7. Optional: collapse `tokenTextGapRanges` into `tokenMiddleRange(token, prefix, suffix)`. The file drops to 62 lines instead of 80, and tests pass.

**Migration steps.**

1. In one commit, remove the alignment branch, its helpers, constants, and type, plus `textBoundarySegments`. Delete or rename the listed tests and the golden case, and update the doc and bench.
2. Run `pnpm --filter pi-code-previews test`, `pnpm --filter pi-code-previews word:accuracy`, and `pnpm validate`.

---

### 13. sub-run-R1: replace the hand-written run-module dependency bags with producer-derived op types (optionally a constrained RunContext)

- **Ids:** sub-run-R1
- **Packages:** pi-subagents
- **Vetted LOC:** source −160, tests +15. Architect estimate −300/0.
  - Step 1 alone is about −100.
  - The feasibility reviewer measured a broad RunContext at −243 source / +12 tests.
- **Risk / effort:** low / L

**Problem.** `SubagentService` is split into about 15 `make*` factories. Each declares its own `*Dependencies` interface: about 306 lines, followed by about 100 lines of destructuring. `service.ts` then spends about 173 lines passing the same primitives around. `withLock` is declared 13 times, and `settle`/`failRun`/`publish` and others about 28 more times. `retry.ts` has its own copy of `requireRecord`.

**Target design.**

1. Export `ReturnType` aliases for the producers:
   - `RunSettlement`, `RunAssignment`, `RunRecordCleanup`, `RunProcessControls`, `RunProcessInitializer`, `RunCompletionObservations`, `RunProxyExecution`;
   - plus aliases for `makeRunEventHandler` and `makeRunProxyExecution`.

   Replace every restated signature with `Pick<>` or indexed access. Export `WithRunLock` once. `retry.ts` uses the service's `requireRecord`. The pure `requireCapability`/`unsupportedCapabilityMessage` move to a run module that is imported directly instead of injected.

2. Optionally add a constrained `RunContext` for service-owned primitives.

**Justification.** Each cross-module operation gets exactly one declared type, taken from the module that produces it. Most of the composition-root plumbing goes away. The benefit is less plumbing, not bug prevention.

**Behavior changes.** None. Construction order, lock instances, and allocators are unchanged.

**Convention changes.** Add one sentence to the ARCHITECTURE.md run/ bullet: run modules receive service-owned primitives, name cross-module ops by their producer's type, and only launch mutates the run registry.

**Risks.**

- Spreading producer objects can silently hand the raw `closeRecordScope` to consumers in place of the questionnaire-draining wrapper (see requirement 3).
- Inference cycles in TypeScript. None exist today.

**Reviewer-required changes.**

1. **Order.** Do the type-only step first, as its own change: about −100 lines, no wiring change, no test churn, every port kept. A constrained RunContext is optional after that.
2. **RunContext constraints (if adopted).**
   - Type `ctx.records` as `ReadonlyMap`. Pass the mutable Map explicitly only to launch, which is the only module that inserts or evicts.
   - `writerPools` is read-only where it is only read.
   - Membership:
     - The justification reviewer: only primitives with 3 or more consumers (ownerScope, withLock, publish, records, writerPools, writerLeases, requireRecord, sendPeerNotices, allocateAssignmentAttemptToken).
     - The feasibility reviewer: the whole service-owned primitive bag.
     - The vetted −160 reflects the strict list, which is recommended.
3. **Questionnaire-drain hazard.** `makeRunRecordCleanup` returns a raw `closeRecordScope` with the same type as the service's draining wrapper.
   - Wire producer ops by explicit name. Spread only `ctx`, never a producer object, and never the cleanup result.
   - Or build a single cleanup object whose `closeRecordScope` is the draining wrapper.
   - Add a questionnaire-lifecycle test showing that an outstanding questionnaire is drained on the resume or launch-compensation close path.
4. Keep each module's existing destructures and body identifiers, using renaming destructures where names differ (`steer: steerBackend`, `runStartedFromBackend: runStarted`). Do not rewrite launch/control/resume/events bodies to `ctx.`/`ops.` access, which is interruption-masked lifecycle code.
5. Keep every contract comment that currently lives only on consumer fields. Move each one to the producer or to RunContext. These include:
   - activateAssignmentLocked "caller holds the service lock";
   - queueActionNotificationLocked "inside mutateView's locked transition";
   - "Must durably confirm writer spawn-started evidence before a driver spawn";
   - "Host/ancestor boundary; outside the service lock";
   - the quarantine note;
   - the turn-input "under the service lock" notes;
   - the notes on currentProjection/waitForRevision, isClosed, and the allocators.
6. Explicit service-owned ops:
   - admitTurnInput/releaseTurnInput/claimTurnInputDrain, keeping `RunTurnInputAdmission` as their type;
   - notify, currentProjection, waitForRevision, executions, onWriteClaimViolation.

   Inline the adapters: `beginAssignmentBackend` becomes `ops.submitPrompt(record, message, "resume", token)`, and `quarantineReclaimFailure` becomes `ops.retainCleanupQuarantine(record, record.scope)`.

7. Construction order:
   - build `ctx` after `publish` and `requireRecord`;
   - move `makeWorkspaceControl` below it (it is synchronous and registers no finalizer);
   - `makeRunNotificationDelivery` stays after `FiberMap.make` and before `addFinalizer`;
   - `stop` and `containWriteClaimViolation` keep their lazy forward references;
   - keep the "completion-" and "retry-" token prefixes.
8. Merge the proposal's migration step 1 into step 2, because an unused `ctx` fails noUnusedLocals.
9. Tests:
   - Use a small typed `runContext` fixture builder under `tests/run/fixtures` (defaults plus overrides), so the three factory tests stay free of type assertions.
   - If a cast is used instead, it must have exact parameter lists and a SAFETY comment. Never use `as unknown as`, which the anti-slop rules ban.
10. Remove the "drift" and "silently widened" claims from the justification. Narrow consumer ports are deliberate, and service.ts already type-checks producers against ports.

**Migration steps.**

1. Producer-derived types, a single `WithRunLock`, the retry `requireRecord`, and moving `requireCapability`. Run `pnpm --filter pi-subagents test`.
2. Optional: introduce RunContext and convert the leaf factories, with the fixture builder. Package tests.
3. Optional: convert settlement, assignment, process-lifecycle, and events. Package tests.
4. Optional: convert control, launch, and resume, and collapse the service wiring. Package tests.
5. Update ARCHITECTURE.md and run `pnpm validate`.

---

### 14. sub-settings-R4: fold the bespoke Save-as-set form into the dashboard's name dialog

- **Ids:** sub-settings-R4
- **Packages:** pi-subagents
- **Vetted LOC:** source −140, tests −38. **Counted at −135/−38**, because sub-settings-R1 already removes about 5 lines of the save form's unused options. Architect estimate −145/−45. Measured −147/−38.
- **Risk / effort:** low / M

**Problem.** `ProfileSetSaveFormComponent` (105 lines) and its renderer (71 lines) implement a three-section form with its own keymap, section cycling, validation copy, framing, and compact layout. Most of it duplicates `ProfileDashboardDialog`'s name mode, which Copy and Rename already use.

**Target design.** Name mode gains a destination option and renders a body. The dashboard `save` callback opens the name dialog and closes it with a `ProfileSetSaveDestination`. `ProfileSetSaveDestination` moves to `profile-set-actions.ts`. The form and its renderer are deleted.

**Justification.** Save, Copy, and Rename then share one name-entry implementation and one validation path. This removes one of the dashboard's four bespoke full-screen components. Trust is still rechecked after the dialog through `guard(destination.scope)`.

**Behavior changes** (visible; need maintainer sign-off):

- The form becomes a plain dialog inside the dashboard frame. The framed child, section cursor, `[Save Current Session]` button, and 08f52d6's focusedField styling go away.
- The destination control changes (see item 1).
- The validation wording is unified.
- At about 6 terminal rows the plain dialog cannot draw the input. Copy and Rename already behave this way.

**Convention changes.**

- `docs/settings-workspace.md` lines 21, 58, and 69: `profile-dashboard-dialogs.ts` owns the confirmation, name, and save-destination dialogs.
- ARCHITECTURE.md: replace "including save forms".

**Risks.** The keybinding and scope-flip hazard in item 1.

**Reviewer-required changes.**

1. **Destination toggle key (needs a decision).**
   - The behavior reviewer wants raw ↑/↓, which is what the current form's hint advertises. Tab stays inert, so "type a name, Tab, Enter" still saves to Project.
   - The feasibility and justification reviewers used Tab/Shift+Tab with a visible hint.
   - Recommended: ↑/↓, using `matchesKey` on up/down. Do not use configured `tui.select.up/down`, because printable bindings such as k/j must reach the Input.
   - If Tab is chosen, list the Tab-then-Enter scope flip as a behavior change.
2. **API.** Use a narrow option rather than the generic `choice {values, label, initial}`, e.g. `destination?: { projectTrusted: boolean }`. The initial value is project when trusted, else global.
   - Close directly with `{scope, name}`, so `runProfileSetAction` needs no mapping layer.
   - Do not widen the shared `string | boolean` close union. Give this mode its own typed callback, or make close generic. If the close signature changes, update the "printable configured cancel bindings" assertion.
   - Narrow without `typeof`, because the anti-slop `no-runtime-typeof` rule rejects it.
   - The untrusted variant shows a single fixed Global line with the "(Project requires trust)" hint.
3. **Render order.** The input comes first, then the destination line (with the key hint), then the wrapped body, cut to the body height. That keeps the cursor row and CURSOR_MARKER visible at small heights.
   - Two lenses asked for input-first. The justification reviewer asked for the current order (destination first); input-first is chosen for its small-height safety.
   - Force `maxOffset` to 0 in name mode, so no false "↑/↓ Scroll" hint appears.
4. Put toggle handling in a private `cycleChoice(data)` method (or the up/down equivalent). Inline, `handleInput` reaches oxlint complexity 22, above the limit of 20.
5. Clear the validation message when name-mode input is edited, as the form does today. This takes one line and also helps Copy and Rename.
6. **Tests.**
   - Delete `profile-set-save-form.test.ts`.
   - Add dialog tests for:
     - destination and normalized name submitted together;
     - toggling keeps the typed name;
     - an untrusted project never produces `project`;
     - an invalid name keeps the dialog open;
     - printable dashboard shortcuts stay inside the Input;
     - Copy/Rename behave unchanged when there is no destination.
   - Add one dashboard test: untrusted, press `s`, step the event loop (the dialog opens in a microtask), type, toggle, Enter; the save goes to global.
   - No copy or layout assertions. The existing save, disposal, and serialization tests stay unchanged.
7. The `preferredScope` removal belongs to sub-settings-R1.

**Migration steps.**

1. Add the destination option, the render order, the toggle method, and the clear-on-edit to `ProfileDashboardDialog`, with dialog tests.
2. Switch the dashboard `save` callback and move `ProfileSetSaveDestination`.
3. Delete the form, its renderer, and its test. Update the docs. Run `pnpm --filter pi-subagents test` and `pnpm validate`.

---

### 15. sub-settings-R2: collapse the profile model-choice double projection into cosmic `ModelPickerModel` options

- **Ids:** sub-settings-R2
- **Packages:** pi-subagents
- **Vetted LOC:** source −130, tests −3. Architect estimate −150/−5. Measured −142/−6.
- **Risk / effort:** low / M

**Problem.** Model rows are projected three times:

1. Into `ProfileModelPickerChoice`. For Pi models this calls cosmic `createModelPickerChoices` one model at a time.
2. Back into `ModelPickerModel`.
3. Again by cosmic.

The selected choice is then searched for again to recover efforts and fast mode. Six ad-hoc parent/model matchers exist.

Some text is built and never shown. Cosmic ignores `description` when there is no `label`, so the Pi fast-mode description is never rendered. The unavailable row's description and its fast-mode lookup are also never rendered.

**Target design.**

- `ProfileModelOption extends ModelPickerModel { selector; supportedEfforts?; fastModeAvailable }`.
- Pi options pass models straight through with no label override. Parent, native, and unavailable rows keep their explicit labels.
- One `retainUnavailableCurrent` helper handles both the scoped and the full lists.
- The page returns the option. Selector equality replaces the matchers.

**Justification.** Two representations and a round trip collapse into the one type the shared picker already defines. Code that looks meaningful but never renders goes away. A 150-case old-versus-new comparison and a 30-scenario probe found zero differences.

**Behavior changes.** None. Pi rows' "(current)" marker now follows the page's `current` (`initialSelection`). The two are equal because the Pi loader never sets `defaultSelector`.

**Convention changes.** None.

**Risks.** Low. It relies on cosmic's label-less default rendering.

**Reviewer-required changes.**

1. Dashboard `supportedPiEfforts` must keep today's gating:
   - parent efforts only when `host === "local"`;
   - exclude selectors that fail `isSafeNativeModelSelector`.

   Either use `createPiModelOptions(...).find(o => o.selector === candidate.model)?.supportedEfforts`, or read the catalog directly with the explicit `candidate.model === "parent" && candidate.host !== "local"` guard. Delete `projectedParentModel`.

2. The unavailable-current option keeps `fastModeAvailable: false` as a required field. Otherwise `openCapabilityPicker` falls through to the global fast-mode check.
3. Build the "configured model is not available" warning from the same `retainUnavailableCurrent` result, using a flag or `choices[0]?.available === false`. Tie it to the full advertised list. Use one `optionsFor(models)` closure for both lists.
4. **Security test.** Pi options no longer carry label, description, or searchText, so the "sanitizes Pi and native display text" test would pass vacuously. Fix it:
   - Render `picker.choices` through cosmic `createModelPickerChoices(picker.choices, picker.current)`.
   - Assert that `item.label`, `item.description`, and `searchText` contain no terminal controls, including for the ESC-bearing model name.
   - Keep an assertion that the retained unavailable row is `available: false`.
5. Land the model-picker, catalog, pickers, and test changes in one commit, because steps 1 and 2 cannot be separated. The dashboard change can land separately.
6. Add a one-line comment above `current` in `makeProfileModelPickerPage` recording the defaultSelector invariant.
7. PR notes:
   - the capability-picker parent/fast-mode matcher (a60bc21) is replaced by selector equality; it is equivalent and unreachable;
   - tell the maintainer that 4943075 silently dropped " · fast mode available" and "none" from Pi rows. Do not turn that into visible text in this refactor.
8. The navigation fixture still needs `provider` and `id`, so it saves about 0 lines.

**Migration steps.**

1. One commit: add options and builders, `retainUnavailableCurrent`, and the page passthrough; replace `updateCandidateFromModelChoice`/`selectedModelEfforts` with a direct `updateCandidateModel`; fix the tests.
2. Dashboard `supportedPiEfforts`. Delete the old types and builders.
3. Run `pnpm --filter pi-subagents test` and `pnpm validate`.

---

### 16. sub-settings-R3: replace the saved-set library's hand-built menu and delete prompt with the shared selector and a host confirmation

- **Ids:** sub-settings-R3
- **Packages:** pi-subagents
- **Vetted LOC:** source −120, tests 0.
  - Architect estimate −185/−10.
  - Feasibility measured −124/−9 on the dashboard-dialog build. Justification estimated about −145/0 for the picker-hosted build.
- **Risk / effort:** low / M

**Problem.** The saved-set library runs a second menu system next to the shared `SearchableSelectPage`: `actionChoices`, `openActions/chooseAction/handleMenu` with its own motion and window math, a compact menu branch, footer variants, and a local `windowStart` copy. It also runs a second destructive-confirmation path, an inline delete prompt, next to the dashboard's confirm dialog.

**Target design.**

- A `savedSetMenuPage(entry, host)` builder produces a `SearchableSelectPage` over complete `ProfileSetPickerAction` payloads.
- Delete confirmation moves into `runProfileSetAction` through `host.confirm`, followed by `guard(scope)`.
- The picker loses its menu and delete state, and the renderer loses three layout variants.

**Justification.** One menu mechanism and one host-owned destructive confirmation. Moving confirmation into the action layer also enforces it for every caller. The inline prompt predates the dashboard (68fb1c9); nothing suggests it was chosen over a dialog on purpose.

**Behavior changes** (minor, visible):

- The More menu renders as the shared selector, where descriptions show only after `?`.
- `l`, `/`, and `?` are active in the menu. `q` closes only the menu.
- An unavailable Delete appears dimmed, with a hint.
- Delete confirmation becomes the dashboard confirm dialog.
- A refresh no longer dismisses a pending delete. The store's `expectedDocument` check still guards it.
- "Delete canceled." moves to the dashboard status line.

**Convention changes.** ARCHITECTURE.md and settings-workspace.md: `profile-set-actions.ts` owns confirmed replacement **and deletion**.

**Risks.** An unsafe intermediate state: the menu dispatching delete without confirmation (see item 1).

**Reviewer-required changes.**

1. **Order.** First move delete confirmation into `runProfileSetAction`:
   - `host.confirm` with the current consequence copy, then `guard(scope)`;
   - on decline, notify "Delete canceled." and return;
   - capture the inspection before the dialog.

   Delete `pendingDelete`, `handleConfirmation`, and the inline prompt in the same change. Only then replace the menu. Never land a menu that dispatches delete without confirmation.

2. **Where to host the menu (needs a decision).**
   - The justification reviewer: host it **inside `ProfileSetPickerComponent`**, as `ProfileWorkspaceComponent` hosts `makeRouteActionsSelector`.
     - `private menu: SearchableSelectPage | undefined`;
     - drop Right before routing to the menu;
     - render the menu when open;
     - `hasOverlay` includes the menu; `updateInspection()` and `dispose()` clear it;
     - a focused getter/setter for the `/` filter.

     This adds no `more` action variant and no dashboard change, and it keeps stale-menu protection.

   - The behavior and feasibility reviewers built the dashboard dialog slot. It needs:
     - a separate `ProfileSetLibraryEvent` union (ProfileSetPickerAction stays unchanged, or runProfileSetAction's narrowing breaks);
     - opening only when `!busy && !blocked`;
     - a rejection handler and `cancel: () => close(undefined)`;
     - Right suppression in a helper, to stay under complexity 20;
     - the navigation-filtered matcher;
     - "more" emitted from `openActions` for every entry point.
   - Recommended: picker-hosted, which matches the Manage-menu precedent and avoids the dashboard changes.

3. **Review gate.** `ProfileDashboardDialog`'s confirm mode cannot confirm at dashboard heights of 7 or less, and its unreviewed copy is specific to Use. Make that message generic, or let a short body with no hidden content skip the gate. Keep the gate for Use.
4. **Menu clarity.**
   - `disabledHint` on the default set's Delete (e.g. "clear default first").
   - The invalid-default entry's description as the page subtitle or notice.
   - A subtitle that states the scope effect of Make default and clear default.
5. Use `listWindowStart` from `pi-cosmic-ui/manager/list-detail` and drop the local `windowStart`.
6. **Tests.**
   - The "late mutation settlement cannot refresh or publish after disposal" test must still revoke _after_ `deleteProfileSet` is called: add a `step(eventLoopTurn)` and assert the order, or it passes vacuously.
   - Add a declined-delete action test: no delete and no refresh.
   - Add a pure choice-list test.
   - With the dialog slot, add a keystroke test: Tab, a, G, Enter, render; then x and Shift+Enter do nothing, and Enter deletes.
7. Drop optional step 6, replacing inline search. It removes the documented live preview.

**Migration steps.**

1. Delete confirmation in `runProfileSetAction`, with the inline-prompt removal and the test changes above.
2. Add the menu builder and choice-list test.
3. Host the menu (picker-hosted recommended). Delete the picker's menu state, the render branches, the footer variants, and `windowStart`.
4. Update the docs. Run `pnpm --filter pi-subagents test` and `pnpm validate`.

---

### 17. code-mode-R2: one result slot for code_mode, and delete the dead `expandedResultOwnsCall` path

> Superseded by the compact-presentation redesign (2026-09-25); see the README note.

- **Ids:** code-mode-R2
- **Packages:** pi-code-mode
- **Vetted LOC:** source −115, tests −60. Architect estimate −160/−115. The reviewers' narrowed scope measures about −115 to −150.
- **Risk / effort:** low / M

**Problem.**

1. The `expandedResultOwnsCall` / `ownsCall` machinery is dead in production.
   - `application.ts` always passes `expandedContent`, and the shell honours the flag only when there is no expanded content.
   - The one reachable case (the shell rejects a summary that the controller accepted) shows the Program twice.
   - It carries a deliberate "throw to reject the slot" protocol and an emergency Program block.
2. `controller.ts` duplicates a roughly 40-line result body across `renderResult` and `expandedContent.renderResult`.
3. `ui/status.ts` and `ui/result-read-renderer.ts` implement the same plain view twice.

**Target design** (scope narrowed by all three reviewers):

- Delete the `ownsCall` path.
- One `resultSlot(contentOnly)` factory.
- Share one plain renderer between the status and read views.
- **Drop** the proposed `CodeModeView` table and the move of read handling out of tool-renderer.ts and compact-summary.ts. It is roughly line-neutral, and done naively it changes behavior (item 1).

**Justification.** It removes an unreachable ownership protocol, including its throw-to-reject convention. It also removes one duplicated result body and one duplicated plain view, including its hostile-theme fallback.

**Behavior changes.**

- The rejected-summary edge case shows the Program once instead of twice.
- If the presentation-policy capture throws, the slot renders with default timing instead of throwing into the shell fallback.
- The status view gains the read view's plain-text evidence fallback.

**Convention changes.** Reword ARCHITECTURE.md lines 150–156. "Renderer failure retains bounded source" should say the call slot retains the source.

**Risks.** Low.

**Reviewer-required changes.**

1. **Keep the read summary pipeline.** A read error is returned with `isError: false`. `codeModeCompactSummary`'s `withBodyClaims` pass adds the outer `pi-error` issue for it ("The tool reported an error." / "Tool reported a failure."). Do not move the read branch out of compact-summary.ts. The `compact-summary.test.ts:115` read test stays as it is.
2. The `resultSlot(contentOnly)` factory:
   - keeps the existing `codeModeStatusRequest` branch;
   - passes reads through `renderCodeModeToolResult` with `readRequest`;
   - calls the plain `codeModeCompactSummary` with `liveElapsed`, never the `AtHost` variant, which would churn the ticker;
   - ends with `syncProgressTicker`.

   `compactSummary` becomes a status/AtHost ternary. Detection order stays status, then read, then execution.

3. A guarded `timingEnabled()` helper, defaulting to true, replaces the throwing IIFE. The expanded-code-mode test "cannot accept ownership" then tests nothing: retarget it to a real slot failure or delete it.
4. **Shared plain renderer.**
   - It takes a precomputed status line. The read line appends summary counters; the status line must not.
   - Raw-text extraction stays per view: a strict all-text decode for status, lenient text-part filtering for read.
   - Prefer putting it in an existing module (result-read-renderer.ts or status.ts) rather than a new file.
5. **Tests.**
   - Delete the two ownership tests (tool-renderer.test.ts 268–385) and the capture-failure ownership test.
   - Retarget "owns one expanded source/header" to the production shell by adding `expandedContent` and dropping the flag assertion. It already passes on current code.
   - In the drawing-failure fixture, remove `ownsCall`/`source` but keep the hostile-theme, raw-output, and recovery assertions.
   - Do not add a new ~40-line suite; presentation-conformance already covers the Program appearing once.
6. **Follow-up for the pi-code-previews owner (not counted):** retire the legacy `expandedResultOwnsCall` flag. After this change no workspace producer sets it.

**Migration steps.**

1. Delete the ownership path (controller wrapper, `ownsExpanded`, the IIFE, `ExpandedPresentation.ownsCall/source`, expanded-result.ts lines 60–92, tool-renderer.ts lines 356–370), with the test changes.
2. Add the shared plain renderer and switch status and read to it.
3. Add the single `resultSlot` factory.
4. Update ARCHITECTURE.md. Run `pnpm --filter pi-code-mode test` and `pnpm validate`.

---

### 18. ask-user-R1: one owned-call registry and one queued presentation runner for questionnaires and forms

- **Ids:** ask-user-R1
- **Packages:** pi-ask-user
- **Vetted LOC:** source −114, tests +5.
  - Architect estimate −200/0.
  - Measured −115 to −143 source; about −125 if the discovery step is included.
- **Risk / effort:** low / M

**Problem.** The local-extension form path copies the questionnaire's owned-request stack layer by layer.

- `host-proxy.ts` and `host-form-proxy.ts` (156 + 152 lines) are one algorithm:
  - an owner-keyed Map with a 16-call cap;
  - the `settled = Promise.resolve().then(() => running)` receipt;
  - cancel-then-join;
  - revoke-aborts-all.
- The two copies have drifted. Only the form copy guards against a throwing `isCurrent`/unsubscribe and rejects a pre-aborted signal.
- `form-service.ts` (93 lines) repeats `askRequest`'s admit/race/settle/close skeleton.
- The `admittedForm` member is redundant.

**Target design.**

- `boundary/host-owned-calls.ts`, a generic registry `registerOwnedCalls(kind, options)`. The two register functions become thin configs that keep their option shapes and their `run(effect, signal)` callback.
- A private `presentOwned` runner in `service.ts`. `askForm` moves into `service.ts`, and `form-service.ts` is deleted.
- `admittedForm` is merged into `admitted`.

**Justification.** It removes a second exact-owner cancellation-join registry (pi-subagents and pi-mcp depend on its semantics) and a second FIFO admission runner. The stricter guards then apply to both kinds. Forms remain a separate capability, with their own query name, owner type, registry instance, id counter, and revalidation step. Only the implementation is shared.

**Behavior changes.** No visible change for pi-mcp or pi-subagents, which remap every rejection.

- Today a pre-aborted root `ask` still takes a FIFO ticket, uses an `ask-blocking-N` id, publishes and settles an Activity row, and calls the host (with a synchronous host it can even resolve). After this change it is refused before running. pi-subagents cannot reach this path, because it checks `signal.aborted` first.
- A throwing `isCurrent` or unsubscribe now yields unavailable.
- Precedence between simultaneous rejections may differ.

**Convention changes.** None to CLAUDE.md. Update pi-ask-user ARCHITECTURE.md lines 16, 23, and 25, and pi-boundaries.md:21: `host-owned-calls.ts` owns the one registry, and AskUserService owns `askForm`.

**Risks.** The `settled` receipt ordering and the form's revalidation must be kept. Existing tests cover both.

**Reviewer-required changes.**

1. **Drop step A** (shared discovery collector) from this refactor.
   - It saves about 10–11 lines, adds a file and a `unique` mode flag, and rewrites public protocol functions that pi-subagents and pi-mcp import.
   - The justification reviewer asked to drop it; the other two accepted it with fixes. It can go to the small-cleanup review.
   - If it is ever done: keep it in a non-re-exported module; the per-kind `pick` reads version and sessionId exactly once; do not pre-read `value?.version`.
2. `presentOwned` takes its presented work **lazily** (`Effect.suspend` or a thunk). `host()`/`formHost()` must not run before `queue.admit`, including when admission fails as busy.
3. Keep form answer validation **inside** the raced present effect, so invalid answers still settle Activity as `failed`. Use two separate `Ref` counters, so ids stay `ask-blocking-N` and `ask-form-N`.
4. **Registry shape.**
   - The kind carries the service call as `effect: (request, owner) => Effect<...>`.
   - One shared `OwnedCallOptions<Outcome>` with `run(effect, signal)`.
   - Decoders are generic `<Input>` (the anti-slop rule forbids `unknown` parameters).
   - The form's `decodeRequest` includes `validateFormRequest`.
   - `settle` is written `(request, value) => validateFormOutcome(request, value)`, because generic inference fails otherwise.
   - The root owner decoder is `Option.getOrUndefined(Schema.decodeUnknownOption(QuestionnaireOwnerSchema)(input))`.
   - Optional: move the form's settle step into `registerOwnedFormCapability`'s run wrapper, so the generic registry needs no passthrough flag.
5. Do not export `queryCapability`/`provideCapability` from protocol.ts or form-protocol.ts, because `src/protocol.ts` re-exports them with `export *`.
6. Keep the root questionnaire's admission without `canQueue`.
7. **Tests.**
   - `tests/service.test.ts:76–78` needs an `"runId" in owner` narrowing once the owner is a union.
   - The `host-form-dialogs.test.ts` fixture moves to `AskUserService.layer(...)`, costing about +3 to +5 lines.
8. Error messages: keep each kind's exact text, or accept templated text (consumers remap). State which.
9. Correct behavior-change #1 as above.

**Migration steps.**

1. Add `host-owned-calls.ts`, and re-implement `registerOwnedFormCapability` as a config. `host-form-proxy.test.ts` and `host-form-tui.test.ts` stay green.
2. Re-implement `registerQuestionnaireCapability` on the same registry. `proxy.test.ts` and `application.test.ts` stay green.
3. Extract `presentOwned` in service.ts, move `askForm` and `OwnedFormHost` into it, merge `admittedForm`, and delete form-service.ts. Update the test fixtures.
4. Update the docs. Run `pnpm --filter pi-ask-user test`, `pnpm --filter pi-subagents test`, `pnpm --filter pi-mcp test`, and `pnpm validate`.

---

### 19. mcp-core-R3: shared pi-mcp service fakes; drop fixture-only optional contract members

- **Ids:** mcp-core-R3
- **Packages:** pi-mcp
- **Vetted LOC:** source +4, tests −165. Architect estimate −22/−280.
  - Without the layer split, source is about −21 to −24.
  - Tests measured −160 to −200.
- **Risk / effort:** low / L

**Problem.** Service tests hand-build the same fakes:

- 10 `McpAuth` fakes (123 lines);
- 9 `McpConfigStore` fakes (113 lines);
- 6 connector/connection fakes (247 lines);
- 4 `McpOperation` fakes;
- config literals in about 15 files.

Because fakes may leave members out, several contract members are optional only for fixtures:

- `authorizationRevision`;
- `exchange`, `checkContinuation`, `operationId`, `subscribeResource` on operations;
- `exchange`, `subscribeResource`, `remoteEvents`, `remoteEventDrops` on connections;
- three connections members.

Production code carries fallbacks for them. Every production implementer always supplies these members.

**Target design.**

- `tests/fixtures/services.ts` with small override-first builders:
  - `testSettings`, `testServer`, `testConfig`;
  - `fakeAuth`, `fakeConfigStore`, `fakeConnection`, `fakeConnector`, `fakeOperation`.
- Make the fixture-only members required and delete the production fallbacks.
- The `makeMcpServiceLayer` split is optional (item 2).

**Justification.** Contracts then state what production guarantees. About 160–200 lines of copied fakes are removed. The CLAUDE.md "mock owned domain boundaries" rule is applied consistently.

**Behavior changes.** None observable. The deleted branches are unreachable from production.

**Convention changes.** None.

**Risks.**

- A shared fixture can grow into a god object.
- Default semantics may silently change what a test covers (items 3–5).

**Reviewer-required changes.**

1. **Correct the source deletion list.**
   - Keep `?? Effect.succeed(0)` in `registry.readEvents`; it covers servers with no owner or connection. Delete only the `if (acquired.value.remoteEvents)` guard.
   - Delete:
     - `nativeExchange` in operation.ts;
     - the subscribe/unsubscribe/subscriptions/events.read fallbacks in tools/service.ts;
     - `!operation.exchange`, `?? checkCurrent`, and `?? owner` in conversation.ts;
     - `?? 0` in discovery/service.ts;
     - `|| !connection.subscribeResource` and its `!` in resources/subscriptions.ts;
     - the two "Omitted fixtures" comments;
     - `connection.remoteEvents!` in tests.
   - Keep `instructions`/`protocolVersion` optional.
2. **Layer split (optional; LOC-neutral).**
   - application.test and lifecycle.test fake `McpExecution` on purpose. They only switch to the shared auth and store fakes.
   - The discovery harness keeps its own connections and discovery wiring.
   - If a builder is kept, it returns `{ layer, internals }`, where `internals` holds connections, discovery, and results for tests only. `makeMcpLayer` returns `.layer`, so the `McpApplication` type does not widen and McpConnections never enters the session runtime context.
   - Only the manager test and optional-features use it. optional-features uses a core graph without McpManager/McpAuthFlow, which would change its interleavings.
   - Keep passing the raw `isTrusted` to McpConnections and the wrapped one to auth.
   - `scripts/verify-mcp-compat.mjs` should also use the builder.
   - The justification reviewer recommends dropping the split, since the fidelity gain is about 25 lines.
3. **`fakeConnection` is request-first.**
   - `exchange = (i, o) => request(i, o).pipe(Effect.map((reply) => ({ kind: "complete", reply })))`. Every existing hook is written against `request`.
   - Defaults: `subscribeResource` fails as unsupported (capability flag false); `remoteEvents` is `Stream.empty`; `remoteEventDrops` succeeds with 0.
   - `health`, `close`, and `terminal` can each be overridden whole. This keeps invocation's constant health with a no-op close (about line 1864) and the connection test's failing uncertain close.
   - A function-form override exposes the terminal Deferred, for terminal-before-reply.
   - `fakeOperation`: `exchange` derived from `request`; `checkContinuation` defaults to the overridden `checkCurrent`; it supplies `operationId` and `authorizationRevision`.
4. **`fakeConfigStore`** exposes `current()` and `publish(next)`, and takes spread overrides.
   - It defaults to production subscribe semantics: publish the current value, then capture one subscriber.
   - Migrate the discovery and manager harnesses one file at a time, checking that assertions still hold for the same reason.
   - The connection test's revision-bumping reload stays an explicit override.
   - Do not migrate settings.test.ts's `vi.fn` store.
5. Keep redaction sentinels explicit at call sites (private-executable, /private/secret-path, private-config-hash, private-command, private-argument). Build settings from `DEFAULT_MCP_SETTINGS` with explicit overrides. Do not route the config/schema, config/store, or project-root tests through `testConfig`.
6. **Missed files:**
   - `tests/boundary/sdk-connection.test.ts` (its shared `fakeConnection`);
   - the second connection fake near line 1031 of `connection/service.test.ts`;
   - `resources/subscriptions.test.ts`;
   - `discovery/cached.test.ts` (add `authorizationRevision: 0`);
   - the invocation `McpConnectionsContract` fake (add `resourceSubscriptions`, `unsubscribeResource`, `readEvents`).

   Tighten the contracts in the same step as migrating these fakes: a missing `exchange` crashes at runtime, not only in the type check.

7. Migration check: before each file moves, confirm its assertions still exercise the same request, exchange, and close paths.

**Migration steps.**

1. Add config, server, auth, and store builders. Migrate the application, lifecycle, settings (auth/store only), and optional-features tests. Run `pnpm --filter pi-mcp test`.
2. Add the connection, connector, and operation builders. Migrate the pagination/prompts/resources operation tests and the discovery, manager, and connection harnesses, one file per commit.
3. Optional: the layer builder with `internals`.
4. Migrate the invocation harness and the missed files. Make the members required and delete the fallbacks. Run `pnpm validate`.

---

### 20. mcp-boundary-R1: one SDK connection driver for Streamable HTTP and stdio

- **Ids:** mcp-boundary-R1
- **Packages:** pi-mcp
- **Vetted LOC:** source −100, tests 0. Architect estimate −200/0. Reviewer range −100 to −165.
  - The driver file is about 215–230 lines. The bounded-cleanup leaf is about 18.
  - Steps 1–4 alone are about −80 to −90.
- **Risk / effort:** medium / L

**Problem.**

- `openSdkHttp` and `openSdkStdio` are two hand-copied copies of the same masked acquisition and close state machine. Each has a deadline with `remaining`, an owner scope, a cached uninterruptible close, a finalizer, an uninterruptible acquire fork, observe under budget, capabilities plus handshake, and the same McpConnection assembly.
- The two differences are deliberate and commented, not drift. They are close order, and sticky versus recomputed cleanup evidence (sdk-stdio.ts:339–340 from f2d95dd; sdk-http.ts:162).
- Option bounds are validated twice, once by a hand validator and once by a Schema, with the same maxima.
- The SDK error classifier is copied.
- Bounded promise cleanup is repeated five times.
- The HTTP exchange encodes each request a second time.

**Target design.**

- A plain function driver, not a Service or a second scope owner, in a file **not** named "session", e.g. `sdk-lifecycle.ts` or `sdk-open.ts`. It owns the deadline, owner scope, cached close, evidence publication, observe budget, and assembly. Each transport supplies native acquisition, exchange, and one per-transport close policy.
- Shared `SdkLimitFields`.
- `mapSdkClientError`.
- A leaf `boundedSdkCleanup`.
- `decodeMcpRequest(value, maxBytes)`.

**Justification.** Future fixes to acquisition interruption, evidence publication, and assembly then land once. The deliberate differences become named, commented policy. A prototype passed all 1293 pi-mcp tests. Flipping each policy field breaks existing tests, so the suites really do guard the close path.

**Behavior changes.** None to kind, outcome, reason, cleanup order, or evidence per transport. Agent-visible messages stay per transport (item 1). Trivial changes:

- the byte-limit error now wins over the invalid-header error (both are invalid-input/not-sent);
- HTTP rejects limit or protocol keys passed explicitly as `undefined` (only untyped callers can do this);
- the deadline clock starts microseconds later.

**Convention changes.**

- ARCHITECTURE.md: the stdio and HTTP paragraphs name the driver.
- pi-boundaries.md:87.
- The extraction adds no owner or Service.

**Risks.** This is close-path code that is critical for cancellation. The real-process stdio tests, including the close-order regression test, run only on darwin.

**Reviewer-required changes.**

1. **Keep every agent-visible message.** `tools/projection.ts:76` and `code-mode/presentation.ts:241` forward `error.message`. Use mandatory labels per transport:
   - deadline ("MCP stdio acquisition deadline expired." vs "MCP acquisition deadline expired.");
   - unavailable and transport-failed;
   - cleanup failure ("MCP transport cleanup failed." vs "MCP stdio cleanup was not confirmed.").

   Remove message unification from the behavior changes.

2. **`boundedSdkCleanup` lives in a leaf module**, `boundary/mcp-protocol/shared/bounded-cleanup.ts`. In the driver file it would create an import cycle through select → modern/legacy adapters → subscriptions.
   - Signature: `<A>(run: (signal) => PromiseLike<A>, timeoutMs, failure, timedOut = failure)`.
   - The legacy unsubscribe keeps aborting its SDK request through the signal.
   - The modern and legacy closes keep their separate "failed" and "timed out" messages.
   - It is generic to satisfy the anti-slop `no-unknown-returns` rule.
3. **`connect` returns `exchange: (capabilities) => ...`**, a factory, because the HTTP exchange needs capabilities computed after observe.
   - `setToken` is built inside `connect`; the driver defaults it to `() => Effect.void`.
   - Use a late-bound events getter.
   - Call `setCleanup` exactly where `cleanup =` assigns today, including stdio's probe path, which overwrites the slot twice.
4. **HTTP ordering.** Run `snapshotOptions`, the bearer check, `makeNativeContext`, and the registry **before** the driver is called, so `onClosing: registry.closeAdmissions` works even when close runs before `connect`. Keep TokenState and the late-bound callback references in sdk-http.ts.
5. **Close path.** `begin` (closing = true, onClosing, interrupt opening), then one of:
   - HTTP: `andThen(cleanup).ensuring(Scope.close)`;
   - stdio: `andThen(Scope.close).ensuring(cleanup.exit.map(||=))`.

   `ensuring` must cover the whole chain. Evidence is `failed OR observationCleanupFailed`, recomputed (HTTP) or sticky (stdio).
   - Prefer one per-transport close-policy value over two independent flags, whose other two combinations are unused and untested.
   - Carry the existing rationale comments onto it.
   - `restore` is the outer `uninterruptibleMask` restore.

6. **`mapSdkClientError`** returns `undefined` for anything that is not an SDK error, and for the SdkError default case; each transport keeps its own fallback.
   - HTTP checks `ClientHttpForbidden` together with the SdkHttpError 403 branch, and `ClientHttpAuthentication` after it.
   - stdio passes the raw outcome, with reply = not-sent|completed.
7. **Limits.** Define `SdkLimitFields` with `Schema.withDecodingDefaultKey`. Export `boundedInt(min, max)` for stdio's `stderrBytes`.
8. Correct the problem statement: the differences are documented, not drift.
9. **Land steps 1–4 as separate low-risk commits first:** classifier, bounded cleanup, decode `maxBytes`, limit fields. Each is worthwhile even if the driver is later abandoned. Then port stdio and HTTP in separate commits, running the full suite on macOS.

**Migration steps.**

1. Add `mapSdkClientError` and route both transports through it.
2. Add the leaf `boundedSdkCleanup` and adopt it in the four sites.
3. Give `decodeMcpRequest` a `maxBytes` parameter, and delete `requestByteLength`.
4. Rebuild both option validators on `SdkLimitFields`.
5. Add the driver and port stdio. Run the sdk-stdio, negotiation, legacy-subscription, instructions, and sdk-connection tests, then the package tests.
6. Port HTTP. Run the sdk-http, mcp-protocol, connection/service, and optional-features tests, then the package tests.
7. Update the docs. Run `pnpm validate` on macOS.

---

### 21. E-proctree: one process-tree terminator in pi-cosmic-core

- **Ids:** core-R1 + background-task-R1 + X-process-R3
- **Packages:** pi-cosmic-core, pi-subagents, pi-background-task
- **Vetted LOC:** source −60, tests 0. This is the lowest of the three vetted figures:
  - core-R1: −150/−30 (architect −180/−90);
  - background-task-R1: −60/0 (architect −130/−30);
  - X-process-R3: −97/−25 (architect −170/−70).

  The spread comes from how much of the subagents wrapper survives and how large the core module is (150–210 lines).

- **Risk / effort:** low / M

**Problem.**

- There are two separately maintained bounded, cancellable Windows `taskkill /pid N /T [/F]` helpers:
  - pi-subagents `process-tree.ts` lines 62–154;
  - pi-background-task `local-process.ts` lines 128–212.
- Both implement the same interruption invariant: synchronous listener removal, a harmless late-error listener, and killing the helper.
- They have drifted:
  - background-task survives listener removal that throws, and settles on 'exit';
  - subagents settles on 'close', accepts a nonzero exit code once the target has exited, and keeps typed errno messages.
- `process.kill(-pid, sig)` with ESRCH/EPERM classification appears about six times: core duplex close, duplex early TERM, the bounded-runner sweep, subagents, and background-task (twice). The copies disagree about pid validation, and `kill(-0)` would signal Pi's own process group.
- CLAUDE.md requires shared platform code to live in core.

**Target design** (merged from the three proposals and nine reviews):

- Core `src/platform/process-tree.ts` exports:
  - `signalProcessGroup`: rejects any pid that is not a positive safe integer, returns `present|absent|permission|failed`, and optionally a sanitized errno;
  - `signalProcess` (single-pid liveness);
  - `ProcessTreeError`, keeping pi-subagents' codes, operation strings, and exact messages, including the sanitized `(CODE)` suffix;
  - `terminateWindowsProcessTree`: background-task's hardened body, spawned through core's `nodeSpawn` door;
  - the terminator child/spawn types.
- **No core `terminateProcessTree` dispatcher.** It would have a single consumer. core-R1's feasibility and behavior reviews accepted a core dispatcher; the justification reviewers of core-R1 and X-process-R3 rejected it, and X-process-R3's feasibility review required a single dispatch layer.
- pi-subagents keeps a slim child-based `process-tree.ts` (about 30–65 lines):
  - `!pid` skip;
  - Windows exited-target skip;
  - `targetExited` closure;
  - POSIX group signal with a leader `child.kill` fallback;
  - the Promise door, or `Effect.runFork(...pipe(Effect.ignore))`.
- background-task keeps `makeWindowsTreeTermination` and its always-sweep policy, and calls the core helpers.

**Justification.** One audited implementation of cleanup-critical, security-relevant code instead of two drifting ones. It is also the single place to add a Windows Job Object owner later.

**Behavior changes.** POSIX: none. The same syscalls are issued in the same order.

Windows-only changes in pi-subagents:

- SIGKILL instead of the default signal when the helper is interrupted; both map to TerminateProcess;
- 'exit' instead of 'close', which fire back to back with stdio ignored;
- listener removal that throws is now tolerated;
- the unref timing change (item 3).

Safety tightening: a non-positive or undefined pid can no longer reach `process.kill(-pid)`.

**Convention changes.** None to CLAUDE.md. Core `index.ts` only gains exports. Documentation updates:

- core ARCHITECTURE.md platform paragraph, and the child-process door comment in `node-builtins.ts`;
- background-task ARCHITECTURE.md line 14, and the header of `local-process.ts`;
- pi-subagents `docs/local-backends.md`;
- `docs/architecture/pi-boundaries.md` lines 132–133 (both terminator bullets) and line 143 (the process-spawning allowlist now includes core's taskkill helper).

pi-subagents' ARCHITECTURE.md has no terminator paragraph, so nothing changes there.

**Risks.** CI never exercises the Windows paths; only fakes do. Carry every fake-spawn scenario over.

**Reviewer-required changes.**

1. **Settlement rules.**
   - An 'error' event always fails (`taskkill_spawn_failed`), even when the target has exited.
   - `targetExited` success applies only to 'exit' results: a nonzero exit after the target exited counts as success.
   - Optionally skip the spawn when the target has already exited. That is the pi-subagents PID-reuse guard from 591e609. background-task omits it and always runs `/T /F`, as its ARCHITECTURE.md documents.
   - Name the code used when listener removal fails after a zero exit.
2. **Keep pi-subagents' messages exact:**
   - "Unable to start the Windows process-tree terminator." / "The Windows process-tree terminator failed to start." with the `(CODE)` suffix;
   - "exited with code N|unknown.";
   - "timed out after N ms.";
   - "Unable to signal the owned process tree."

   They reach `SubagentProcessError.message`. For POSIX `group_signal_failed`, keep the errno suffix (EPERM from "permission"), or list the loss for other errnos.

3. **Unref timing.** pi-subagents unrefs at spawn; the merged body unrefs on cleanup. Either keep an immediate unref (harmless for background-task) or list the change. It is invisible in practice, because the Effect timeout timer keeps the loop alive either way.
4. Type options as `| undefined` for `exactOptionalPropertyTypes`, so `spawnTaskkill` and `taskkillTimeoutMillis` pass straight through. The spawn seam shape is `(command, args, options) → {on, removeListener, kill, unref}`.
5. **pi-subagents.**
   - `ProcessTransportRuntime` stays child-based, so `process-transport.test.ts` passes unchanged. If `force` becomes Effect-typed, its spies use `.mockReturnValue(Effect.void)` instead of being routed through the `terminate` mock.
   - The leader fallback fires only for `group_signal_failed` while the leader is alive, and re-raises when kill returns false or throws.
6. **background-task.**
   - `dispatchGracefulTermination` becomes `if (signalProcessGroup(pid, "SIGTERM") !== "present") try { process.kill(pid, "SIGTERM") } catch {}`. The fallback must still fire on ESRCH.
   - `terminateLingeringGroup` becomes `void signalProcessGroup(pid, "SIGKILL")`.
   - Every core error maps to the redacted `LocalProcessError("terminate")`, so the redaction test holds.
   - Drop the child_process part of its builtin lookup.
7. **Core internals keep their site policies exactly:**
   - duplex close polling: EPERM is retried;
   - duplex early TERM: failures are swallowed;
   - runner sweep: `Effect.sync`, and EPERM counts as false;
   - cross-process-lock `dead`: `signalProcess(pid, 0) === "absent"`.

   The writer-lease `probeProcess` sub-step is moot once sub-infra-R1 lands. The rpc-session call site is moot once E-rpc lands.

8. **Tests.** The core suite needs a fake taskkill covering:
   - a synchronous spawn throw, with the errno in the message;
   - listener install or removal that throws;
   - zero exit;
   - nonzero exit (failure, and success when the target exited);
   - spawn skipped when the target exited;
   - an error event that fails even when the target exited;
   - timeout, with synchronous SIGKILL, unref and late-error listener;
   - interruption;
   - ESRCH → absent and EPERM → permission;
   - a live POSIX group kill after the leader exits.

   Do not duplicate the 37-line fake. Either leave background-task's direct terminator tests in place, exercising the shared body through a thin adapter, or export the fake from core `testing.ts`. Keep pi-subagents' exited-skip test, one live POSIX descendant test, and the Promise-door test (unless the door becomes `runFork`).

**Migration steps.**

1. Add the core `process-tree.ts` with tests, and export it. Run `pnpm --filter pi-cosmic-core test`.
2. Move the core internals onto `signalProcessGroup`/`signalProcess`. The duplex, process-runner and cross-process-lock tests must pass unchanged.
3. Migrate pi-background-task and update its ARCHITECTURE.md. Run `pnpm --filter pi-background-task test`.
4. After E-rpc and sub-infra-R1, slim pi-subagents' `process-tree.ts` onto the core helpers. Run `pnpm --filter pi-subagents test`.
5. Update the docs and run `pnpm validate`.

---

### 22. sub-presentation-R2: key tool inputs by tool name with one tool catalog

- **Ids:** sub-presentation-R2
- **Packages:** pi-subagents
- **Vetted LOC:** source −84, tests −6.
  - Architect estimate −120/−10.
  - Measured −84 source and −40 tests including `tool-schemas.test.ts`; the justification review estimated −90/−6.
- **Risk / effort:** low / M

**Problem.** Eleven public tools are funnelled internally through a synthetic `SubagentToolInput` union. It is tagged by `action` in three irregular shapes and then un-tagged at every boundary:

- a proxy encode switch;
- an 11-case decode switch plus helpers;
- 11 repeated execute lambdas and 11 `defineTool` shells;
- the constructions in `execute.ts` and `proxy-controller.ts`.

**Target design.**

- A declarative catalog `SUBAGENT_TOOL_SCHEMAS` in `schema.ts`: `{ parameters, validate? }` per tool.
- A tool-keyed input `{ tool, args }`. Keep the exported name `SubagentToolInput`.
- `subagentToolAction` returns literal action types.
- A byte-identical wire codec.
- Generic registration.

**Justification.** One symmetric discriminant replaces a synthetic one, and three per-tool switches go away. Proxy decoding becomes table-driven. The justification is lines plus a single discriminant; the existing round-trip test already guarantees decode completeness.

**Behavior changes.** None. Wire bytes, error texts, codes, and persisted `action` values are all unchanged.

**Convention changes.** Update the ARCHITECTURE.md tools sentence (line 47) to name the catalog.

**Risks.** Correlated-union typing, and the two TypeBox copies (see items 6 and 7).

**Reviewer-required changes.**

1. **Own-key guard for unknown tool names.** Use `Object.hasOwn` or `SUBAGENT_TOOL_NAMES.includes`. Names such as "constructor", "**proto**" and "toString" must return `proxy_request_invalid` "Nested Pi requested an unknown coordinator tool." instead of a TypeError defect in the synchronously invoked `proxyHandler`. Add inherited-key cases to the unknown-tool test.
2. **Do not merge the preview and expanded render adapters.** They differ:
   - preview panel ownership requires start/await details;
   - expanded has a compact gate, a content-only fallback and `renderSubagentExpandedContent`.

   At most, extract the ticker/panel-ownership prologue, with the start/await gate as a parameter. Keep the start-specific `expandedContent.renderCall`.

3. **Lifecycle root semantics.**
   - Handle retry first: `requiredTargetIds`, then profile capture, then authorize.
   - Apply `lifecycle_message_invalid` only on the interrupt/stop/resume path. Root retry with a message stays accepted and the message is ignored.
   - The catalog validator stays proxy-only. Reuse `lifecycleMessageError` on the root path.
   - Add proxy-decode tests for retry and interrupt with a message, and for a claims operation error. Neither nested validator is tested today.
4. **Registration and leases.**
   - Register in `SUBAGENT_TOOL_NAMES` order.
   - Leases apply only to start and await, and are evaluated synchronously before the operation, as `settlePresentation` does.
   - `prepareArguments` only on start.
   - Destructure the lease hooks out of the spec before `defineTool`.
5. **Types.**
   - `subagentToolAction` returns exact literal types (switch or lookup) so `RunDetailsAction`, `managementAcknowledgement` and `requiredField` need no casts.
   - Add `SubagentToolName` to `run/tool-policy.ts`.
   - Keep the `SubagentToolInput` name, so `host-child.ts`, `host-pi-supervisor-extension.ts` and `register.ts` need no edits.
6. **Typing workarounds.**
   - Pin `defineTool<SubagentToolParameters<N>>`.
   - Annotate the destructured spec as `SubagentToolSpec<N>`.
   - Derive lease args from `ToolDefinition` execute parameters. This works around TypeBox 1.1.38 (local) versus 1.3.27 (pi-coding-agent).
   - Use named mapped types and a generic `<ValueInput>` decode for the anti-slop rules.
   - At most three documented SAFETY casts.
7. **Ownership split.** The declarative catalog lives in `schema.ts`. TypeBox `Check`-based decoding stays in `proxy-protocol.ts`, which ARCHITECTURE.md assigns strict proxy decoding.
8. **Landing.** No temporary `requestOf`/`inputOf` adapters. Land in two changes:
   - catalog, tool-keyed input, codec, execute, proxy-controller and fixtures together;
   - then catalog-driven registration.
9. **Extra scope.**
   - Replace the hand-made `TOOL_PARAMETERS` in `tests/tool-schemas.test.ts` with the catalog (−24).
   - Delete the unused per-tool Input aliases (−6).

**Migration steps.**

1. Catalog, tool-keyed input, `subagentToolAction`, codec with own-key guard, `execute.ts`, `proxy-controller`, and test fixtures. Run `pnpm --filter pi-subagents test`.
2. Catalog-driven registration in `subagent.ts`. Run the management, start, compact-summary, presentation-conformance and compact-expansion tests.
3. Update ARCHITECTURE.md. Run `pnpm validate`.

---

### 23. background-task-R3: define the task contract once in Effect Schema

- **Ids:** background-task-R3
- **Packages:** pi-background-task
- **Vetted LOC:** source −75, tests +2. Architect estimate −100/0. With the feasibility review's extra scope, about −96/+2.
- **Risk / effort:** low / M

**Problem.** The task state, snapshot, wait result and log metadata contract is maintained by hand in three to four places:

- `model.ts` types;
- a second Schema copy in `ui/compact-summary.ts`, with a generic 8192-character bound and a hard-coded 600;
- a third copy in `code-mode/protocol.ts`;
- a fourth union in `tools/command.ts`.

The action literals are repeated three times. The persisted details of a truncated `logs` call also store Pi's full `TruncationResult`, so the truncated log text is stored a second time in `truncation.content` (up to about 50 KB).

**Target design.**

- A pure `src/task/schema.ts` with states, snapshot, log metadata and wait schemas.
- A details union and a five-field truncation schema.
- Model types derived from the schemas.
- Compact-summary decodes the shared schema.
- `command.ts` emits metadata-only logs details.
- Input and Output unions stay explicit, because they are the public v1 contract.

**Justification.** The unchecked copy is compact-summary's: it silently falls back to the original renderer when it drifts. Drift between the protocol and the model is already caught at compile time. Persisted session files shrink. This also fits ARCHITECTURE.md's rule against persisting command output automatically.

**Behavior changes.**

- New `logs` details drop `events: []` and the TruncationResult extras. Old details still decode.
- Compact-summary uses the real bounds and validates pid, endedAt, matchCursor and a minimum id length. Details persisted before 2026-08-30 with oversized fields fall back to the original renderer.
- Oversized synthetic details report `overflow: false` instead of `true`. pi-code-mode treats `incomplete || overflow` the same, so this is not observable.

**Convention changes.** ARCHITECTURE.md: `src/code-mode/protocol.ts` imports only the pure task bounds and schemas, and `task/schema.ts` owns the contract. Do not claim the `./code-mode` door stays light: `src/protocol.ts` re-exports `output.ts`, which loads the service.

**Risks.** Adding a field to a shared schema changes the guest-visible v1 output and the model-facing catalog (item 3).

**Reviewer-required changes.**

1. Keep the exact field orders from `protocol.ts`, for snapshot, log metadata and wait. Keep the `BACKGROUND_TASK_STATES` order. Field order drives guest output key order, catalog order and counter order. Sharing schema instances produces byte-identical JSON Schema, which was verified.
2. `BACKGROUND_TASK_CODE_MODE_BOUNDS` keeps every key and value explicit. Do not spread `FIELD_BOUNDS` into it, which would add public keys. `maxSignalChars`, `maxErrorChars` and `maxSnapshots` are output-contract limits: either keep them private to the schema module, or move them into `bounds.ts` and update its ARCHITECTURE.md description, which today says admission limits.
3. Document in the schema module and ARCHITECTURE.md that the shared member schemas are part of the frozen v1 Code Mode output contract. Domain-only fields are intersected locally in `model.ts`.
4. **Placement.** `BACKGROUND_TASK_STATES` and `BACKGROUND_TASK_ACTIONS` go in `task/schema.ts`. `presentation.ts` cannot take values from `protocol.ts` because the import would be circular. The behavior reviewer's alternative, a pure tools-owned `src/tools/details.ts` for the details union, actions and truncation, is equally acceptable if it has no TypeBox imports.
5. **`command.ts`.**
   - Build the truncation as an explicit five-field literal and never spread the TruncationResult. Structural typing would otherwise let `content` persist again.
   - Drop `events` by destructuring.
   - `borrowOutput` still strips `truncation` for logs, because the byte-size check runs before decoding.
   - The persisted-details slimming may land first as its own small commit.
6. Remove `BackgroundTaskWaitOutcome`, or derive it.
7. **Extra scope** (feasibility):
   - an exported `MaxChars` helper, reused for Input fields and `BoundedText`;
   - `BackgroundLogSlice extends BackgroundLogMetadata`;
   - `cursors(value: Omit<BackgroundLogMetadata, "state">)`;
   - one shared bounded `BackgroundTaskSnapshotsSchema` used by both unions.
8. **Tests.**
   - Remove `events: []` from `code-mode-output.test.ts` lines 31 and 153; they become excess-property errors.
   - Rewrite the overflow test at `code-mode-presentation.test.ts:123` so it reaches `{incomplete: true, overflow: true}` within the new bounds, for example a `list` whose failed task carries a 2048-character error, or more than 32 notices.
   - Assert that the oversized-id case gives `{incomplete: true, overflow: false}`.

**Migration steps.**

1. Add `task/schema.ts` and the bounds. `protocol.ts` imports the shared schemas and keeps its constants. Run `pnpm --filter pi-background-task test`.
2. Derive the model types. Typecheck.
3. Switch compact-summary to the shared schema, and adjust the overflow tests.
4. Metadata-only logs details, the derived details type, the simplified `borrowOutput`, and shared actions.
5. Update ARCHITECTURE.md. Run `pnpm validate`, and `pnpm --filter pi-code-mode test`, which consumes the protocol.

---

### 24. mcp-core-R2: one bounded plain-JSON walker in place of three hand-rolled budget walkers

- **Ids:** mcp-core-R2
- **Packages:** pi-mcp
- **Vetted LOC:** source −62, tests +4. Architect estimate −150/0.
  - The vetted figure excludes the code-mode step.
  - With that step, about −105 to −120 (item 2).
- **Risk / effort:** low / M

**Problem.** Four walkers bound depth, node count and serialized UTF-8 bytes of plain JSON:

- discovery `chargeMetadata`/`freezeMetadata`, paired with an extra `structuredClone`;
- results `copy`, which overcounts by one byte per container;
- config `checkConfigBounds`, which counts array indices as object keys;
- `mcpCodeModeJsonFits`.

`schema-policy.ts` `snapshotJson` is already the strictest, hardened version of the same walk.

**Target design.**

- Give `snapshotJson` a limits object and a copy flag.
- Export `snapshotBoundedJson(value, limits | maxBytes)` and `measureBoundedJson`.
- Discovery measures against its remaining budget and uses core `freezeSnapshot`. Results and config use the walker.
- This change does not depend on mcp-core-R1.

**Justification.** One exact compact-JSON accounting replaces three drifting ones. `invocation/validation.ts` already uses `snapshotBoundedJson` as generic ingress, so this follows existing practice.

**Behavior changes.**

- Discovery: none. The pinned 2,000,002-byte and 8-byte values hold, provided shared references are handled (item 1).
- Results and config: exact accounting. Results gain about one byte per container. Near-limit config entries with long arrays may now be accepted.
- Locally built results (status, discovery pages, events, receipts) now pass the plain-prototype and descriptor checks. Non-finite numbers and non-plain objects become output-limited instead of being coerced; typed code cannot produce them.
- `freezeSnapshot` still clones. It merges the clone and freeze passes: about 13 ms becomes 23 ms at 90k nodes, and normalizing a 7 MB string goes from 7.7 ms to 18.5 ms.

**Convention changes.** ARCHITECTURE.md: `validation/` owns the bounded JSON walker. Optionally move it to `validation/bounded-json.ts`, so config, discovery and results do not depend on JSON-Schema policy.

**Risks.** Low.

**Reviewer-required changes.**

1. **Shared references.** `snapshotJson`'s global `seen` set rejects any object that appears twice, not only cycles. Used as proposed, it failed three existing tests:
   - `config/options.test.ts`: two servers share one definition object;
   - `invocation/service.test.ts`: a shared `payloadSchema`;
   - `results/projection.test.ts`: shared `literals`/`schema`.

   Add an `allowShared` mode for every limits-object caller. It skips `seen`, and depth and node limits still bound cycles. Keep the strict guard for the numeric `decodeGatewayRequest` overload and for `encodeSchemaValidationRequest`. (The justification reviewer suggested deleting `seen` everywhere, which would change gateway ingress; the majority option is taken here.)

2. **The code-mode step needs a decision.**
   - Feasibility: make it **required**. It is about 55% of the saving (−67), keeps the public signature, and both packages' tests pass.
   - Behavior: optional, with fixes.
   - Justification: drop it. It is a public `pi-mcp/code-mode` export with deliberately different semantics: rejecting own `toJSON`, requiring an array prototype, a safe-integer cap and an 8 MiB cap.
   - If it is done, the walker **must** add an array-prototype check (`Array.prototype` or null). In measure mode nothing is copied, and pi-code-mode serializes the original value after the fit check, so an Array subclass with a prototype `toJSON` would slip past the byte limit (10,002 bytes against a limit of 100 in a probe). List the dropped rejection of own non-callable `toJSON` as a behavior change, and run the pi-code-mode tests.
3. Return named interfaces (`SnapshotResult`, `BoundedJsonUsage`) for the anti-slop `no-known-value-widening` rule. Use `Predicate.isNumber`, not `typeof`. Avoid `new Array(n)`.
4. `stringBytes` defaults differ: the number overload uses min(bytes, 256 KiB), the object form uses bytes. Pass explicit limits from `decodeGatewayRequest`, or document the difference.
5. Export `BoundedJsonUsage` and reuse it for discovery's `MetadataBudget`.
6. **Tests.**
   - When re-pointing the pagination "charge" test, keep one `listMetadata`-level assertion that the budget is shared across pages and families; that accumulation now happens in `listMetadata`.
   - Add measure-mode tests for DAG acceptance (and for array-prototype rejection if item 2 is taken).

**Migration steps.**

1. Walker: limits object, copy flag, `allowShared`, `measureBoundedJson`, and named usage types, plus walker tests.
2. Discovery: measure plus `freezeSnapshot`, deleting `chargeMetadata` and `freezeMetadata`. Run the discovery tests.
3. Results `normalize`. Run the results and invocation tests.
4. Config `checkConfigBounds`. Run the config tests.
5. Optional (decision): `mcpCodeModeJsonFits` with the array-prototype check. Run `pnpm --filter pi-code-mode test`.
6. Update ARCHITECTURE.md. Run `pnpm validate`.

---

### 25. code-mode-R3: one shared test harness for executions and provider fixtures

- **Ids:** code-mode-R3
- **Packages:** pi-code-mode (tests only)
- **Vetted LOC:** source 0, tests −150.
  - Architect estimate 0/−180.
  - Reviewer range −150 to −340. The feasibility reviewer measured −360 on a full migration of 19 files.
  - Support files are about 170 lines, not 90.
- **Risk / effort:** low / M

**Problem.** 17 test files hand-build a `CodeModeExecutionEnvironment` around `makeCodeModeToolExecute` (20 literals). They also repeat multi-line five-argument `execute(...)` calls, `textOf` helpers, provider registrations and shell wrappers. The environment interface has changed about 8 times, and each change touches every literal.

**Target design.** `tests/support/execute.ts` (`executeHarness`), `tests/support/providers.ts`, and an optional small view helper. Each test keeps its behavior-specific fixtures inline.

**Justification.** The package's own duplication and interface churn justify it. This does not depend on R1 or R2.

**Behavior changes.** None; tests only.

**Convention changes.** None. `docs/architecture/testing.md` already keeps session harnesses package-local.

**Risks.** Shared defaults can silently change what a test exercises. Items 2–5 cover this.

**Reviewer-required changes.**

1. **API.** `executeHarness(options)` returns `{ execute, call(params, {id, signal, onUpdate}), run(code, opts), retention, guestValue }`.
   - `call` is needed for result.read, status and intent-bearing inputs.
   - Export one `textOf` that keeps text blocks only.
   - Create a fresh event bus per harness.
   - Use `"sessionId" in options`, so an explicit `undefined` still reaches the fail-closed path.
   - The default session id matches the provider helpers' `TEST_SESSION_ID`.
2. **No default cwd.** Default to `extensionContextFixture({})` and pass `cwd` explicitly where tests use it. Execution reads `ctx.cwd`, and model-visible-recovery deliberately tests the missing-cwd path.
3. **Runner.**
   - A `runPromise` option builds the signal-forwarding `runInSession`.
   - Keep every existing `Effect.runPromiseWith(yield* Effect.context())` runner (TestClock), in 17 cases across 6 files.
   - Keep full `runInSession` overrides for status (touch counting) and retention (abort after settle).
   - Never fall back to `Effect.runPromise` where a test-context runner exists today.
4. `results` and `retainFailureDetails` stay absent unless passed.
5. **Definitions.**
   - The default is `nestedToolDefinitionsFixture({})`, so a missing tool still reports as unavailable.
   - `fakeDefinitions` stays in `tool-execution.test.ts`, which keeps a thin local adapter (about 15 lines; `available`/`noState` map to `getState`) instead of rewriting 31 call sites.
6. **Providers.**
   - `mcpProvider` and `backgroundTaskProvider(execute, {events?, sessionId?, presentationVersion?})` are typed to return `Promise<object>`, because the anti-slop rule forbids `unknown`.
   - `presentationVersion` is omitted by default, since companion-output-loss models an older companion.
   - Use them only for single valid-provider registrations. Leave `mcp-adapter.test.ts` and `background-task-adapter.test.ts` untouched.
7. **View helper.**
   - Limit it to presentation-conformance, delivery-presentation and status, with explicit mode and style.
   - Do not migrate the compact-summary shell test, `tool-renderer.test.ts`, or the expanded-code-mode raw renderer.
   - Drop the "matches production" claim.
   - Default `startUiTicker` to a no-op.
   - Use core's `plainTheme` from X-tests-R2 rather than a local export.
8. Leave the `textOf` in host-tool-update and the one in recovery-evidence local.
9. Migrate one file per commit, keeping test-count parity (420).

**Migration steps.**

1. Add the support files. Migrate `tool-execution.test.ts` through its local adapter.
2. Migrate the evidence and delivery suites.
3. Migrate the budget, timing, retention, complete-read and execution suites.
4. Migrate the three presentation suites to the view helper.
5. Run `pnpm --filter pi-code-mode test` after each step, and `pnpm validate` at the end.

---

### 26. providers-R2: a shared provider settings command shell (narrowed scope)

- **Ids:** providers-R2
- **Packages:** pi-cosmic-ui, pi-better-xai, pi-better-openai
- **Vetted LOC:** source −70, tests −20, for the justification reviewer's narrowed scope. **Counted at −45/−20**, because E-surface already credits deleting xAI's `host-ui.ts` and adding the guarded opener.
  - Architect estimate −200/−180.
  - Behavior reviewer: about −130 for the full scope.
  - Feasibility reviewer: about −80 full scope, −65 as a fallback.
- **Risk / effort:** medium / M (narrowed)

**Problem.** The two providers are the only users of core `dispatchSettingsCommand`. Each wraps it in its own outer controller with the same grammar, completions, help, diagnostics, invalid/missing/unknown messages and apply. The copies have drifted.

OpenAI has three real gaps:

- component construction inside the factory is unguarded;
- a synchronous throw or rejection from `ctx.ui.custom` is not contained;
- runtime apply rejections are silently swallowed.

Its render, dim and keybinding callbacks are already guarded by `settingsSurfaceBridge({ invoke: invokeHostCallback })`. The proposal overstated this gap.

**Target design (narrowed).**

- A shared descriptor command shell in pi-cosmic-ui with:
  - completions;
  - help and examples;
  - diagnostics with try/catch;
  - invalid/missing/unknown messages;
  - scripted apply with `id = value` feedback;
  - signal capture;
  - an optional `onInvoke(ctx)` hook for OpenAI's `updateContext`.
- Pickers stay local:
  - xAI's flat picker stays in xAI unless a second consumer adopts it;
  - OpenAI's grouped picker stays in OpenAI, including group summaries, the diagnostics panels, reconcile, and the redacted-config refresh after each write.
- Both pickers open through E-surface's guarded opener and use the shared apply.

**Justification.** One owner for the command grammar and copy, plus the fix for OpenAI's three real gaps. The grouped mode was dropped because it served one consumer, needed several extra hooks, and saved nothing.

**Behavior changes (decide per item).**

- OpenAI runtime apply rejections now warn.
- A throwing factory or a failing `custom` call is contained.
- Wording of the missing-value message aligns.
- Whether bare `/openai-settings` without a TUI shows help, or today's warning, must be chosen explicitly.
- Whether the picker keeps its per-change `id = value` notice must be chosen explicitly.
- The surface check changes from `hasTerminalUI` to `mode === "tui"`, so hosts that report no mode but have a UI get help.
- Diagnostics become a warning where OpenAI is silent today.
- Signal handling: today OpenAI applies with an undefined signal when the getter throws, and suppresses warnings when aborted. Either keep that or list the change.

**Convention changes.**

- Core `settings-dispatch.ts` doc comment ("Hosts own … wording error messages").
- The pi-cosmic-ui ARCHITECTURE.md settings paragraph ("Host guards remain injected and caller-owned").
- Both providers' ARCHITECTURE.md settings bullets.

**Risks.** Behavior risk is medium on the full scope because of redacted-config staleness, missing `updateContext` and chrome differences. The narrowed scope avoids most of that.

**Reviewer-required changes.**

1. Drop grouped mode and `extraGroups` from the shared helper. Keep OpenAI's grouped picker and xAI's flat picker local.
2. Add an `onInvoke` hook, or equivalent, that runs on every `/…-settings` branch and before each apply. This keeps OpenAI's `updateContext`.
3. Keep `requiredConfig` for startup and `formatDebugStatus`. Pass the helper a non-throwing accessor, `(ctx) => MutableRef.get(projection).config`. The helper must guard a throwing `diagnostics` callback.
4. Rewrite the justification as above.
5. **Tests.**
   - Keep xAI's hostile-surface tests in `extension.test.ts`, run through the real registered command.
   - Keep xAI's rollback tests local.
   - Keep OpenAI's reconcile, rollback-after-close and redacted-panel tests local.
   - Add an OpenAI test for a throwing factory and a rejecting `custom`.
   - Move only the help/diagnostics/validation command test into cosmic-ui.
   - Do not add an xAI registration smoke test.
6. If a grouped mode is ever revisited, it needs:
   - `summary(ctx, cfg)`;
   - a `prepare` step plus a synchronous builder that receives the theme;
   - a post-apply refresh of the redacted config;
   - per-mode chrome.

**Migration steps.**

1. (After E-surface) add the shared command shell to pi-cosmic-ui with a small command test. Run `pnpm --filter pi-cosmic-ui test`.
2. Switch xAI's command to the shell. Its picker opens through E-surface. Run `pnpm --filter pi-better-xai test`.
3. Switch OpenAI's command to the shell. Its picker opens through the guarded opener with the shared apply. Add the new failure tests. Run `pnpm --filter pi-better-openai test`.
4. Update the docs. Run `pnpm validate`.

---

### 27. X-tests-R2: shared Pi host test fixtures in `pi-cosmic-core/testing` (narrowed scope)

- **Ids:** X-tests-R2
- **Packages:** pi-cosmic-core; consumers across about 11 packages
- **Vetted LOC:** source +210, tests −380. The +210 source is the feasibility estimate for the full kit; the −380 tests is the justification estimate for the narrowed scope.
  - **Recommended narrowed scope: about +40 source, −380 tests.**
  - Architect estimate +190/−800.
  - Behavior estimate for the full scope: about +200/−500.
- **Risk / effort:** low / M

**Problem.** Test fixtures are rebuilt by hand in each package:

- near-identical SAFETY-cast fixture modules in cosmic-ui, better-xai, code-mode and subagents, plus inline variants;
- about 60 multi-line identity Theme fixtures;
- about 15 deferred/promise-gate copies.

(The fake ExtensionAPI hosts, custom-surface drivers and process probes were also proposed, but reviewers dropped or relocated them; see below.)

**Target design (narrowed).** About 40 lines in `pi-cosmic-core/src/testing/host.ts`, exported from `testing.ts`:

- a frozen `plainTheme` behind one SAFETY cast;
- `extensionApiFixture`;
- `extensionContextFixture` (`ExtensionContext & ExtensionCommandContext`), keeping the concrete member types;
- `opaqueFixture`, returning `never`;
- `deferredPromise<A>()` with resolve and reject.

Only type imports from pi-coding-agent. No runtime `createEventBus` and no pi-tui dependency.

**Justification.** Each helper already has five or more consumers, which meets `testing.md`'s own bar for moving a helper into core.

**Behavior changes.** None to production. Deferred settlement changes microtask timing, so migrate one file at a time.

**Convention changes.**

- Do **not** rewrite `testing.md`'s rule that "Session/Pi harnesses … remain package-local".
- Add the new helpers to the published-helper list in `testing.md`, the core README testing paragraph, and ARCHITECTURE.md's public surface.

**Risks.** Low at the narrowed scope.

**Reviewer-required changes.**

1. **Drop `makeFakePiHost` and `makeCustomSurfaceUi` from this batch.** The justification reviewer: package harnesses differ materially, and the "append vs overwrite handlers" inconsistency is not observable. No production module registers the same event twice within one harness. If ever revisited (behavior and feasibility conditions), it needs:
   - `emit` that returns handler results and propagates the first rejection;
   - a synchronous `handler(name)` accessor, needed by about 140 direct call sites and several sync `.not.toThrow()` assertions;
   - `extra` that can reference the host;
   - spies that tap capture instead of replacing it;
   - no auto-activation of tools;
   - a registration log;
   - surface-driver options (`disposeOnClose`, terminal size, `matches`/`getKeys`, `rejectAsyncFactory`);
   - migrating only the settings/manager fakes that fit.
2. **Process probes move to `pi-subagents/tests/support/process.ts`, not core.**
   - Keep the 200 × 10 ms bounds and the throw on a non-positive pid.
   - Leave process-tree's ESRCH-only probe, background-task's boolean probe and better-openai's FileSystem poller local.
   - Only a few sites remain once E-sup and E-rpc rewrite or delete the bridge and rpc-session tests.
3. Drop `scopedAgentDirectory`: `vi.stubEnv` restores in `afterEach`, and code-previews deliberately sets `~` paths. Also drop the `vi.waitFor` → `yieldUntil` swap, because those waits depend on real exec and filesystem I/O.
4. **Keep local:**
   - subagents' `extensionApiFixture` wrapper (it defaults `registerMessageRenderer`);
   - cosmic-ui's footerData, eventBus and abortSignal fixtures (`support/host.ts` shrinks rather than disappearing);
   - code-mode's `codeModeStateFixture` and subagents' `modelFixture`;
   - ask-user's `makeTuiHost`;
   - intentionally partial or hostile themes such as `brokenTheme`.

   Replace only multi-line identity themes; one-line themes save nothing.

5. No self-tests for casts or the theme; TypeScript already enforces them.
6. Remove the append-vs-overwrite argument from the justification.

**Migration steps.**

1. Add `host.ts` to core testing and export it. Run `pnpm --filter pi-cosmic-core test`.
2. Replace the fixture casts, then the multi-line identity themes, then the deferreds, one package per commit. Run each package's test command.
3. Move the pi-subagents process probes into its support module.
4. Update `testing.md`, the core README and ARCHITECTURE.md. Run `pnpm validate`.

---

### 28. X-tests-R1: thin presentation test helpers in `pi-code-previews/testing` (narrowed scope)

- **Ids:** X-tests-R1
- **Packages:** pi-code-previews; consumers pi-background-task, pi-ask-user, pi-better-openai, pi-mcp, pi-code-mode, pi-subagents
- **Vetted LOC:** source +330, tests −420. The +330 source is the feasibility estimate for the full kit; the −420 tests is the justification estimate for the narrowed scope.
  - **Recommended narrowed scope: about +80 source, −420 tests.**
  - Architect estimate +180/−900.
- **Risk / effort:** low / L

**Problem.** The tool-presentation contract is re-implemented by hand in each consumer:

- 133 `setCodePreviewSettings` calls in 36 files;
- 73 hand-written expansion loops;
- about 24 hand-built `ToolRenderContext` literals;
- one scheduler-ownership test copied three times, with a 34-line exact clone;
- 25 imports into `pi-code-previews/src/**` internals, plus pi-code-mode importing `pi-code-previews/tests/support/render.ts`.

**Target design (narrowed).** Thin, Vitest-free helpers in `pi-code-previews/testing`:

- `applyPresentationSettings(overrides) => restore`, plus a sync wrapper;
- `renderContextFixture`;
- the harness defaulting to core's `plainTheme`;
- optionally `captureRegistrations` and a configurable `cycle()`;
- a helper that replaces the three copied scheduler tests.

Consumer tests stop importing `pi-code-previews/src/**`.

**Justification.** Consumers then depend only on the public testing export. Duplicated scaffolding goes away while each package keeps its own presentation assertions.

**Behavior changes.** None to production. The published testing subpath gains additive exports.

**Convention changes.** `tool-presentation.md` "Retention and validation" lists the helpers and states that consumer tests use `pi-code-previews/testing`, not `src/**`. It should not describe a conformance DSL.

**Risks.** A generic helper can quietly weaken package-specific checks. Items 1, 7 and 8 guard against that.

**Reviewer-required changes.**

1. **Drop `presentationViolations`, `issueAttentionViolations` and the `PRESENTATION_SHELLS` matrix runner** (justification). Feasibility also allowed them only as optional follow-ups where a migrated file shows net savings. Reasons:
   - Each conformance file has at most one generic matrix test.
   - A summary-derived exactly-once check is wrong for legacy notice producers, for identical descriptions attributed to different tasks, for remote errors echoed in raw JSON, and for preview style.
   - A shells × widths matrix would impose new assertions and could force production changes.
2. **Settings.**
   - Settings must stay active through **rendering**, not only registration. `toolCallTiming` and the preview content flags are read at render time.
   - Support Effect and generator tests.
   - Base overrides on a snapshot of the current settings.
   - Do not force `toolCallTiming: false` on suites that run with the default `true`.
   - Apply the helper only to shell-presentation files.
3. **`cycle()`.**
   - Invalidation is opt-in (`'before' | 'after' | false`).
   - States and per-state overrides are configurable.
   - Do not use it in tests that assert exact scheduler or ticker counts unless those counts are re-verified.
   - Leave atypical loops, such as builtin's `[true, false, true]`, hand-written.
4. **Scheduler test helper.** Take per-tool args and a filter, and report the actual stop count, because subagents asserts exactly-once. Do not touch code-mode's `startUiTicker` tests, which use a different contract. Alternatively, replace the three copies with the existing harness.
5. **Leave these alone:**
   - `compact-lifecycle.test.ts`'s mini-harness: pending defaults, no forced `executionStarted`/`isPartial`, `update()`, 143 call sites;
   - `compact-fallback`'s `paint()`, which deliberately threads no `lastComponent`.

   Only swap their context literals for `renderContextFixture` with pending defaults.

6. Replace the `createCompactToolShell`/`renderCompactToolCall` deep imports by rendering through `withCodePreviewShell` plus the harness. Do not use `renderCompactRow`, which drops issue descriptions. Otherwise, leave them and say so. Remove pi-code-mode's `tests/support` import.
7. **Keep producer-policy assertions in copy-independent form:**
   - background-task: per-task-id attribution, and the exit-code and log-loss issue codes;
   - ask-user: aggregated collapsed attention.
8. Immutability uses a structural snapshot, not JSON. Skip it where a test asserts that accessors are never read.
9. Keep one `plainTheme`, in core (X-tests-R2). Build `captureRegistrations` on X-tests-R2's fixtures rather than adding a third ExtensionAPI fake, and only if three or more packages use it.

**Migration steps.**

1. Add the thin helpers to `pi-code-previews/src/testing` and export them from `testing.ts`. Add a small self-test that settings are restored after a throw. Run `pnpm --filter pi-code-previews test`.
2. Migrate consumers one package per commit (background-task, ask-user, better-openai, mcp, code-mode, subagents), removing deep imports and settings boilerplate. Run each package's tests.
3. Grep to confirm no test outside pi-code-previews imports `pi-code-previews/src`. Update `tool-presentation.md`. Run `pnpm validate` and `pnpm pack:dry`.

---

## Needs a decision

### Disputed proposals

In each of these, exactly one non-behavior reviewer rejected the proposal, and in all three it was the feasibility reviewer. None of them is counted in the totals.

#### sub-run-R2: move the duplicated RunRecord transitions into `run/transitions.ts` and derive the redundant flags

- **Packages:** pi-subagents. **Vetted:** −45 source / −2 tests. **Architect estimate:** −90 / −2.

**The case for it.** The behavior and justification reviewers accepted it with changes.

- The duplication is real:
  - seven warning sites repeat `setRunWarning`, `projectRunWarning` and `appendNoticeSessionEvent`;
  - five sites pair `completeRunInitialization` with taking the pending settlement;
  - `settle` and `commitRetainedReportLocked` share a finish-assignment block.
- Three flags are redundant:
  - `initializationPending` is equivalent to `initializationSettled !== undefined`;
  - `record.retryExhausted` is only written together with `view.retryExhausted`;
  - `pauseRequested` is almost always written together with `pauseOutcome`.
- A prototype passed all 266 run tests. A scratch implementation measured −53 and −44 source lines.

**The case against.** The feasibility reviewer rejected it.

- The formatted `transitions.ts` is 161 lines, and the net saving is only −44.
- The generalized helpers add about 28 lines on their own: `beginAssignmentLocked`, `commitPauseLocked`, `recordOutcomeLocked`, `commitInitializationLocked`, `clearTurnStateLocked`, and `newAssignmentState`.
- A variant with **no** transitions module saved more, −72 source (tsc clean and all 1273 tests passing). It contains only:
  - one `withRunWarningLocked` helper, applied at all seven sites;
  - dropping the three flags;
  - `completeRunInitialization` clearing and returning the pending settlement;
  - a local `settleCompletedText` helper in `settlement.ts`.

**Semantic changes either way.**

- Interrupt's final commit clears `pauseOutcome` unconditionally. Today it has an identity guard, which only matters in a multi-interrupt race that is unreachable in practice.
- `pauseFromEvent` may resolve its waiter before `publish` instead of after. This can be avoided by returning the waiter and resolving it after `publish`.
- The `pauseRequested` flag is not quite an invariant today (control.ts:504–505).

**Recommendation.** Send the four salvage pieces (−72) to the small-cleanup review. Adopt `transitions.ts` only if maintainers value named transitions above line count. If it is adopted:

- keep `recordOutcomeLocked` private to `settlement.ts`;
- drop `commitInitializationLocked`;
- make `beginAssignmentLocked`'s base patch contain only the fields both paths clear today;
- never resolve a Deferred the interrupt does not own;
- update `docs/local-backends.md`, which names `pauseRequested`.

#### mcp-ui-R1: read the MCP reply envelope once, and build the boundary-failure view once

- **Packages:** pi-mcp. **Vetted:** −50 source / +8 tests. **Architect estimate:** −80 / 0.

**The case for it.** The behavior and justification reviewers accepted it with changes.

- Four decoders read the same gateway reply. The validation identity is computed three times, and the failure schema is duplicated.
- A fake 13-field card builds a second boundary view, which `compact-summary` then has to check against the real one.
- A jiti probe confirmed three real divergences between the nested and card views:
  - `data.origin: null`;
  - a notice made only of terminal controls;
  - notices over 2048 characters.
- A sweep of 69,696 well-formed replies showed zero disagreements, so for real gateway output the refactor preserves behavior.
- The draft measured about −78 lines.

**The case against.** The feasibility reviewer rejected it.

- The structural change alone measures −52. The "read once" envelope reader is roughly line-neutral, because the envelope file grows by about as much as its consumers shrink.
- The proposer's drafts do not implement rules (a) and (b):
  - (a) the gate still checks `origin` for truthiness;
  - (b) notices that sanitize to empty are still kept.
- Step 1, as written, cannot land alone.
- Step 7, moving files into `src/presentation/`, is churn with no line gain.

**Recommendation.** If it is taken up, treat it as a correctness change limited to the boundary consolidation (steps 2 and 3), with these conditions:

- `projectMcpEvidence` exposes the boundary only when BoundedIssues decoding succeeds.
- Implement rule (a) as `origin !== undefined`, which declines the view.
- Implement rule (b): drop sanitized-empty notices.
- Measure the 2048-character limit on the _sanitized_ notices, joined with newlines.
- Decide deliberately when to read `data.reason`. Reading it early adds an "evidence incomplete" notice to Code Mode's `McpPresentation.notices`.
- Keep suppressing the navigation hint when `details.boundary` is set.
- Keep `noticesComplete`, which `compact-summary.test.ts:350` and `:373` assert.
- Add regression tests pinning the unified edge rules.
- Drop step 7.
- Run the pi-code-mode MCP suites at each step.

#### background-task-R2: share one pi-cosmic-core module for the session-scoped Code Mode capability handshake

- **Packages:** pi-background-task, pi-mcp, pi-code-mode, pi-cosmic-core. **Vetted:** −30 source / +25 tests. **Architect estimate:** −125 / −50.

**The case for it.** The behavior and justification reviewers accepted a narrowed version.

- The handshake for hostile callbacks is copied: two provider normalizers, three `containThenable` copies, two consumer discovery loops, and two host listeners.
- The copies have drifted in two ways: the disposed guard, and the order of the candidate cap relative to normalization.
- `then` is read twice in pi-code-mode `host-tool-update.ts` and in core `notifyAtHostBoundary`. A shared read-once `callBestEffort` would harden five call sites.

**The case against.** The feasibility reviewer rejected it.

- The formatted core module is 218 lines, so the net source change is about −20 to +5.
- The generic host breaks even.
- The shared discovery helper loses about 14 lines.
- Tests grow.

**Recommendation.** Do not take it as a structural refactor. The piece worth landing is a small hardening change:

- A read-once `containThenable`/`callBestEffort` next to `invokeHostCallback` in core `host-session.ts`, adopted at the five sites. The pi-code-mode site changes the microtask timing of a hostile thenable, so adopt it only if the tests still pass.
- A precompiled `makeSessionHandshake({ version, maxSessionIdChars })` codec.
- Keep each package's host and gate order local.
- If discovery is shared, use background-task's cap-before-normalize order, and return Unavailable when emit throws.
- Keep the session-id bounds per package: background-task's helper stays unbounded because it also gates activity registration; its codec uses 256; MCP uses 1024.

### Open decisions inside accepted entries

| Entry              | Decision                                                                                  | Options                                                                                                                                                                                | Recommendation                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| sub-infra-R1       | Location of the lock root                                                                 | (a) Per-agent-directory root `writer-leases-v3`, amending core's "test-only" `directory` doc. (b) Core default per-OS-user root, which also excludes writers across agent directories. | (a), because it preserves behavior                                                                         |
| sub-infra-R1       | Upgrade path                                                                              | Old sessions cannot see v3 locks, so exclusion only works one way while versions are mixed                                                                                             | Ship a release note to restart all Pi sessions, and a guard message that names the v2 path                 |
| E-footer (ui-R2)   | Remove the published `pi-cosmic-ui/protocol` surface types and the `"media"` region       | Maintainer sign-off and a release note                                                                                                                                                 | Sign off, and keep protocol version 2                                                                      |
| E-footer (ui-R1)   | 128-entry bound                                                                           | Mandatory cap (behavior reviewer) vs. no cap (feasibility reviewer) vs. bounding only the trampoline (justification reviewer)                                                          | Bound the trampoline to 128 reentrant ops per drain, and cap distinct keys only while no session is active |
| E-footer, ui-R3    | Exception in effect-v4.md                                                                 | One narrow sentence naming the footer registry and the working row                                                                                                                     | Accept; write it once                                                                                      |
| core-R2            | Removing public core exports goes against CLAUDE.md's stable-export rule                  | Waiver, synchronized minor bump, and release note                                                                                                                                      | Waive. Run `pnpm version:check`. Do not publish                                                            |
| code-mode-R1       | Retire v1 receipts and ledgers                                                            | Approve: records from 09-16 to 09-18 turn "uncertain". Decline: about −20 fewer lines                                                                                                  | Decide explicitly. The other steps land either way                                                         |
| previews-render-R1 | Accept the lost within-token precision                                                    | Sign-off                                                                                                                                                                               | Accept. In most of the real changed cases the old output was worse                                         |
| sub-settings-R3    | Where the More menu is hosted                                                             | Inside the picker vs. the dashboard dialog slot                                                                                                                                        | Inside the picker                                                                                          |
| sub-settings-R4    | Key for toggling the destination; visual change from framed form to plain dialog          | ↑/↓ vs. Tab                                                                                                                                                                            | ↑/↓, plus UX sign-off                                                                                      |
| E-surface          | `/code-preview-health`                                                                    | Keep its geometry through the passthrough placement, or leave it out of scope                                                                                                          | Keep its geometry                                                                                          |
| E-surface          | Factory failure on the formerly unguarded screens                                         | Rethrow (as today) vs. a new notice                                                                                                                                                    | Rethrow unless a notice is wanted                                                                          |
| E-surface          | Scope of `/cosmic-ui` settings, OpenAI inline settings, and code-previews inline settings | Include or exclude                                                                                                                                                                     | Exclude                                                                                                    |
| E-sup              | New failure mode: a delegated-Pi event-loop stall of 5 s or more ends the channel         | Accept and document, or add a reconnect/reopen path                                                                                                                                    | Accept and document; add a measurement test                                                                |
| E-sup              | Agent-visible text on a rejected call (empty today)                                       | Fixed human-facing message vs. bounded `SupervisorRpcFailure` message                                                                                                                  | Pick one and document it                                                                                   |
| E-rpc              | Optional port of the model catalog (about −85)                                            | It reverses cb55216                                                                                                                                                                    | A separate change that needs its own sign-off                                                              |
| mcp-core-R2        | Include the `mcpCodeModeJsonFits` step (about −67)                                        | Required (feasibility reviewer), optional (behavior reviewer), or dropped (justification reviewer)                                                                                     | Keep it as a follow-up, with the array-prototype check required                                            |
| mcp-core-R3        | `makeMcpServiceLayer` split                                                               | Keep, returning `{layer, internals}`, vs. drop                                                                                                                                         | Drop unless the manager and optional-features tests need it                                                |
| E-proctree         | Helper unref timing, and the default for skipping the pre-spawn exited-target check       | Preserve current pi-subagents behavior vs. merge                                                                                                                                       | Keep the target skip in pi-subagents; either unref timing is fine if listed                                |
| providers-R1       | Result when the 401 re-resolve fails                                                      | Today's "(HTTP 401)" usage error vs. a typed lookup failure                                                                                                                            | Today's error                                                                                              |
| providers-R1       | Delete core `readSchemaDocument` and JsonHttpClient `formBody` (dead after this change)   | Separate follow-up                                                                                                                                                                     | Needs an export-stability waiver                                                                           |
| providers-R2       | Bare `/openai-settings` with no TUI; notice on each change inside the picker              | Choose explicitly                                                                                                                                                                      | Decide in the PR                                                                                           |
| ask-user-R1        | Registry error messages                                                                   | Exact per kind vs. templated (consumers remap them)                                                                                                                                    | State the choice                                                                                           |
| X-tests-R1/R2      | Whether the conformance runner and the full fake Pi host come back later                  | Not in this pass                                                                                                                                                                       | No, unless a migrated file shows a net saving                                                              |

---

## Rejected

### Rejected by reviewers

- **sub-exec-R3** (one interrupt-ownership state machine and one handle skeleton for local Claude and Codex): the realistic saving is about −45 source (−107 at best). No driver-level interrupt test exists: the suite was deleted in bca611c, and the fixture scenarios it used are orphaned. Doing this safely needs 80–250 lines of new tests first. It also reverses d3f7fc4's documented boundary. Salvage for small cleanups: move `makeL…BackendDriver` into `local-cli-startup.ts` (about −10), and optionally give the pure classifier an `evidenceComplete` input.
- **sub-presentation-R1** (render the fallback activity panel with Cosmic UI's widget renderer): this is a major visible regression for users who install pi-subagents without pi-cosmic-ui, for whom the panel is the only live hierarchy. Rows would lose tool, progress, await counter, route and duplicate-name disambiguation. It also regresses terminal safety: a raw `profile`, and newlines and OSC payloads passing through `sanitizeDiagnosticContent`. Footer suppression would also stop matching what the widget shows.

### Ideas the architects rejected (listed so they are not re-proposed)

Some of these were later re-proposed in another area and accepted; those are marked "superseded".

**sub-exec**

- Route local Pi contact over SupervisorChannel instead of Node IPC: the channel has no turn-input barrier or peer_notice. It would add a TCP listener per run and rewrite the Pi 0.84 interrupt-ordering proof.
- Merge `host-child.ts` with `host-pi-supervisor-extension.ts`: saves about −60 to −80, and the two differ on purpose in scrub timing, reload, cleanup, tool surface and report fallback.
- Replace process-transport, rpc-session and process-tree with core `openDuplexProcess`: that is macOS-only, has no IPC fd and no Windows taskkill, and lacks end-to-end raw-byte ownership.
- Replace process-transport with Effect ChildProcess: rc.112 has no `'ipc'` stdio, and its kill semantics differ.
- Replace the MCP helper with the SDK server: it pulls in Zod transitively, and lacks bounded parsing and the exactly-one-response guarantee under cancellation.
- Replace `supervisor-rpc-protocol.ts` with Effect's socket server protocol: the custom protocol carries security bounds (loopback check, connection cap, auth deadline, pre-auth gating).
- Expose the supervisor to Claude and Codex as MCP over HTTP: this loses helper-side epoch adoption (a causal barrier), and changes how tokens are distributed.
- Delete the Claude replay debug ledger and the diagnostic classifiers: the ledger is a documented README feature, so this is a product decision.
- Share native preflight, harness directories and environment allowlists: saves about −100, but error codes and allowlists deliberately differ. Belongs to the small-cleanup review.
- Unify the Herdr driver with the local drivers: their evidence models are fundamentally different.
- RpcMiddleware auth for channel handlers; Schema snake/camel transforms in herdr-cli: local cleanups below the bar.
- One supervisor channel server per session: saves resources, not code, and weakens per-run isolation.

**sub-run**

- One tagged cleanup union: the fields are not equivalent, and fail-closed ownership depends on them. Saves under 40 lines.
- Derive `writeAdmissionPaused`/`writeViolationOffender` from the pool: terminal former members keep the flag, so parent-action results would change.
- Merge the completion and question outbox workers: their timing differs on purpose and is pinned by tests. Saves about 40 lines.
- Drop test-only service members: about 30 source lines against more than 250 test call sites.
- Merge `assignment.ts` into `settlement.ts`: the replay union is a required handoff, and the merged file would exceed the size guidance.
- Replace the `closeRecordScope` latch with `Effect.cached`: that cannot express a relinquished claim.
- Unify launch initialization with resume respawn: their compensation paths differ.
- Evict history at settlement: this changes which runs stay visible and when state is reclaimed.
- Merge the profile override and reload handoffs: their lifetimes differ. Saves about 50 lines.
- One `run(effect)` capability for the FleetManagerActions adapters: moves code into settings/ui. A table-driven version is a local cleanup of about 12 lines.
- Freeze `record.view` on write to drop `snapshotView`: touches about 50 write sites and adds deep-freeze cost.
- Effect primitives for the turn-input drain, `waitForRevision` and the questionnaire registry: the pinned APIs do not keep the current interruption semantics with less code.

**sub-settings**

- Rebuild the editor on SettingsList: it would drop the two-pane editor UX.
- ListDetailShell for workspace panes: the detail pane needs selectable rows, and there is no net saving.
- Merge the workspace inheritance chain: only moves code, and the current split follows the size guidance.
- Route editor pickers through the dashboard dialog slot: saves about 75 lines, but about 40 tests would move behind a dialog harness.
- Make the dashboard the single owner of inspection, writes and blocked state: about 45 lines, and it touches serialized-save semantics.
- Unify the four hostile-input readers: their rules differ on purpose, and they are security-sensitive.
- Hoist `upgradeDocument` into `patchDocument`: about 25 lines, and error precedence differs.
- Drop legacy v4/v5 decoding: that compatibility is documented.
- Replace exact raw restore with patch writes: breaks the documented preservation of the original declaration.
- Merge static planning with launch-time host resolution: they produce different error codes and are security-sensitive.
- `native-model-catalog.ts` and `claude-model-preference.ts`: each is cohesive, and nothing parallel exists.
- Fold `ProfileWorkspaceRenderState` into the component: violates the pure-`ui/` rule, for about 50 lines.
- Shared wide/stacked/narrow list-detail helper: belongs to the cosmic-ui review, and the gain is small.
- Remove the test-only position API: about 60 source lines against about 80 test call sites.
- Fold the `runProfileSetAction` host seam into the dashboard: the seam is the test boundary. Saves about 40 lines.
- Target-label helpers, `runtimeLabel` copies and similar: small-cleanup review.

**sub-presentation**

- Build preview-mode results from summary plus content callbacks: preview is the default style, so the change is visible.
- Unify recovery prose across three owners: the owners and their inputs differ. Separately, the small-cleanup review should look at how preview claim-containment text is derived from bounded cards.
- Delete the legacy above-editor panel: removes a feature for users without Cosmic UI.
- Generate the card privacy projection generically: this would obscure an explicit privacy allowlist.
- Remove the producer self-decode and preflight: they are security hardening.
- Embed start failures in the entries: changes the persisted v2 shape.
- Drop the "compact" density tier: changes fitting outcomes. The tuple table is a local cleanup.
- Merge the result renderers, or use named composers: about 60–90 lines, mostly moved.
- One memoized details decoder: about 30 lines of efficiency gain.
- Fold `/subagents` into `/activity`: the fleet owns messaging, prompts, details and the proxy manager.
- Shared list-detail manager scaffold: cross-package, about 60–80 lines here.
- Unify fleet and provider action availability: the policies differ.
- Unify the run-row renderers: visible layout changes.
- Replace the await/start ticker with the shell scheduler: about 10–20 lines, and it changes ownership semantics.
- Host-notifier and report phrasing dedupe: small cleanups.

**sub-infra**

- RcMap for the writer-pool lifecycle: quarantined pools must outlive shutdown, and the concurrency risk is high.
- Core refresh-coordinator for preparation: the coordinator merges and re-runs, while preparation is one-shot and sticky.
- Drop the publication helper process: Node has no `openat`/`renameat`/`linkat`, and the child's cwd is the only directory-fd anchor.
- Batch publications into one helper call: loses the per-file durable journal progress.
- Publish with `git apply`: overwrites in place without the current protections.
- Put the workspace store lock on CrossProcessLock: line-neutral, and it turns fail-fast into a 15 s wait with auto-reclaim.
- Fork by fetching the baseline commit: about 80 lines, but it relaxes `protocol.allow=never` and removes provenance invariants.
- Batch the git hash-object spawns: a performance change, not a line reduction.
- Collapse the workspace service wrapper, `recoverDiscard` and friends: about 80 lines of local cleanups.
- Merge grant and revoke: about 40 lines, local.
- Merge the tiny boundary doors: under 50 lines, and each is a deliberate single-purpose door.
- Rewrite the publication helper as plain synchronous code: about 25 lines, and it diverges from the Schema-at-boundaries rule.

**mcp-boundary**

- SDK `auth()`/OAuthClientProvider: loses DNS pinning, the fallback rules, binding checks and scope approval.
- SDK `extractWWWAuthenticateParams`: too lenient, which weakens the unambiguous-challenge rule.
- SDK StdioClientTransport: cannot confirm that the process group and pipes are cleaned up.
- SDK `onprogress`: drops a progress event that arrives just before its response (verified in SDK 2.0.0).
- Drop the operation header tag: sends triggered by AbortSignal lose their async context, so correlation becomes best-effort.
- Remove legacy protocol support: legacy is common in the real world, the era split is small, and oxlint enforces it.
- In-band stdio negotiation: breaks servers that exit on an unknown method before initialize.
- Rebuild HTTP fetch leases on Effect HttpClient: the SDK needs web Response bodies, so nothing simplifies.
- Merge HTTP control traffic into the operation registry: their cleanup rules differ. About 30 lines.
- Merge the nested per-identity permits: about 20–30 lines, tied to the lock's admission semantics.
- Share the JSON-Schema keyword policy through a `.mjs` file: _superseded_, accepted as mcp-core-R1.
- A shared guarded Pi overlay helper: _superseded_, accepted as E-surface.
- Fold `auth/flow.ts` progress into McpActivity: the panel needs state that the journal does not carry.
- Table-driven `executeSdkRequest`, the Transport forwarding helper and similar: small-cleanup review.

**mcp-core**

- Merge connection registry, service and operation: only moves code, and puts concurrency at risk.
- Replace McpAdmission with a Semaphore or Queue: those lack per-server FIFO, the caps, revocation and the counters.
- Replace `operation.shared` and the discovery follow-up with the refresh coordinator: the semantics differ. About 20 lines.
- Turn ConnectionOwner's flags into one enum: each flag is a distinct fact, and the risk is high.
- Unify gateway `page()` with `queryCached()`: only about 30–40 lines are shared, and the contracts differ.
- Replace the browser cached API with gateway `query()`: one is local-only and one connects.
- Table-driven `diagnostics.ts`: about 45 lines, and cases depend on flags.
- Generate the TypeBox parameters from the Effect schema: changes the schema the model sees.
- Dispatch helpers and derived action sets: about 90–100 lines of boilerplate. Local cleanup.
- Adopt `makeScopedConfigStore` in pi-mcp: it needs three sources with a per-field merge, which the store does not do.
- Remove per-server results revocation: dead code, but it is a local cleanup (about 15 source and 40 test lines).
- Fold header scanning into the policy walk: would change which tools get excluded.
- Delete the parent schema policy entirely: rejected schemas would then spawn a process and error kinds would change. mcp-core-R1 keeps them rejected before admission.
- Mutable maps instead of SynchronizedRef: weakens the snapshot and evidence identity checks.
- Drop the revocations Ref: it also guards captured projections.
- Keep normalized JSON next to the serialized form: doubles retained memory.
- Share the provider activity journal or deactivation tracking: the semantics differ per package.

**mcp-ui**

- A shared session-capability primitive in core: about 40 lines across 5 packages, with differing policies. It was re-proposed as background-task-R2, which is disputed.
- Derive notices from issues: wording and conditions change, and notices are persisted in receipts. (Later implemented by the compact-presentation redesign.)
- Table-driven fusion of the 9 shared facts: the display orders differ.
- ListDetailScreen base class: about 40 lines per screen, and the quirks differ.
- Split out the retained-result screen: net zero or more lines.
- Replace the legacy card with generic compact rendering: preview is the default and requires the original renderers.
- Delete the historical JSON-text details fallback: old transcripts would lose their certainty display.
- Merge the TUI `/mcp` actions with the overlay loop: about 30–40 lines, and the non-TUI path must stay.
- Drop producer-side re-validation: both sides are trust boundaries.
- Replace `mcpCodeModeJsonFits` with `Buffer.byteLength(JSON.stringify(...))`: not equivalent.
- Fold the three content-preview variants: about 25 lines, a small cleanup.
- Reuse `displayCopy` for attachment counts: the limits differ, so counts would change.

**previews-render**

- jsdiff for word emphasis: unweighted Myers diff, 5–13% of blocks change, and the golden corpus is pinned.
- Drop the dense line matcher: pair sets change in 7–43% of blocks.
- Drop the sparse matcher: dense is O(R·A) and would need a cap that drops emphasis.
- Delete crossing-pair recovery: golden cases fail, and 1–24% of blocks change.
- jsdiff `diffArrays` in place of the patience fallback: 4–40× slower on pathological lines.
- Unify the preview shell with CompactShell: changes the default UX, and the risk is high.
- pi-tui wrap and slice in place of `wrapAnsiToWidth`: the output differs, and the bytes are pinned by tests.
- Remove the Shiki lease and deferred disposal: changes the documented interruptibility.
- Drop ingress dedup: causes invalidate and re-render loops.
- Generic owned-projection helper, position-based matchers, NUL-marker round-trip, and the unified line selector: each is local and below the threshold (the last one also gives up a memory bound).

**previews-tools-config**

- One settings field table: about −35 to −40, needs SAFETY casts, and TypeScript already cross-checks the lists.
- Collapse the settings persistence stack: invalidates about 1,200 lines of concurrency tests.
- Effect Config for environment parsing: parsing and per-field fallback both differ.
- A WeakMap for write snapshots: unbounded retention, and it loses session cleanup.
- Unify compact expanded content with preview expanded content: visible change, and it breaks the content-only rule.
- Per-tool builtin modules: moves code; only dispatch lines would be saved.
- Centralize builtin compact wiring: about 50 lines, local.
- Merge `renderer-adapter.ts` into `cooperative-tools.ts`: relocation only.
- Shared write-result classifier: about 30–40 lines.
- Derive the Compact\* interfaces from their schemas: type changes ripple into 53 producer files.
- Retire legacy notices: a workspace-wide API change with no line gain. (Later implemented by the compact-presentation redesign.)
- Shared cooperative bootstrap: about 30 lines, and the seams are per package.
- Collapse the grep and bash renderers: about 40–50 lines, local.

**ui**

- Shared list/detail body for the four managers: about −60 to −70 net, and needs many options.
- Make ActivityService synchronous: it has real async producer capabilities, with interruption driving AbortSignal.
- Remove the binding indirection; keep usage totals at the host: about 30–35 lines each, local.
- Split `application.ts`: a pure move.
- Structured usage windows in the footer protocol: a protocol change for about −35.
- pi-tui keybinding manager: global, with no modeless chords or modes.
- Merge the list-detail files: reduces file count only, which CLAUDE.md forbids doing for its own sake.
- Dedupe the detach/freeze passes: subsumed by E-footer.
- ActivityService clock on the host ticker: not shorter.
- Remove the host-status helpers: 6 packages use them.
- Dead footer exports: a small cleanup.

**code-mode**

- Unify the three per-execution ledgers: their retention rules differ on purpose, and the code is delivery-sensitive.
- The producer persists the CompactSummary: rendering needs inputs that only exist at render time.
- Strict decode without salvage: salvage is documented safety behavior.
- Issues only, no notices: the default preview style renders notices, so the change is visible. (Later implemented by the compact-presentation redesign.)
- Reuse `renderCompactChildren`: a visible restyle.
- Drop the deactivation handoff: depends on unverified Pi activation persistence.
- Flip `isError` as pi-mcp does: no net reduction.
- Share the retained-result store with pi-mcp: they have no common core.
- Scoped-settings kit: no second consumer.
- Cross-package capability, ticker and settings helpers: each is below the bar alone (the settings-surface part later became E-surface).
- Derive the guest schemas from TypeBox: the guest schemas are stricter.
- Delete `projectStructuredCodeModeOutput`: dead code, left to the small-cleanup review.

**core**

- Effect ChildProcess for the duplex process: no per-write completion, and taskkill is unbounded.
- Move single-consumer modules out of core: code motion only.
- Put writer-lease on CrossProcessLock: _superseded_, accepted as sub-infra-R1 once `tryAcquire` is added.
- Unify the terminal sanitizer parsers: they differ on purpose, and this is a security sanitizer.
- Shared in-memory JSON store driver: a persistence-critical rewrite for about 60–80 test-only lines.
- HTTP test layers on the production clients: about 35 lines, and the typed handler input would be lost.
- Provider usage kit in core: it would depend on pi-cosmic-ui, which core must not.
- Remove the synchronous usage projection: causes a stale frame, and it is below the bar.
- Fold the runtime helpers into the session slot: about 50–70 lines, and the hooks vary.
- Effect primitives for the refresh coordinator, ingress and projection: the semantics differ.
- Table-driven duplex options: about 60 lines, local.
- SchemaIssue formatters for redaction: they cannot tell static keys from dynamic ones.
- Settings help kit: hosts own their wording. Partly revisited, as providers-R2 with a documentation change.
- Rebuild subagents' process-transport on duplex: macOS-only, with no IPC.

**ask-user**

- Questionnaires as forms: different features, and a visible change.
- Blocking `ask` as async start plus await: behavior change.
- `capture()` snapshots for the decoders: changes pinned hostile-input semantics.
- Merge the two dialogs: different interaction models.
- Merge the two RPC flows: about 15 shareable lines.
- Generic PresentationHost: about 15 lines.
- Consolidate the renderers: about 60 lines of UI copy, and the contract needs separate renderers.
- Derive replay schemas from the protocol schemas: replay is deliberately lenient.
- Schedule-based retries: about 15 lines, at concurrency risk.
- Fold the host-ui bridge into activity: couples the fallback to the activity provider.
- Move the docked-dialog driver to cosmic-ui: its lifecycle differs. E-surface now covers the shared part.
- A workspace capability helper: re-proposed as background-task-R2, which is disputed.

**background-task**

- Replace `/tasks` with `/activity`: feature loss whenever pi-cosmic-ui is not loaded.
- Shared list-detail body: about 50 lines here, and rendering is caller-owned.
- Remove the LocalProcess ingress queue: changes the tested contract that the child is never backpressured.
- Delete the presentation receipt protocol: the receipt carries evidence that the guest output lacks.
- Code Mode calls the tool directly: contradicts the explicit-adapter security design.
- Rewrite the registry on SubscriptionRef: no saving, and it risks stop ordering.
- Effect ChildProcess kill on Windows: no bounded cleanup and no graceful mode.
- Core bounded runner for LocalProcess: that runner is one-shot, while tasks are long-lived.
- Derive the TypeBox parameters: changes the provider-facing schema.
- Table-driven notices and merged renderers: small cleanups.

**providers**

- Shared provider application and footer shell: about −40 to −60, and the policies differ.
- Remove the synchronous projection sync: about 75 lines, a stale frame, local.
- Config field table: about −80 net, with legacy special cases, and it costs clarity.
- Fold FastModeService persistence into the usage commit: changes the stored config.
- Image presentation dedupe: about 70–90 lines, local.
- Compaction pipeline: its invariants carry weight, and pi-ai has no native delegate.
- Image output publication: security-sensitive.
- Sharp boundary: already delegates to the core runner.
- Replace fast-mode injection with `serviceTier`: not exposed to extensions in Pi 0.86.
- Merge pi-better-xai into pi-better-openai: removes a published package.
- Pass ExtensionContext explicitly: about zero net.
- Unify the xAI auth Layer with OpenAI's direct calls: placement only.

**small packages (herdr-btw, directory-models)**

- Shared Herdr CLI outcome classifier: the policies differ on purpose.
- Shared Herdr wire-primitives module: about −90, with no good home.
- Unify shell-readiness polling: the safety policies differ.
- Fold herdr-btw into pi-subagents: different products and protocols.
- HerdrBtwError helper; merged Herdr failure builders: local cleanups.
- Core SafeFile in place of `session-file.ts`: does not fit the synchronous, tri-state, exclusive-create needs.
- Pi SessionManager for child sessions: ARCHITECTURE.md forbids it.
- Stateless parent reference: behavior change.
- Context services for the link store: moves code only.
- Rely on `agent_pane_busy`: changes launch semantics.
- Fold the directory-models store: contradicts the store-door rule.
- Replace directory-models with Pi settings: a major behavior change.
- Drop directory-models' Effect runtime: violates the Effect architecture.
- The `host-notifier` try/catch: a tiny cleanup.

**X-presentation**

- Derive preview renderers from summaries: preview is the default, so the change is visible.
- Replace the subagents fallback panel: same as sub-presentation-R1.
- Shared list/detail body; ListDetailScreen base: about 100–120 lines, with about 12 options.
- Settings command kit: partly _superseded_ by providers-R2, narrowed.
- Provider footer binding helper: about −40.
- Structured usage-window protocol: a protocol change.
- Move activity validation into the client: about −40.
- Unify the animation tickers: needs a new callback contract.
- Compact message shell: the semantics differ.
- Shared summary-receipt schema: a versioned protocol, with risk.
- CompactIssue everywhere: the legacy notice path must stay.
- Merge the description tables and decoders: domain data with deliberately different policies.

**X-process**

- process-transport on `openDuplexProcess`: macOS-only, no IPC, differing stderr and overflow semantics.
- pi-mcp stdio on process-transport: the SDK needs raw bytes.
- Effect ChildProcess: no IPC, no per-write completion, unbounded buffers.
- Move DuplexProcess into pi-mcp: code motion.
- Collapse the stdio write queues: the dispatch evidence is needed.
- Shared Herdr CLI client: under −100 net.
- IPC contact over the supervisor channel: too risky.
- A general RPC layer in process-transport: not needed after E-sup.
- Reuse `validateLocalProbeResult`: a small cleanup.
- Writer-lease on CrossProcessLock: _superseded_ by sub-infra-R1.
- LocalProcess on process-transport: an output-only shell; the shared part is covered by E-proctree.

**X-tests**

- Generator-taking `it.effect` wrapper: pure syntax, and it erases typing.
- Pi's real extension loader: not reachable through public exports.
- Pi ToolExecutionComponent as the harness: under 100 lines, and it would add ANSI and theme coupling.
- A core table for hostile-getter tests: those tests guard wiring in each package.
- Consolidate the settings rollback tests: needs a source unification first.
- Table-drive duplicated test code inside pi-subagents files: a small cleanup.
- Unify the code-mode environments: _superseded_, accepted as code-mode-R3.
- Share the pi-mcp config and auth fakes: _superseded_, part of mcp-core-R3.
- A private test-support package: adds a 13th synchronized package.
- Delete tests that pin copy: not a meaningful line saving.
- A Proxy-based service double: conflicts with the anti-slop rules.
- cosmic-ui fake Activity and Footer hosts: about −80, below the bar.
- Share `effect-test.ts`: depends on @effect/vitest.
- Consolidate the `.mjs` fixtures: each models a different external CLI.

---

## Roadmap

### Ordering rules

1. Settle the decisions above before starting the entries they gate.
2. Additive changes to shared packages (pi-cosmic-core, pi-cosmic-ui, pi-code-previews testing) land before their consumers.
3. A refactor that deletes a subsystem lands before any small cleanup inside that subsystem. Test-kit consumer migrations come last, so no one migrates tests that a later refactor deletes.
4. Within a package, land one entry per PR and one step per commit. Each step runs the narrowest package test first. Each batch ends with `pnpm validate`.
5. Release safety: all packages share one synchronized version. Removing public exports (E-footer's protocol types, core-R2's exports) needs a version bump and `pnpm version:check`. Do not publish, tag or push release commits without explicit maintainer instruction.

### Batches

| Batch                                       | Contents (in order)                                                                                                                                                                                                                                                                  | Depends on                                                                                                            | Verification                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **0. Decisions**                            | The sign-offs and choices in "Open decisions inside accepted entries"                                                                                                                                                                                                                | none                                                                                                                  | none                                                                                                                                                                                                                                                                                                                                               |
| **1. Shared foundations (additive only)**   | sub-infra-R1 step 1: core `tryAcquire`. E-proctree steps 1–2: core `process-tree.ts` and core internals. X-tests-R2: core testing `host.ts`, narrowed. X-tests-R1: thin `pi-code-previews/testing` helpers. E-surface step 1: `host-surface.ts` and the `pi-cosmic-ui/testing` fake. | 0                                                                                                                     | `pnpm --filter pi-cosmic-core test`, `pnpm --filter pi-code-previews test`, `pnpm --filter pi-cosmic-ui test`, `pnpm pack:dry` (new published files), `pnpm validate`                                                                                                                                                                              |
| **2. Credentials and core contracts**       | providers-R1 (OpenAI, then xAI), then core-R2                                                                                                                                                                                                                                        | 0. core-R2 after providers-R1, to avoid churn in xAI `auth.ts`                                                        | `pnpm --filter pi-better-openai test`, `pnpm --filter pi-better-xai test`, then `pnpm --filter pi-cosmic-core test`, `pnpm --filter pi-background-task test`, `pnpm validate`, `pnpm version:check`                                                                                                                                                |
| **3. pi-cosmic-ui internals**               | E-footer: ui-R2 (steps 1–3), then ui-R1. Then ui-R3. Shared effect-v4.md sentence.                                                                                                                                                                                                   | 0                                                                                                                     | `pnpm --filter pi-cosmic-ui test`, `pnpm --filter pi-better-openai test` and `pnpm --filter pi-better-xai test` (footer producers), `pnpm validate`, `pnpm version:check`                                                                                                                                                                          |
| **4. pi-subagents process stack**           | sub-infra-R1 steps 2–4. E-sup (steps 1–4). E-rpc (steps 1–3; optional catalog step later). E-proctree step 3 (background-task, can run any time after batch 1) and step 4 (subagents).                                                                                               | 1 (tryAcquire, core process-tree). E-rpc needs E-sup. E-proctree's subagents step comes after E-rpc and sub-infra-R1. | `pnpm --filter pi-subagents test` after each step. Optionally `pnpm --filter pi-subagents smoke:herdr-codex-hooks` for E-rpc. `pnpm --filter pi-background-task test`, `pnpm --filter pi-cosmic-core test`, `pnpm validate`                                                                                                                        |
| **5. pi-subagents settings, run and tools** | sub-settings-R1, then R2, R3, R4. sub-run-R1 (types step first). sub-presentation-R2. Disputed sub-run-R2, if adopted, after sub-run-R1.                                                                                                                                             | 0. R3/R4 after R1. Independent of batch 4, but merge serially within the package.                                     | `pnpm --filter pi-subagents test` per step, `pnpm validate`                                                                                                                                                                                                                                                                                        |
| **6. Owned surfaces in consumers**          | E-surface steps 2–7: MCP overlay, MCP auth panel, ask-user (with ask-user-R2's dialog move), Activity, code-mode and xAI inline settings, then the unguarded screens. ask-user-R1 (independent, placed here for ask-user locality). providers-R2 last.                               | 1 (host-surface). 5, before the profile dashboard migrates. 2 (providers-R1) before providers-R2.                     | `pnpm --filter pi-mcp test`, `pnpm --filter pi-ask-user test`, `pnpm --filter pi-cosmic-ui test`, `pnpm --filter pi-code-mode test`, `pnpm --filter pi-better-xai test`, `pnpm --filter pi-better-openai test`, `pnpm --filter pi-background-task test`, `pnpm --filter pi-subagents test`, `pnpm --filter pi-code-previews test`, `pnpm validate` |
| **7. pi-mcp**                               | mcp-core-R1. mcp-core-R2 (the code-mode step only if decided). mcp-boundary-R1 steps 1–4, then stdio, then HTTP. mcp-core-R3 last, because its contract tightening affects the SDK implementers. Disputed mcp-ui-R1 here if adopted.                                                 | 0                                                                                                                     | `pnpm --filter pi-mcp test` (run on macOS: the stdio real-process tests are darwin-gated), `pnpm --filter pi-code-mode test` (consumes `pi-mcp/code-mode`), `pnpm pack:smoke` for mcp-core-R1, `pnpm validate`                                                                                                                                     |
| **8. pi-code-mode**                         | code-mode-R1 (hooks, MCP ledger, count-less details, then v1 if approved), code-mode-R2, then code-mode-R3                                                                                                                                                                           | 0                                                                                                                     | `pnpm --filter pi-code-mode test` after each commit, `pnpm validate`                                                                                                                                                                                                                                                                               |
| **9. Other single-package items**           | previews-render-R1. background-task-R3. Disputed background-task-R2 hardening, if adopted, after background-task-R3.                                                                                                                                                                 | 0. Independent.                                                                                                       | `pnpm --filter pi-code-previews test` and `pnpm --filter pi-code-previews word:accuracy`, `pnpm --filter pi-background-task test`, `pnpm --filter pi-code-mode test`, `pnpm validate`                                                                                                                                                              |
| **10. Test-kit consumer migrations**        | X-tests-R2 consumers (casts, themes, deferreds, subagents probes). X-tests-R1 consumers (settings, contexts, deep imports).                                                                                                                                                          | 1, and every structural batch that touches the same test files                                                        | Each package's test command. Grep that no test imports `pi-code-previews/src`. `pnpm validate`                                                                                                                                                                                                                                                     |

Batches 2, 3, 7, 8 and 9 touch disjoint packages and can proceed in parallel once batch 0 is settled. Batch 4 needs batch 1. Batch 6 needs batches 1 and 5. Batch 10 goes last.

### Small cleanups made moot or dependent

Ask the small-cleanup review to hold edits in these files until the structural entry that deletes or rewrites them has landed:

- **E-sup:** `pi-supervisor-bridge-client.ts`; the Pi-mode parts of `supervisor-mcp-helper.ts` and `mcp-wire.ts`.
- **E-rpc:** `rpc-session.ts`, including the proposed trim of dead options; the RPC helpers in `herdr-codex-hooks.ts`.
- **sub-infra-R1:** everything inside `writer-lease.ts`.
- **E-proctree:** the pi-subagents `process-tree.ts` body; the termination block in `local-process.ts` (lines 116–257); the duplex `signalGroup`.
- **E-footer:**
  - footer `registry.ts`, `protocol/host.ts`, and `canonicalization.ts`;
  - `layout.ts` lines 86–181;
  - the `mediaPlacement` config and settings row;
  - the redundant detach/freeze passes.
- **ui-R3:** `working/service.ts`, `working/owner.ts`, `host-working-message.ts`.
- **E-surface:**
  - the overlay code in pi-mcp `host-ui.ts` and `host-auth-panel.ts`;
  - ask-user `host-tui.ts` and `host-form-tui.ts`, including the `renderError` dedupe noted by a reviewer;
  - Activity `open()`;
  - code-mode `host-ui.ts`;
  - xAI `host-ui.ts`.
- **providers-R1:** xAI `auth/auth.ts`, OpenAI `auth/codex-auth.ts`.
- **providers-R2:** both providers' outer settings controllers.
- **core-R2:** `scoped-store.ts` and the `document-ops.ts` readers.
- **code-mode-R1 and R2:**
  - `tools/mcp-evidence.ts`, `ui/replay-evidence.ts`, `ui/detail-counts.ts`;
  - the ownership block in `expanded-result.ts`;
  - the status and read plain renderers.
- **sub-settings-R1..R4:**
  - `profile-target-picker.ts`, `profile-workspace-actions.ts` (the menu table is optional in R1);
  - the saved-set picker menu and delete prompt;
  - `profile-set-save-form*.ts`;
  - `ui/model-picker.ts`.
- **sub-run-R1:** the run-module `*Dependencies` interfaces and the `service.ts` wiring. Disputed sub-run-R2's salvage pieces belong to the small-cleanup review in any case.
- **sub-presentation-R2:** the `tools/subagent.ts` registration shells, the `proxy-protocol.ts` switches, and the `TOOL_PARAMETERS` table in `tool-schemas.test.ts`.
- **mcp-core-R1 and R2:**
  - the keyword and dialect sets in `schema-policy.ts`;
  - the helper policy;
  - `chargeMetadata` and `freezeMetadata`;
  - results `copy`;
  - config `checkConfigBounds`.
- **mcp-boundary-R1:** the option validators in `sdk-http-options.ts`, the SDK error branches, and the bounded-cleanup copies.
- **ask-user-R1:** `host-proxy.ts`, `host-form-proxy.ts`, `form-service.ts`.
- **background-task-R3:** the compact-summary private schemas and the action literal lists.
- **previews-render-R1:** `token-text-refinement.ts`.
