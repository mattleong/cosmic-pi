# Code Mode efficiency results

We retained compact JSON formatting and restored the original tool-selection guidance.
The completed evaluator, fixtures, scorers, and experiment-only tests have been removed from
active code. Production formatting, limits, cancellation, and lifecycle tests remain.

## Completed experiments

All four pilots used Pi 0.85.1, `openai-codex/gpt-6-astra`, and medium effort on synthetic
read-only tasks. The first two each had 8 development and 40 held-out sessions. The latter two
each had six fresh tasks, two arms, and two repetitions, with four target tasks and two controls.

| Experiment        | Date       | Sessions | Finding and decision                                                                                                                |
| ----------------- | ---------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------- |
| Adoption guidance | 2026-09-08 |       48 | Eligible adoption was already 16/16 in both arms. More Code Mode calls increased output and estimated cost. Rejected.               |
| Output guidance   | 2026-09-08 |       48 | Reduction-task tool bytes fell 80.9%, but generated output tokens rose 27.7%; correctness and work gates failed. Rejected.          |
| Workflow wording  | 2026-09-09 |       24 | Target turns rose from 18 to 20; task-balanced turns rose 12.5%. All answers were correct, but efficiency targets failed. Reverted. |
| Compact formatter | 2026-09-09 |       24 | All answers were correct and the frozen token/byte gates passed. Compact formatting retained.                                       |

## Formatter evidence

The formatter removes serialization whitespace from structured values. Strings and logs remain
unchanged, and execution still applies the configured final UTF-8 limit. An earlier deterministic
replay reduced bytes by 21.3%; that was not a whole-session token or latency measurement.

The later model-backed comparison measured the following across all 12 episodes per arm,
including controls. Total tokens include input, output, cache reads, and cache writes.

| Measure                | Historical pretty |   Compact | Change |
| ---------------------- | ----------------: | --------: | -----: |
| Correct answers        |             12/12 |     12/12 |   None |
| Total tokens           |            98,827 |    92,222 |  −6.7% |
| Tool-result bytes      |            20,949 |    15,375 | −26.6% |
| Estimated cost         |         $0.875734 | $0.770300 | −12.0% |
| Median episode latency |          20.437 s |  21.265 s |  +4.0% |

On target tasks, aggregate tokens fell 9.6% and the task-balanced paired mean fell 7.1%.
Re-rendering the same observed values under both policies reduced bytes by 18.3%, separating
serialization savings from differences in model-selected programs.

The larger aggregate token gain was partly driven by one extra baseline call. Two tasks showed
roughly 4% token savings in both repetitions. Cache-read share differed between arms, so the cost
figures are estimates, not attributable billing savings or subscription charges. Latency did not
improve consistently. Both formatter arms used the experimental wording that was applied at
measurement time; production wording was restored afterward.

These small pilots do not establish statistical significance or general coding-agent performance.
All cohorts are exposed. Any new model-backed confirmation needs fresh tasks and an approved
budget; the completed budgets do not authorize reruns.

## Historical archive

The full benchmark code, protocols, fixtures, tests, and detailed reports are preserved at commit
[`fc1669cf654c1c463814d3e94d0184639e6925fe`](https://github.com/mattleong/cosmic-pi/tree/fc1669cf654c1c463814d3e94d0184639e6925fe/packages/pi-code-mode/eval).
That archive includes these reports under `packages/pi-code-mode/eval/`:

- `RESULTS.md`
- `OUTPUT-RESULTS.md`
- `WORDING-RESULTS.md`
- `FORMATTER-RESULTS.md`

The reports record measurement-time hashes and limitations. Temporary local run artifacts are
not a durable archive. No model-backed sessions were launched for this cleanup.
