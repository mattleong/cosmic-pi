# Wording benchmark results

The new wording did not improve efficiency in this pilot. All 24 answers were correct, but
the multi-step cohort used more model turns and tokens. The frozen verdict is `target-not-met`.
Merge preparation restored the previous production guideline after both benchmarks completed.
Compact JSON formatting remains unchanged. The recorded results and hashes below describe the
original measurement, not the later rollback.

## Run

- Date: 2026-09-09. Pi 0.85.1, `openai-codex/gpt-6-astra`, medium effort.
- 24 approved model-backed attempts, 24 completed records, 12 unique pairs. No episode reruns.
- Six fresh tasks, two repetitions per arm. Four multi-step tasks and two controls.
- Only the first guideline differed. Both arms used the same compact formatter and limits.
- Source base: `e0e5f90`, plus the applied first-guideline change and evaluator additions.
- Protocol: [WORDING.md](WORDING.md). This cohort is now exposed regression material.

## Multi-step tasks

Eight episodes per arm. Total tokens include input, output, cache reads, and cache writes.

| Measure                                  | Previous wording | New wording | Change |
| ---------------------------------------- | ---------------: | ----------: | -----: |
| Correct answers                          |              8/8 |         8/8 |   None |
| Model turns                              |               18 |          20 | +11.1% |
| Outer tool calls                         |               10 |          12 | +20.0% |
| Code Mode calls                          |                8 |           9 | +12.5% |
| Eligible adoption                        |              8/8 |         8/8 |   None |
| File-tool dispatches, direct plus nested |               30 |          30 |   None |
| Model-visible tool-result bytes          |            3,335 |       5,689 | +70.6% |
| Total tokens                             |           60,932 |      68,435 | +12.3% |
| Output tokens                            |            1,296 |       1,286 |  −0.8% |
| Median episode latency                   |         12.929 s |    13.041 s |  +0.9% |
| Estimated cost                           |        $0.365096 |   $0.390190 |  +6.9% |

The task-balanced mean paired result was **12.5% more turns**, against a target of at least
10% fewer. No eligible pair improved. Six of eight baseline episodes already finished at the
two-turn floor, one tool round and one final answer.

| Task                            | Repetition | Previous turns | New turns |
| ------------------------------- | ---------: | -------------: | --------: |
| WB1, known-schema inventory     |          0 |              2 |         2 |
| WB1                             |          1 |              2 |         2 |
| WB2, manifest-driven reads      |          0 |              2 |         2 |
| WB2                             |          1 |              2 |         4 |
| WB3, attestation reconciliation |          0 |              2 |         2 |
| WB3                             |          1 |              2 |         2 |
| WB4, sparse text extraction     |          0 |              3 |         3 |
| WB4                             |          1 |              3 |         3 |

One WB2 candidate repetition accounts for the extra two turns. Its bounded result metadata
shows two direct reads before Code Mode. Filenames and program bodies were not retained, so
this does not establish why the agent split that work. WB4 accounts for 2,068 of the 2,354 extra
tool-result bytes; WB2 accounts for the other 286. We cannot reconstruct the returned contents.

Correctness, execution, access, and truncation guards passed in both arms. The efficiency
target failed, as did the outer-call, tool-byte, and total-token work guards. Output-token and
latency guards passed. Extra Code Mode calls did not represent more useful completed work.

## Controls and complete cohort

Both arms passed all four control episodes. WB5 preserved the complete file and final newline;
WB6 returned both options without premature detail access. Control turns fell from 9 to 8,
outer calls from 5 to 4, and total tokens from 29,631 to 26,442. Control work guards passed.
The one-turn saving came from the single-file task. Control Code Mode calls fell from 3 to 2.

Across all twelve episodes per arm:

| Measure           | Previous wording | New wording | Change |
| ----------------- | ---------------: | ----------: | -----: |
| Correct answers   |            12/12 |       12/12 |   None |
| Model turns       |               27 |          28 |  +3.7% |
| Total tokens      |           90,563 |      94,877 |  +4.8% |
| Tool-result bytes |            3,759 |       6,043 | +60.8% |
| Code Mode calls   |               11 |          11 |   None |
| Estimated cost    |        $0.521102 |   $0.587106 | +12.7% |

All recorded wrapper, nested-tool, direct-tool, containment, mutation, completion, cleanup,
and truncation failure counts were zero. Cost estimates depend on cache use and are not subscription charges.
The pilot's combined estimated cost was $1.108208.

## Interpretation and evidence

This small synthetic read-only pilot supplies no evidence of an efficiency gain. The observed
turn increase comes from one repetition, not a consistent penalty across tasks. Do not treat
the percentages as a general performance estimate or evidence of statistical significance.
No wording or scoring changes were made during the pilot, and no additional model runs followed.

Local artifacts are at `/tmp/code-mode-wording-eval.L0S5UN/results/`. They contain the manifest,
attempt ledger, bounded run metrics, and final report, without transcripts, answer values,
thinking, credentials, or tool contents. Temporary artifacts may be cleaned up later.

The post-run audit confirmed all 24 scheduled identities in ledger order, byte partition totals,
and unchanged production-source hashes. The manifest records:

- Formatter: `a065a9b9fc01f987b0a161f74aa440f23e895a18f9aad640ffc5f4cf2071a114`
- Controller: `f5a060e5c36550790ac8fd74e96f49cc7ce68c6c89a480d57212588794f2a176`
- Tasks: `93bca430929472b9ccc2d94180178c8017b931cc7ace649405b1d1ac82d65342`
- Candidate: `7fa2e85a059b15f620dae62f3fcd25e1fd88c690c2a8fa046f70ad050b90e527`

Before launch, all 163 package tests, package checks, and `pnpm validate` passed. The no-inference
preflight verified the real interpreter and actual system-prompt wording in both arms.
