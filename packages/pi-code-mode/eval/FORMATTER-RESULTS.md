# Formatter benchmark results

Compact JSON showed an end-to-end token benefit in this pilot, with all 24 answers correct.
The frozen verdict is `pilot-token-benefit`. Estimated cost decreased, but cache usage differed;
latency did not improve consistently. These results support keeping compact formatting, not the
separate wording change.

## Run

- 2026-09-09, Pi 0.85.1, `openai-codex/gpt-6-astra`, medium effort.
- 24 approved model-backed attempts, 24 completed records, 12 unique pairs, no episode reruns.
- Six fresh tasks, two repetitions per arm, seed `20260909`, adjacent balanced arm order.
- Only formatting differed. Both arms retained the same production wording at measurement time,
  model, tools, limits, and fixtures. The historical pretty renderer included its compact fallback.
- Merge preparation later restored the previous production first guideline. Historical replays
  retain the measurement-time wording in both arms; no results or recorded hashes were rewritten.
- Protocol and frozen thresholds: [FORMATTER.md](FORMATTER.md).

## Complete cohort

Twelve episodes per arm, including the four control episodes. Total tokens include input,
output, cache reads, and cache writes.

| Measure                | Historical pretty |   Compact | Change |
| ---------------------- | ----------------: | --------: | -----: |
| Correct answers        |             12/12 |     12/12 |   None |
| Total tokens           |            98,827 |    92,222 |  −6.7% |
| Tool-result bytes      |            20,949 |    15,375 | −26.6% |
| Model turns            |                26 |        25 |  −3.8% |
| Outer calls            |                14 |        13 |  −7.1% |
| Code Mode calls        |                10 |        10 |   None |
| Estimated cost         |         $0.875734 | $0.770300 | −12.0% |
| Median episode latency |          20.437 s |  21.265 s |  +4.0% |

There is no consistent speedup claim: the full-cohort median increased, although target-only
and control-only medians decreased. The combined estimated evaluation cost was $1.646034,
not a subscription charge.

## Target cohort and frozen decision

Eight episodes per arm across the four structured-report tasks.

| Measure                | Historical pretty |   Compact | Change |
| ---------------------- | ----------------: | --------: | -----: |
| Correct answers        |               8/8 |       8/8 |   None |
| Total tokens           |            69,688 |    63,028 |  −9.6% |
| Tool-result bytes      |            20,521 |    14,922 | −27.3% |
| Model turns            |                17 |        16 |  −5.9% |
| Output tokens          |             5,214 |     5,129 |  −1.6% |
| Estimated cost         |         $0.711904 | $0.602736 | −15.3% |
| Median episode latency |          25.893 s |  25.036 s |  −3.3% |

The task-balanced paired mean was 7.1% fewer tokens and 20.4% fewer tool-result bytes. Both
aggregate and paired-mean targets passed, as did correctness, exposure, execution, work, and
control guards. All recorded error, access, mutation, cleanup, and truncation counts were zero.
There were no pretty-budget fallbacks or final-clamp cases.

| Task                     | Repeat | Pretty tokens | Compact tokens |
| ------------------------ | -----: | ------------: | -------------: |
| FC1, receipt rollup      |      0 |         8,389 |          8,032 |
| FC1                      |      1 |         8,380 |          8,020 |
| FC2, capability audit    |      0 |         7,781 |          7,465 |
| FC2                      |      1 |         7,817 |          7,509 |
| FC3, scheduling overlaps |      0 |        12,965 |          7,769 |
| FC3                      |      1 |         7,772 |          7,656 |
| FC4, release export      |      0 |         7,813 |          8,762 |
| FC4                      |      1 |         8,771 |          7,815 |

The receipt and capability tasks each showed roughly 4% token savings in both repetitions.
The larger aggregate gain needs caution: FC3 repeat 0 used two Code Mode calls in the baseline
versus one with compact formatting. That pair contributed 5,196 of the 6,660 fewer target tokens.
It is not evidence that whitespace removal itself caused the extra baseline call. Programs and
reasoning were not retained, so the cause of the extra call is unknown.

FC4 had one structured-return episode and one string-return episode in each arm, with their
positions reversed between repetitions. Its total tokens were almost unchanged. All string and
bypass episodes stayed in the primary denominator.

## Direct formatter evidence

Seven of eight target episodes in each arm had an actually byte-changing formatter call.
The baseline had eight structured calls and one string call; compact had seven structured calls
and one string call. Every Code Mode success was accounted for by the formatter counters.

Re-rendering the same actual target values and logs through both policies produced **39,013
pretty bytes versus 31,866 compact bytes, an 18.3% reduction**. This numerical counterfactual
isolates serialization from differences in model-selected programs. It is distinct from the
27.3% difference between the two live arms and from the earlier fixed-fixture 21.3% replay result.
No raw values or logs were retained.

All four control episodes passed in both arms. Control tokens rose 0.2% and tool-result bytes
5.8%, within the frozen allowances. No control call was byte-changing under the formatter.
Whitespace-sensitive document contents, escapes, tabs, and final newlines remained correct.

## Cache and interpretation

Cache-read share of input, including cache reads and writes, was 39.5% for pretty and 47.2% for
compact across the full cohort. Target-only shares were 33.4% and 44.7%. Cost differences therefore
cannot be attributed solely to compact formatting. For example, FC4's estimated cost fell about
24.5% while its total tokens barely changed.

| Arm and position      | Sessions | Uncached input | Cache read | Output |
| --------------------- | -------: | -------------: | ---------: | -----: |
| Pretty, first in pair |        6 |         28,592 |     19,328 |  2,879 |
| Pretty, second        |        6 |         27,890 |     17,536 |  2,602 |
| Compact, first        |        6 |         24,850 |     20,480 |  2,848 |
| Compact, second       |        6 |         20,994 |     20,480 |  2,570 |

This is a small synthetic read-only pilot, not statistical proof or a general coding-agent
performance estimate. Both arms include symmetric observation overhead, so it is not a formatter
CPU microbenchmark. The practical evidence is modest, repeated token savings on two tasks plus
lossless same-value byte savings. The full-cohort cost and latency numbers remain descriptive.
No scoring or wording changes were made during the run, and no further model sessions followed.

## Artifacts and verification

Local artifacts are at `/tmp/code-mode-formatter-eval.PCrZnj/results/`, subject to temporary cleanup.
They contain the manifest, ordered attempt ledger, bounded numeric run metrics, and report.
No transcripts, thinking, model answer values, tool contents, logs, or credentials are retained.

The post-run audit confirmed all 24 planned identities in order, byte and return-kind partitions,
and unchanged source hashes:

- Controller: `f5a060e5c36550790ac8fd74e96f49cc7ce68c6c89a480d57212588794f2a176`
- Production formatter: `a065a9b9fc01f987b0a161f74aa440f23e895a18f9aad640ffc5f4cf2071a114`
- Comparison implementation: `d712f278b5a40613cb3cc9d4e17e2e2a7007a09276d2630eae26831d7775b6b0`
- Tasks: `5d35f551f0001783165c3f55bd8fdcf726084811ff347942c4ed8964cd4ca404`

All 176 package tests, package checks, and `pnpm validate` passed before launch. Both real SDK
formatter probes passed without inference. This cohort is now exposed regression material;
do not retune against it or rerun it as fresh confirmation.
