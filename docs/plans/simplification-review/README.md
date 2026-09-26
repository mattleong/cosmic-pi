# cosmic-pi simplification review

This review looked for code in the cosmic-pi workspace (12 Pi extension packages, about 130k source and 130k test lines) that can be deleted without a major behavior change. It ran in two passes. In the line-level pass, finders scanned each package unit and adversarial verifiers re-checked every claim, which left 806 findings after deduplication. In the structural pass, subsystem architects proposed refactors and three independent reviewers (behavior, feasibility/LOC, justification) vetted each one, which left 28 accepted refactors, 3 disputed and 2 rejected. A reconciliation step then classified every line-level finding that touches a refactor as independent, superseded, do-first or conflicting, so no line is counted twice. Together the accepted work removes about **10,400 source lines and 14,600 test lines** (−10,418 / −14,562), roughly 8% of source and 11% of tests. Most of it is low risk.

No repository file was changed. Nothing here has been published, tagged or pushed.

## Combined totals

All figures are net lines in diff convention: − removes lines, + adds them. **They are review estimates, not a measured diff.** Every figure is the verifiers' conservative minimum, meaning the lowest saving any reviewer accepted. Structural figures are the vetted numbers from the structural report.

| Package                             | Structural src | Structural test | Line-level src | Line-level test | **Combined src** | **Combined test** |
| ----------------------------------- | -------------: | --------------: | -------------: | --------------: | ---------------: | ----------------: |
| pi-subagents                        |         −2,188 |            −847 |         −2,309 |          −3,881 |       **−4,497** |        **−4,728** |
| pi-cosmic-ui                        |         −1,035 |            −755 |           −568 |            −519 |       **−1,603** |        **−1,274** |
| pi-mcp                              |           −323 |            −141 |           −655 |          −2,148 |         **−978** |        **−2,289** |
| pi-code-previews                    |           −163 |             −53 |           −728 |          −1,288 |         **−891** |        **−1,341** |
| pi-code-mode                        |           −315 |            −330 |           −275 |            −860 |         **−590** |        **−1,190** |
| pi-better-openai + pi-better-xai    |           −355 |            −440 |           −208 |            −463 |         **−563** |          **−903** |
| pi-cosmic-core                      |             +9 |             +35 |           −272 |            −570 |         **−263** |          **−535** |
| pi-background-task                  |            −75 |              +2 |            −51 |            −606 |         **−126** |          **−604** |
| pi-ask-user                         |           −114 |              +5 |            −80 |            −475 |         **−194** |          **−470** |
| pi-herdr-btw                        |              0 |               0 |           −188 |            −121 |         **−188** |          **−121** |
| pi-directory-models                 |              0 |               0 |             −6 |             −30 |           **−6** |           **−30** |
| Cross-package, not split by package |            +31 |          −1,015 |           −550 |             −62 |         **−519** |        **−1,077** |
| **Total**                           |     **−4,528** |      **−3,539** |     **−5,890** |     **−11,023** |      **−10,418** |       **−14,562** |

Row notes:

- Structural rows use the structural report's per-package table. sub-infra-R1 is split as its entry states: pi-subagents −584/−505 and pi-cosmic-core +9/+35. providers-R1 is not split between the two provider packages.
- The structural cross-package row holds E-surface, core-R2, E-proctree, providers-R2, X-tests-R1 and X-tests-R2. The two test kits are counted at their full-kit source cost (+540). At the narrowed scope the reviewers recommend (about +120), combined source savings grow by about 420 lines.
- Line-level pi-mcp is the pi-mcp-src and pi-mcp-tests shards. pi-subagents is its three shards. The xAI/directory-models/herdr-btw shard is split by its own per-package figures. Its two idiom sweeps (T-small-1, T-small-6: 62 test lines across all three packages) sit in the cross-package row, next to the cross-package shard's 550 source lines.

**Arithmetic.**

- Line-level source: 7,214 gross − 122 subsumed − 1,202 superseded = **5,890**.
- Line-level tests: 12,288 gross − 0 subsumed − 1,265 superseded = **11,023**.
- Combined: 4,528 + 5,890 = **10,418** source lines; 3,539 + 11,023 = **14,562** test lines.

How each step was derived:

- **Gross** is the sum of the 14 shard totals in `summaries.json` (806 findings).
- **Subsumed** means 12 per-package findings that a cross-package entry already counts: core-rest-12 (10), background-task-4 (13), background-task-6 (9), ask-user-10 (11), mcp-tools-results-7 (15), mcp-connection-discovery-11 (11), mcp-ui-manager-7 with mcp-auth-9 (9), mcp-connection-discovery-3 with mcp-ui-manager-9 (18), sub-backend-19 (14) and sub-settings-rest-12 (12).
- **Superseded** subtracts every finding that a counted refactor makes moot, once, at the figure its shard actually counted. The seven reconciliation groups sum to 1,469 / 1,400 raw. From that raw sum I removed:
  - cross-group repeats;
  - ids already subtracted as subsumed;
  - pairs that the shards had already merged;
  - items that are moot only if disputed background-task-R2 or the optional mcp-core-R2 code-mode step is adopted;
  - X-shared-7, which its shard counts inside background-task-7 and codemode-ui-rest-6 (0 counted).

  That leaves 1,190 / 1,245. Two conflicts that a refactor wins add 12 / 20: mcp-tools-results-9 loses to mcp-core-R2, and T-previews-tools-2 loses 20 of its 60 test lines to X-tests-R1.

  Three findings are only partly superseded: ui-footer-protocol-5 (20 of 25), ui-footer-protocol-10 (5 of 7) and ui-activity-app-1 (33 of 42). Only their moot part is subtracted. Every other superseded finding is subtracted in full, so small salvageable remainders are not counted.

- **Not subtracted.** The reconciliation also found about 120 source and 320 test lines of partial overlap inside findings it classed as independent. Examples: A1 guard sites in files that E-surface or E-rpc delete, and theme or deferred fixtures that X-tests-R2 replaces. Subtracting them gives roughly **−10,300 source and −14,250 test lines**.

## Where the excess comes from

Four themes cover all of it. Structural themes A–E come from the structural report. Line-level lines are grouped by the finders' category. Superseded and subsumed findings were removed from their main category, so the split between themes is approximate. The four rows still add up exactly to the totals.

| Theme                                                               | Structural            | Line-level categories                                                                              | Combined src | Combined test |
| ------------------------------------------------------------------- | --------------------- | -------------------------------------------------------------------------------------------------- | -----------: | ------------: |
| 1. Parallel implementations of one mechanism                        | A, D: −3,294 / −1,371 | duplication, shared-helper reuse: −2,162 / −836                                                    |   **−5,456** |    **−2,207** |
| 2. Ceremony around simple work                                      | C: −660 / −240        | verbose code, indirection, boilerplate, over-generalization, redundant validation: −2,998 / −3,115 |   **−3,658** |    **−3,355** |
| 3. Copied test scaffolding and tests that re-prove covered behavior | E: +544 / −1,115      | test-fixture duplication, test redundancy, test-policy violations: −7 / −6,731                     |     **+537** |    **−7,846** |
| 4. Dead, retired and compatibility code still shipped               | B: −1,118 / −813      | dead code: −723 / −341                                                                             |   **−1,841** |    **−1,154** |

1. **Parallel implementations.** Packages rebuild mechanisms that core, Pi or a sibling already owns:
   - pi-subagents has a second cross-process lease (writer-lease.ts, 834 lines) and a second JSONL RPC stack (rpc-session.ts, 500 lines).
   - Both provider packages keep their own auth.json credential stacks.
   - The Pi overlay-close workaround is copied into five places, and there are two Windows taskkill terminators, two JSON-Schema policies and four bounded-JSON walkers.
   - At line level, core's `invokeHostCallback` and `freezeSnapshot` go unused at about 80 and 10 sites, and five providers and five consumers each hand-roll the same session-capability query protocol.
   - Inside single packages there are two ask-user owned-call registries, a doubled Claude argv builder and repeated Herdr environment allowlists.
2. **Ceremony.** Effect services, ingress queues and forks wrap purely synchronous host work (the footer registry and the working row). pi-subagents has fifteen hand-written run-module dependency bags. Elsewhere there are switch ladders that could be tables, single-implementation interfaces, types restated next to the schema they could derive from, and checks the schema already enforces. On the test side, tests use `Effect.result` plus `_tag` matching where `Effect.flip` would do, and write out multi-line literals.
3. **Test scaffolding.** These are rebuilt by hand, file by file and package by package:
   - fake hosts, about 60 identity themes and about 15 deferreds;
   - 133 `setCodePreviewSettings` calls in 36 files;
   - about 20 hand-built Code Mode execution environments and the pi-mcp service fakes.

   Many tests repeat a stronger neighbor or pin UI copy. The pi-subagents test shard alone accounts for 3,806 test lines.

4. **Dead code.**
   - Footer media surfaces have had no producer since pi-cosmic-ui was created.
   - The pre-dashboard profile editor protocol is still shipped.
   - pi-code-mode keeps three superseded details formats.
   - pi-code-previews has a third word-emphasis refinement level that changes output in a few blocks per ten thousand.
   - Test-only contract members and exports remain (for example `updateObject` and `refreshCatalogs`), along with unreachable branches.

## Roadmap

Rules:

- Land one entry per PR and one step per commit.
- Run `pnpm --filter <pkg> test` for each touched package after each step, and end each batch with `pnpm validate`.
- Any public API change also needs one synchronized version bump and `pnpm version:check`.
- Do not publish, tag or push release commits unless the maintainer asks.
- LOC in the tables is net; source and test are shown as src / test.

### Phase 0: decisions

Settle the items under "Decisions needed" that gate a batch before starting that batch. Phase 1 needs only the public-export items that apply to it.

### Phase 1: quick wins and shared helpers

Every phase excludes the subsumed findings, and the superseded findings listed at the end of this roadmap. Items whose public-export changes need approval wait on decisions 4 and 6.

| Batch                                                | Contents                                                                                                                                                                                                                                                                                                                                                     |        Src |        Test | Risk     | Effort |
| ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------: | ----------: | -------- | ------ |
| 1.1 pi-cosmic-core helpers and cleanups              | Cross-package B3 (core decode helper), C2, C3, G1, then B1 (session-capability module, after B3). Hold B1's ask-user listener edits until 3.6. Plus every pi-cosmic-core finding except those in Phase 2 and the API-narrowing bundle in 3.2. This includes core-platform-5, which must land before 3.1's `tryAcquire` and must keep core release semantics. |       −287 |        −510 | low      | M      |
| 1.2 Cross-package adoptions                          | A1 (`invokeHostCallback` sweep), skipping sites in files that E-surface, E-rpc or ask-user-R1 rewrite. Also D2, D3, E2, E3, F1, H1, H2.                                                                                                                                                                                                                      |       −319 |           0 | none–low | M      |
| 1.3 pi-subagents                                     | All findings in the three pi-subagents shards except those in Phase 2 and the 3.4, 3.5 and 3.6 follow-ups. Merge the `service-harness.ts` and `writer-ownership.test.ts` edits serially. sub-herdr-cli-process-15 and -16 must keep the waits and the `not_sent` switch that E-rpc relies on. Measure sub-run-core-3, -4, -10 and -13 before landing them.   |     −2,050 |      −3,559 | none–low | L      |
| 1.3 pi-code-previews                                 | All except previews-diff-syntax-7 and -10 (3.9) and the T-previews-tools-2 remainder (4.4).                                                                                                                                                                                                                                                                  |       −678 |      −1,248 | none–low | M      |
| 1.3 pi-mcp                                           | All except the Phase 2 items, the 3.7 and 4.2 follow-ups, and T-mcp-auth-invocation-7 (3.1). T-mcp-connection-discovery-11 skips its three sites inside fakes that mcp-core-R3 replaces.                                                                                                                                                                     |       −575 |      −1,927 | none–low | M–L    |
| 1.3 pi-cosmic-ui                                     | All except Phase 2 and the 3.3 follow-ups. Merge the `application.ts` and `layer.ts` edits serially. ui-manager-5 drops pi-better-openai's `search: true` in the same change.                                                                                                                                                                                |       −476 |        −516 | none–low | M      |
| 1.3 pi-code-mode                                     | All except Phase 2 and the 3.8 and 4.1 follow-ups.                                                                                                                                                                                                                                                                                                           |       −234 |        −660 | low      | M      |
| 1.3 pi-better-openai                                 | All except better-openai-3 (Phase 2).                                                                                                                                                                                                                                                                                                                        |       −122 |        −417 | none–low | M      |
| 1.3 pi-better-xai, pi-herdr-btw, pi-directory-models | All except better-xai-dirmodels-1 (Phase 2).                                                                                                                                                                                                                                                                                                                 |       −235 |        −258 | none–low | M      |
| 1.3 pi-background-task                               | All.                                                                                                                                                                                                                                                                                                                                                         |        −51 |        −606 | none–low | S–M    |
| 1.3 pi-ask-user                                      | All.                                                                                                                                                                                                                                                                                                                                                         |        −80 |        −475 | none–low | S–M    |
| **Phase 1 total**                                    |                                                                                                                                                                                                                                                                                                                                                              | **−5,107** | **−10,176** |          |        |

Several items already in Phase 1 must land before Phase 4's test-kit migrations: T-ask-user-7, T-background-task-1, -5, -9 and -11, T-codemode-a-8 and -a-11, T-mcp-rest-16 and -18, and T-openai-9.

Verification: run `pnpm --filter pi-cosmic-core test` for 1.1. For 1.2, run each touched package's test command. For 1.3, run `pnpm --filter <pkg> test` for the batch's package. Run `pnpm validate` after each batch.

### Phase 2: do-first cleanups

Each item makes a later refactor smaller. Land it any time before the batch named.

| Before                                       | Ids                                                                                                                                                                                        |      Src |     Test |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------: | -------: |
| 3.2 providers-R1                             | better-xai-dirmodels-1                                                                                                                                                                     |      −33 |       −1 |
| 3.2 core-R2 (steps 1, 2, 4)                  | core-rest-3, T-core-15                                                                                                                                                                     |      −17 |      −42 |
| 3.3 E-footer (ui-R2 step 3, ui-R1) and ui-R3 | ui-footer-protocol-9 (attempt objects), ui-activity-app-7 (drop the diagnostics ring buffer, then drop diagnostics from E-footer's and ui-R3's test items; edit pi-boundaries.md:115 once) |      −33 |       −7 |
| 3.4 E-sup                                    | sub-supervisor-writer-9, T-sub-herdr-supervisor-12                                                                                                                                         |      −10 |      −36 |
| 3.5 sub-run-R1                               | sub-run-core-1, sub-run-core-16, sub-run-rest-9                                                                                                                                            |      −38 |       +3 |
| 3.5 sub-presentation-R2 step 2               | sub-tools-exec-ui-5                                                                                                                                                                        |       −6 |        0 |
| 3.6 E-surface step 2                         | mcp-ui-manager-12 (the kept MCP test becomes dispose-once)                                                                                                                                 |       −6 |       −3 |
| 3.6 providers-R2                             | better-openai-3                                                                                                                                                                            |      −12 |        0 |
| 3.7 mcp-boundary-R1 HTTP port                | mcp-transport-4, mcp-transport-5                                                                                                                                                           |      −30 |        0 |
| 3.8 code-mode-R1                             | codemode-tools-1, D1 (X-shared-2)                                                                                                                                                          |      −48 |        0 |
| 4.1 code-mode-R3                             | T-codemode-b-7, with its mandatory `execution.test` paging change                                                                                                                          |        0 |      −75 |
| 4.2 mcp-core-R3                              | mcp-auth-6, T-mcp-auth-invocation-10                                                                                                                                                       |       −6 |      −30 |
| **Phase 2 total**                            |                                                                                                                                                                                            | **−239** | **−191** |

Every item is low risk and effort S. Verification: package tests, then `pnpm validate`.

### Phase 3: structural refactors, in dependency order

Each "Follow-ups" item is a line-level finding that must wait for its refactor to land.

| Batch                                 | Refactors                                                                                                                                                                               |                    Src / test | Follow-ups (after the refactor)                                                                                                                                                        |      Src / test | Risk       | Effort  |
| ------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------: | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------: | ---------- | ------- |
| 3.1 Shared foundations (additive)     | sub-infra-R1 step 1 (`tryAcquire`); E-proctree steps 1–2; X-tests-R2 step 1 (core testing `host.ts`), then X-tests-R1 step 1; E-surface step 1 (`host-surface.ts` and the testing fake) | counted in the parent entries | T-mcp-auth-invocation-7 (IPC child harness in core testing, with X-tests-R2)                                                                                                           |         0 / −30 | low        | M       |
| 3.2 Credentials and core contracts    | providers-R1 (OpenAI, then xAI), then core-R2                                                                                                                                           |                   −525 / −515 | Core API-narrowing bundle under the same waiver: core-rest-5, -6, -7, -8, -10 and core-platform-1, -11, -13                                                                            |      −122 / −18 | low        | M+M     |
| 3.3 pi-cosmic-ui internals            | E-footer (ui-R2 steps 1–3, then ui-R1), then ui-R3, with the shared effect-v4.md sentence                                                                                               |                 −1,035 / −755 | ui-manager-7; the projection-getter half of ui-footer-protocol-6; the remainders of ui-footer-protocol-5 (fold its Schema.Finite move into ui-R2 step 1) and -10 and ui-activity-app-1 |        −59 / +4 | low        | M×3     |
| 3.4 pi-subagents process stack        | sub-infra-R1 steps 2–4; E-sup; E-rpc (needs E-sup); E-proctree steps 3–4 (background-task any time; subagents after E-rpc and sub-infra-R1)                                             |                 −1,345 / −715 | T-sub-herdr-supervisor-13 + T-sub-rest-9; T-sub-herdr-supervisor-14 + T-sub-rest-10; T-sub-rest-12 + T-sub-run-23                                                                      |        0 / −162 | medium     | M+L+M+M |
| 3.5 pi-subagents settings, run, tools | sub-settings-R1, then R2, R3, R4; sub-run-R1 (type-only step first); sub-presentation-R2                                                                                                |                    −894 / −97 | After R3: sub-settings-rest-5, sub-settings-workspace-10, -11, -15. After R1/R2: sub-settings-workspace-7, -12, sub-config-profiles-2, -14, T-sub-profiles-config-12, -15, -17, -20.   |     −169 / −127 | low        | M×5 + L |
| 3.6 Owned surfaces in consumers       | E-surface steps 2–7 (needs 3.1 and 3.5); ask-user-R1; providers-R2 last (needs 3.2)                                                                                                     |                   −393 / −135 | After ask-user-R1: B2, plus B1's and A1's ask-user sites. After E-surface: E1, sub-settings-rest-9, -10.                                                                               |         −85 / 0 | medium     | L+M+M   |
| 3.7 pi-mcp                            | mcp-core-R1; mcp-core-R2 (code-mode step only if decided); mcp-boundary-R1 steps 1–4, then stdio, then HTTP                                                                             |                    −327 / +24 | mcp-transport-9 (derive from `OptionsSchema.Encoded`)                                                                                                                                  |         −18 / 0 | low–medium | M+M+L   |
| 3.8 pi-code-mode                      | code-mode-R1 (hooks, MCP ledger, count-less details, then v1 if approved); code-mode-R2                                                                                                 |                   −315 / −180 | codemode-ui-rest-8, -11; T-codemode-b-3                                                                                                                                                |       −21 / −55 | medium     | M+M     |
| 3.9 Other single-package              | previews-render-R1; background-task-R3                                                                                                                                                  |                    −238 / −51 | previews-diff-syntax-7 (drop the `segmentAt` site), -10 (do the `tokenMiddleRange` collapse once)                                                                                      |         −50 / 0 | low        | M+M     |
| **Phase 3 total**                     |                                                                                                                                                                                         |           **−5,072 / −2,424** |                                                                                                                                                                                        | **−524 / −388** |            |         |

Verification per batch:

- 3.1: `pnpm --filter pi-cosmic-core test`, `pnpm --filter pi-code-previews test`, `pnpm --filter pi-cosmic-ui test`, `pnpm pack:dry`.
- 3.2: pi-better-openai, pi-better-xai, pi-cosmic-core and pi-background-task tests; `pnpm version:check`.
- 3.3: pi-cosmic-ui, pi-better-openai and pi-better-xai tests; `pnpm version:check`.
- 3.4: pi-subagents tests after each step; optionally `pnpm --filter pi-subagents smoke:herdr-codex-hooks`; pi-background-task and pi-cosmic-core tests.
- 3.5: pi-subagents tests after each step.
- 3.6: tests for pi-mcp, pi-ask-user, pi-cosmic-ui, pi-code-mode, pi-better-xai, pi-better-openai, pi-background-task, pi-subagents and pi-code-previews.
- 3.7: pi-mcp tests on macOS (the stdio real-process tests only run on darwin), pi-code-mode tests, `pnpm pack:smoke`.
- 3.8: pi-code-mode tests after each commit.
- 3.9: pi-code-previews tests and `pnpm --filter pi-code-previews word:accuracy`, then pi-background-task and pi-code-mode tests.

Every batch ends with `pnpm validate`.

Scheduling:

- Batches 3.2, 3.3, 3.7, 3.8 and 3.9 touch disjoint packages and can run in parallel after Phase 0.
- 3.4 needs 3.1.
- 3.6 needs 3.1 and 3.5.

### Phase 4: test infrastructure

| Batch                    | Contents                                                                                                                                                      |                   Src / test | Follow-ups                                                                                                                                |     Src / test | Risk | Effort |
| ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------: | ----------------------------------------------------------------------------------------------------------------------------------------- | -------------: | ---- | ------ |
| 4.1 code-mode-R3         | Shared execution harness and provider fixtures, one file per commit (keep 420 tests)                                                                          |                     0 / −150 | T-codemode-a-6, T-codemode-b-4                                                                                                            |        0 / −70 | low  | M      |
| 4.2 mcp-core-R3          | Shared pi-mcp service fakes; required contract members; layer split dropped                                                                                   |                    +4 / −165 | mcp-tools-results-2; T-mcp-rest-1 (only its presentationLayer, emptyManager and host part); T-mcp-connection-discovery-6, then -7 and -13 |     −20 / −158 | low  | L      |
| 4.3 X-tests-R2 consumers | Casts, multi-line identity themes, deferreds and subagents process probes, one package per commit. Leave files rewritten in 3.3–3.5 until those batches land. | +210 / −380 (narrowed ≈ +40) | none                                                                                                                                      |              — | low  | M      |
| 4.4 X-tests-R1 consumers | Settings, contexts and deep imports, one package per commit                                                                                                   | +330 / −420 (narrowed ≈ +80) | T-previews-tools-2 remainder, built on R1's public helpers                                                                                |        0 / −40 | low  | L      |
| **Phase 4 total**        |                                                                                                                                                               |            **+544 / −1,115** |                                                                                                                                           | **−20 / −268** |      |        |

Verification: each package's test command. Grep that no test outside pi-code-previews imports `pi-code-previews/src`. Then `pnpm pack:dry` and `pnpm validate`.

Phase totals reconcile with the table above:

- Source: 5,107 + 239 + 5,072 + 524 − 544 + 20 = 10,418.
- Tests: 10,176 + 191 + 2,424 + 388 + 1,115 + 268 = 14,562.

### Line-level findings that must not land on their own

The refactor named first supersedes each of these. Land the remainders in brackets only after that refactor.

- **E-footer:** ui-footer-protocol-7, -5 [Schema.Finite move], -10 [context fallback], T-ui-9, T-ui-10.
- **ui-R3:** ui-activity-app-1 [tok/s inline], T-ui-19.
- **E-surface:** E4 (X-dup-12, X-boiler-5), ask-user-1, better-xai-dirmodels-7, T-mcp-boundary-16. mcp-ui-manager-7 and mcp-auth-9 are already subsumed into E4.
- **sub-infra-R1:** sub-supervisor-writer-1, -3; T-sub-rest-3.
- **E-sup:** sub-supervisor-writer-2, -4. Fold -4's single `callContact` into `runSupervisorTool`.
- **E-rpc:** sub-supervisor-writer-5, -6.
- **E-proctree:** C1 (X-dup-6), core-platform-4 [callObserver, childExit, Stream.tap], sub-herdr-cli-process-18 [nodeErrorCode reuse].
- **sub-run-R1:** sub-run-core-2, -8.
- **sub-settings-R1:** sub-settings-rest-1, -3 with sub-run-rest-4, -11 with sub-settings-workspace-4; sub-settings-workspace-1, -2, -3, -17, -20.
- **sub-settings-R2:** sub-settings-rest-2; sub-settings-workspace-8, -9.
- **sub-presentation-R2:** sub-tools-exec-ui-4, -12, -13 [WORKSPACE_FIELDS derivation].
- **providers-R1:** better-openai-1, better-xai-dirmodels-3, -4 (reuse `Equal.equals` for the new 401 check), T-openai-7, T-small-2, -9, -15.
- **core-R2:** core-platform-2, core-platform-3 with T-core-7, background-task-7, T-previews-rest-24.
- **background-task-R3:** background-task-1, -2, -5.
- **mcp-core-R2:** D4 (X-shared-5); mcp-tools-results-9 (conflict; R2 keeps per-caller limits); mcp-tools-results-1 only if the code-mode step is taken.
- **mcp-core-R3:** mcp-tools-results-8 (fold its unused `available` and `generation` removals into R3 step 4); T-mcp-connection-discovery-4, -5; T-mcp-auth-invocation-9; T-mcp-rest-21.
- **mcp-boundary-R1:** mcp-transport-1, -2.
- **code-mode-R2:** codemode-ui-rest-2 [about 9 lines], codemode-tools-2, codemode-ui-rest-3.
- **code-mode-R3 with X-tests-R1/R2:** T-codemode-a-1 with b-1, T-codemode-a-2, T-codemode-a-3 with a-10 and b-12, T-codemode-a-9 [afterEach settings reset].
- **ask-user-R1:** ask-user-3.
- **previews-render-R1:** T-previews-rest-29 [range-refinement 6–17].
- **X-tests-R1:** T-ask-user-3, T-background-task-4, T-sub-tools-ui-ws-1, and 20 lines of T-previews-tools-2.
- **X-tests-R2:** T-sub-tools-ui-ws-5 with T-sub-profiles-config-3 and T-sub-rest-13 (one plainTheme) [projectionOf, selectKeybindings]; T-small-14.

## Decisions needed from the maintainer

Recommended options come first where the reviewers made a recommendation.

**Public API and release.** Each item taken needs a release note, one synchronized bump and `pnpm version:check`.

1. **pi-cosmic-core export removals (core-R2) and API narrowing.** CLAUDE.md asks for stable core exports, so this needs a waiver.
   - Waive and remove `updateObject`, `AtomicJsonDocumentStoreContract`, `scopedDocumentPaths`, `selectScopedDocument`, `readConfigOrWarn`, `readOptionalJsonObject`, the ScopedDocument option and selection types, and the `InMemoryDocuments.service` shape. Also narrow the types in core-rest-3, -5, -6, -7, -8, -10, core-platform-1, -11, -13 and T-core-15.
   - Or keep the exports, and drop core-R2 and that bundle (about 309 source lines).
2. **Disputed core removals** (not counted). core-platform-9 (ProcessCoordinator becomes `withProcessLock`, −24/−12), core-rest-1 (UsageControllerStore as a `Pick`, −19) and core-platform-8 (drop `isContainedPath`/`isContainedPathWith`, −16). Take them, which deletes documented exports or reverses documented decisions, or keep them (0 to 8 lines).
3. **readSchemaDocument follow-up.** After providers-R1, core `readSchemaDocument`/`DecodedDocument` and JsonHttpClient `formBody` are dead (about 266 lines, not counted). Delete them in a separate change, or keep them.
4. **New pi-cosmic-core exports.** These are additive: `tryAcquire`, the process-tree helpers, testing `host.ts`, the session-capability module (B1/B2), the decode helper (B3), the shell-name predicate (C2), the text-prefix helpers (C3), the listener helpers (G1), the IPC child harness (T-mcp-auth-invocation-7) and `pausedScheduler` (T-mcp-boundary-18). Confirm the names and homes, including whether G1's `scopedListener` lives in core or stays local to pi-mcp.
5. **pi-cosmic-ui/protocol surface types (E-footer).** Remove `CosmicFooterSurfaceContribution`, `CosmicFooterSurfaceRenderOptions`, `CosmicFooterPlacement` and the `"media"` region while keeping protocol version 2. Or keep the surface subsystem and forgo E-footer's step 1 (about 375/515 lines).
6. **Other published removals with no workspace user.** The pi-cosmic-ui subpath members in ui-manager-1, -4, -5, -6 and ui-activity-app-6, including ui-manager-5's changed `VimSettingsAdapter` default. pi-code-previews root `isCompactIssues`/`withoutFailureBodyIssues` (previews-tools-13; keeping them saves 6 instead of 9). pi-ask-user/protocol `QuestionnaireQuery` (B1). Remove them with release notes, or keep them.
7. **New published surfaces.** `pi-cosmic-ui/boundary/host-surface` and its testing fake (E-surface), the `pi-code-previews/testing` helpers (X-tests-R1), and a `fakeActivityHost` testing subpath (T-background-task-15). Accept them, or keep the helpers package-local; E-surface cannot work that way.
8. **mcp-core-R2 code-mode step.** Leave it as a follow-up (the recommendation). Or replace `mcpCodeModeJsonFits` in the public `pi-mcp/code-mode` export (about −67). That drops the rejection of an own non-callable `toJSON` and requires an array-prototype check.

**Behavior sign-offs inside accepted refactors** 9. **code-mode-R1 v1 retirement.** Approve it, and 24 local records from 09-16 to 09-18 replay as uncertain. Or decline it, which saves about 20 fewer lines. 10. **previews-render-R1.** Accept losing the third refinement level, which changes output in a few blocks per ten thousand and where the old output was often worse. Or keep the level. 11. **sub-settings-R4.** Use ↑/↓ as the destination toggle, or Tab, in which case Tab then Enter flips the scope. The change from a framed form to a plain dialog also needs UX sign-off. 12. **sub-settings-R3.** Host the More menu inside the picker, or in the dashboard dialog slot. 13. **sub-infra-R1 lock root.** Use a per-agent-directory `writer-leases-v3`, which keeps today's behavior but amends core's test-only `directory` doc. Or use core's per-OS-user root, which also excludes writers across agent directories. Either way, ship a "restart all Pi sessions" upgrade note. 14. **E-sup.** Accept and document that a delegated-Pi event-loop stall of 5 s or more ends its supervisor channel, with a measurement test. Or add a reconnect path. Also choose the text a rejected call shows: a fixed human-facing message, or the bounded `SupervisorRpcFailure` message. 15. **E-surface.** - On the formerly unguarded screens, rethrow a factory failure as today, or show a notice. - Keep `/code-preview-health`'s geometry through the passthrough placement, or leave the screen out. - Exclude the `/cosmic-ui`, OpenAI and code-previews inline settings, or include them. 16. **providers-R1.** When the 401 re-resolve fails, keep today's "(HTTP 401)" usage error, or switch to a typed lookup failure. 17. **providers-R2.** - Bare `/openai-settings` without a TUI shows help, or today's warning. - Keep the per-change `id = value` notice, or drop it. - Keep today's signal handling, or list the change. 18. **E-footer entry bound.** Bound the trampoline to 128 reentrant operations per drain and cap keys at 128 only before a session starts. The alternatives are a mandatory 128-entry cap, or no cap. 19. **effect-v4.md exception.** Add one narrow sentence for the footer registry and working row as synchronous presentation state. Or keep both as Effect services, which forgoes about 660/240 lines. 20. **ui-R3 clear semantics.** Accept that idle disposal no longer clears the working row, or write `undefined` unconditionally while bound. 21. **ask-user-R1 errors.** Keep exact per-kind messages, or accept templated text that consumers remap. 22. **E-proctree.** Keep pi-subagents' pre-spawn exited-target skip, or always run `/T /F`. Either unref timing is acceptable if it is listed.

**Design choices with no behavior change** 23. **sub-run-R1.** Do only the type step (about −100), or add the constrained RunContext (vetted −160, strict membership list). 24. **mcp-core-R3.** Drop the `makeMcpServiceLayer` split, which makes the source change about −22 instead of +4. Or keep it, returning `{layer, internals}`. 25. **mcp-core-R1 naming.** Rename `schema-policy.ts` or name the new file `schema-rules.mjs`. Decide this together with mcp-core-R2's optional move to `validation/bounded-json.ts`. 26. **E-rpc optional model-catalog port.** Keep sub-boundary-host-git-3, the default. Or port the catalog as its own change (about −85). The port reverses cb55216 and makes -3 moot. 27. **Test kits.** Use the narrowed X-tests-R1/R2 scope (about +120 source), or the full kits (+540). The conformance runner and the full fake Pi host return only if a migrated file shows a net saving.

**Disputed structural proposals (not counted)** 28. **sub-run-R2.** Take the no-module salvage (−72), which is the line-level set already in 1.3: sub-run-rest-3 with -core-5, and sub-run-core-3, -4, -10 and -13. Re-measure the last four first. Or adopt `run/transitions.ts` (−45), which makes those six superseded. 29. **mcp-ui-R1.** Take steps 2–3 as a correctness change (−50/+8), which unifies three edge rules; then skip mcp-tools-results-5 part (c). Or skip it. 30. **background-task-R2.** Take only the small hardening, which B1 already is: a read-once `containThenable`, `invokeBestEffort` and a handshake codec. Or take the shared module. X-boiler-2's shared host listener and mcp-tools-results-7's `Predicate.isPromiseLike` swap lose either way.

**Disputed or split line-level findings (not counted)** 31. **ask-user-4.** Use thunk-form `Effect.try` in four swallowed cleanups (−19 to −27), or keep the effect-v4.md boundary-error convention. 32. **codemode-tools-14.** Remove the test-only `ResultsContract.clear` and `CumulativeOutputBudget.used` (−4/−10), or keep them. 33. **herdr-btw-14.** Keep parts (i) and (ii) (about −4) for one session-ID grammar, or skip it. 34. **X-dup-8.** Move the provider usage config into core (−20), add only a type-only `SubscriptionUsageConfig` (−6), or leave it; core's docs say providers own it. 35. **previews-diff-syntax-16.** Add a shared owned-projection slot now (−4 to −10), or only alongside other write-projection cleanup. 36. **mcp-auth-4 and mcp-ui-manager-2.** mcp-auth-4 is contract tidying that is flat in LOC; mcp-ui-manager-2 nets −4. Take them for tidiness, or skip. 37. **Below the bar.** Skip sub-tools-exec-ui-6, sub-backend-20 and sub-supervisor-writer-10. Do not apply sub-boundary-host-git-18, which fails `effect:diagnostics`. 38. **Herdr environment key lists.** Keep them package-owned, or share them through core.

**Conflicts between line-level findings** 39. **core-rest-3 vs codemode-ui-rest-6.** Drop `resolveCommittedConfig`'s `committedScope`. Or keep it so Code Mode commits to the user-chosen scope, and drop that part of core-rest-3. 40. **B3 vs codemode-tools-11.** Alias `decodeOption` to the Exit-based core helper, so hostile getters return undefined. Or keep it Option-based, which is compatible with tools-11 and saves about 5 fewer lines. 41. **E1 design.** Use the shared keybinding adapter (counted), or X-shared-6's label-only signature change (about 24 lines; 2 test assertions change). 42. **T-codemode-a-8 vs b-8.** Keep the retained/malformed read checks in presentation-conformance (a-8), or in expanded-code-mode (b-8). 43. **T-ui-12.** Delete the real-filesystem test, which is the verifier's direction and keeps the only zero-I/O check. Or delete the I/O-recorder test. 44. **Process-liveness helper for pid ≤ 0.** Return false, which stays quiet inside `finally`, or throw. 45. **Live MCP transport coverage.** Keep one live smoke test per transport after T-mcp-boundary-8, -15 and T-mcp-connection-discovery-8, or rely on the fakes.

Already resolved, for reference: mcp-core-R2 beats mcp-tools-results-9; X-tests-R1 beats T-previews-tools-2 (40 lines remain); sub-settings-R1 beats sub-settings-rest-15's rename (its counted 9 lines survive); X-tests-R2 beats T-small-14; code-mode-R3 and the X-tests kits beat T-codemode-a-3 and -a-9.

## Behavior changes to know about

Some accepted items change something observable, however small. Each is listed below on one line. "Fix" marks a latent bug the change removes.

**Structural refactors**

- **E-footer:** third-party `kind: "surface"` footer upserts are ignored. `/cosmic-ui` loses the inert Media placement row, and a stale `footer.mediaPlacement` key is ignored. pi-cosmic-ui/protocol loses its surface types and the `"media"` region, a compile-time break. Protocol events and `invalidate()` now apply synchronously, so renders come slightly sooner. Invalidates no longer evict a pending pre-session upsert (fix).
- **ui-R3:** the working row ticks from the shared pool, so updates can lag by up to 1 s and one duplicate write is possible. Deactivation clears the row synchronously, idle disposal no longer clears it (Pi resets it), and a replacement clear targets the current context. A successful resume after an unavailable write keeps ticking; today the row freezes (fix).
- **sub-infra-R1:**
  - Leases move to a v3 on-disk format. A leftover v2 slot needs one-time manual recovery, and old and new sessions exclude each other only one way.
  - Conflict messages stop naming the other run, session and pid, and normal releases leave no tombstone.
  - A failed mark, or ENOSPC/EIO at release, quarantines the pool until restart.
  - An unsafe root mode is rejected instead of chmod-repaired, and EPERM liveness reads as live.
  - The crash window between mkdir and the evidence write closes.
- **providers-R1:**
  - xAI stops refreshing and writing auth.json itself. Pi's locked refresh takes over, which removes a lost-update and double-refresh race (fix).
  - A 401 on an unexpired xAI token re-resolves once and retries only with a changed token.
  - A failed Pi refresh shows a sanitized failure. For OpenAI this is "Unable to read openai-codex credentials.", where today it is often Missing.
  - There is no file fallback, even for a stale `ctx.modelRegistry`. `authSource` leaves the projection and debug output.
- **E-sup:**
  - Delegated Herdr Pi uses one authenticated loopback socket instead of a helper process, and acks follow `pi.sendMessage`.
  - Claude and Codex never see the Pi proxy, even with a spoofed clientInfo.
  - The error text for failed supervisor calls changes.
  - New failure mode: a 5–10 s event-loop stall ends the delegated Pi's supervisor channel.
- **E-rpc:**
  - Codex errors with numeric codes fail closed at once instead of stalling for 10 s (fix).
  - Server requests, foreign ids and non-envelope JSON fail closed instead of being ignored.
  - `initialized` drops `params: {}`, and the cleanup warnings go away.
  - stderr over 32 KiB no longer fails the session. The queue bound grows from 1 to 8 MiB.
  - When signalling fails, the worst-case `cleanup_unconfirmed` report takes about 4.1 s instead of about 2 s.
- **E-surface:** closing `/tasks`, the `/subagents` fleet, the proxy fleet, the profile dashboard or `/code-preview-health` no longer pops an ask-user dock stacked above and leaves a zombie overlay (fix). A late factory gets an inert component.
- **code-mode-R1 (replay of old transcripts only):**
  - v1 records from 09-16 to 09-18 become uncertain, if approved.
  - MCP-era failed or cancelled runs lose their MCP warning and recovery lines, and count-less 08-12 records show only their visible rows.
  - An injected `mcpEvidence` no longer downgrades a current record.
  - A malformed current ledger reports through the v2 path, so labels change from "outer" to "code-mode".
  - A tampered `totalToolCalls` no longer marks details inconsistent.
- **core-R2:** pi-background-task reads project and global config concurrently, and its recovery-log wording and span names change. The removed core exports break external TypeScript users.
- **mcp-core-R1:** six schema faults that the helper already rejects are now rejected before process admission. For `tools.call`, `data.kind` becomes invalid-input and the diagnostic, compact line and activity kind change. For elicitation, only `data.kind` changes.
- **previews-render-R1:** a changed identifier whose changed middle shares a run of 3 or more graphemes gets one wider span per side. A one-sided multi-point edit becomes two-sided: `userabcName` → `userXabcYName`.
- **sub-settings-R1:** the discarded custom-UI result is `undefined` instead of `false`.
- **sub-settings-R2:** Pi rows' "(current)" marker follows the page's current selection, which is equal today.
- **sub-settings-R3:** the More menu becomes the shared selector: descriptions show after `?`, `l` `/` `?` are active, `q` closes only the menu, and an unavailable Delete is dimmed with a hint. Delete confirmation uses the dashboard dialog, and "Delete canceled." moves to the status line. A refresh no longer dismisses a pending delete.
- **sub-settings-R4:** Save-as-set becomes a plain dialog with a new toggle key and unified validation wording. At about 6 rows the input cannot be drawn.
- **code-mode-R2:** the rejected-summary edge case shows the Program once instead of twice (fix). A throwing policy capture renders with default timing, and the status view gains the read view's plain-text evidence fallback.
- **ask-user-R1:** a pre-aborted root `ask` is refused before it takes a queue ticket, id, Activity row or host call. A throwing `isCurrent` or unsubscribe yields unavailable for questionnaires too (fix). Precedence between simultaneous rejections may differ.
- **mcp-boundary-R1:** the byte-limit error now wins over the invalid-header error. HTTP rejects limit or protocol keys passed explicitly as `undefined`. The deadline starts microseconds later.
- **E-proctree:** a non-positive or undefined pid can no longer reach `process.kill(-pid)` (fix). On Windows only, pi-subagents sends SIGKILL to an interrupted helper, settles on `exit`, tolerates a throwing listener removal, and may unref at a different time.
- **sub-presentation-R2:** nested tool names such as `constructor` or `__proto__` return `proxy_request_invalid` instead of a TypeError defect (fix).
- **background-task-R3:** new `logs` details drop `events: []` and the duplicated truncation text. Details persisted before 2026-08-30 with oversized fields fall back to the original renderer. Oversized synthetic details report `overflow: false`.
- **mcp-core-R2:** byte accounting becomes exact, so results count about 1 byte more per container and near-limit config entries with long arrays may now pass. Locally built results must pass plain-prototype checks. Freezing is slower on huge inputs: 13 → 23 ms at 90k nodes.
- **providers-R2:** OpenAI apply rejections now warn, and a throwing factory or failing `custom` is contained. The missing-value wording aligns. The surface check becomes `mode === "tui"`, and diagnostics warn where OpenAI is silent today.
- **No observable change:** sub-run-R1, mcp-core-R3 and code-mode-R3. X-tests-R1 and X-tests-R2 add only published testing exports.

**Line-level findings**

- **B3:** values whose getters or proxy traps throw now decode to undefined at `decodeOption`'s sites and 10 inline sites, instead of throwing. pi-mcp host-code-mode raises its typed input error instead of a defect.
- **B1:** ask-user and subagents `respond` now contain thenables. The subagents relay swallows a throwing `respond` that Pi's bus used to log. Queries decode before the `current()` check, and an empty session id is rejected.
- **E1:** the pi-mcp manager, the auth panel and the subagents proxy fall back to the default key label on a host without `getKeys` (fix; today they throw).
- **G1:** pi-mcp activity and auth flow notify a snapshot of their listeners. This differs only when a listener subscribes another during delivery.
- **ui-manager-5:** a directly constructed `VimSettingsAdapter` always treats `/` as search.
- **Published removals with no workspace user:** ui-manager-1, -4, -6 and ui-activity-app-6; previews-tools-13; `QuestionnaireQuery` (B1); core-rest-3, -5, -6, -7, -8, -10 and core-platform-1, -11, -13, including core-rest-5's exported reset-style default.
- **mcp-auth-2:** a simultaneous expiry and revocation may report stale before expired.
- **codemode-ui-rest-10:** a Proxy whose `has` and `get` traps disagree about `then`, or a throwing `Date.now`, now surfaces on the render path.
- **herdr-btw-3, herdr-btw-5:** failure paths skip `getSessionFile` and stat calls they no longer need.
- **herdr-btw-8:** a child id injected through the test seam now fails as `herdr_btw_child_create_failed`, after the pane split.
- **D2, D3, sub-settings-rest-9, sub-settings-workspace-9, previews-shell-config-6:** frozen snapshots may drop or add explicit `undefined` keys, or share one frozen object. Nothing in the workspace observes this.
- **Test-only:** T-mcp-boundary-4 reports darwin-only tests as skipped on other platforms. T-background-task-15 adds a published `fakeActivityHost` testing subpath to pi-cosmic-ui.

## How to use the detail files

- **Start here.** Each roadmap batch names its ids; look up each id in the detail files before editing. Line numbers there refer to HEAD `1a866fa`, so re-check them first.
- **[structural-refactors.md](structural-refactors.md)** covers the 28 refactors in rank order. Each entry has:
  - the problem and the target design;
  - behavior and convention changes;
  - **reviewer-required changes**, which are mandatory conditions, not suggestions;
  - migration steps.

  The report also has these sections:
  - **Needs a decision**, which covers the disputed proposals and the open-decisions table.
  - **Rejected**, which lists ideas that should not be re-proposed.
  - **Small cleanups made moot or dependent**, which lists the files to leave alone until each refactor lands.

- **line-level/\*.md** is one file per review shard. Each finding has locations, the proposal, LOC, risk, effort, and why behavior holds. Each file starts with its dedup notes and ends with its own "Needs a decision" section. Shard LOC figures are gross; the totals and roadmap above already remove subsumed and superseded findings. The files:
  - [cross-package](line-level/cross-package.md): entries A1–H2, each merging X-dup, X-shared and X-boiler findings.
  - [pi-cosmic-core](line-level/pi-cosmic-core.md), [pi-cosmic-ui](line-level/pi-cosmic-ui.md).
  - [pi-subagents-src-exec](line-level/pi-subagents-src-exec.md): backends, Herdr, process transport, supervisor and writer lease.
  - [pi-subagents-src-app](line-level/pi-subagents-src-app.md): settings, config, run and tools.
  - [pi-subagents-tests](line-level/pi-subagents-tests.md).
  - [pi-mcp-src](line-level/pi-mcp-src.md), [pi-mcp-tests](line-level/pi-mcp-tests.md).
  - [pi-code-mode](line-level/pi-code-mode.md), [pi-code-previews](line-level/pi-code-previews.md).
  - [pi-ask-user](line-level/pi-ask-user.md), [pi-background-task](line-level/pi-background-task.md), [pi-better-openai](line-level/pi-better-openai.md).
  - [pi-better-xai-dirmodels-herdr-btw](line-level/pi-better-xai-dirmodels-herdr-btw.md): pi-better-xai, pi-directory-models and pi-herdr-btw.
- **Short ids.** Some shards shorten test ids:
  - `T-4` in pi-background-task means T-background-task-4, and `bt-3` means background-task-3.
  - `T-1` in pi-ask-user's dedup notes means T-ask-user-1.
  - `run-3`, `ws-1`, `rest-13`, `profiles-config-3` and `herdr-supervisor-13` in pi-subagents-tests mean T-sub-run-3, T-sub-tools-ui-ws-1, T-sub-rest-13, T-sub-profiles-config-3 and T-sub-herdr-supervisor-13.
- **Merged entries.** Where a shard merged findings (for example "sub-settings-rest-11 + sub-settings-workspace-4"), land them as one change.
