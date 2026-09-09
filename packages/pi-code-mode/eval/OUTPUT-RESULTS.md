# Smaller-output results, 2026-09-08

## Guidance experiment: not promoted

Completed the approved 48 model-backed sessions using `openai-codex/gpt-6-astra`, medium
effort, and Pi 0.85.1. Eight development sessions preceded forty held-out sessions. Guidance,
fixtures, limits, and gates stayed frozen throughout execution. Production still used its
original pretty-JSON formatter during this pilot.

Each held-out arm contained sixteen reduction episodes and four full-content controls.

| Reduction-task metric           | Baseline | Candidate |
| ------------------------------- | -------: | --------: |
| Model-visible tool-result bytes |  219,239 |    41,923 |
| Correct answers                 |    14/16 |     15/16 |
| Code Mode calls                 |       21 |        28 |
| Failed Code Mode calls          |        0 |         3 |
| Outer tool calls                |       69 |        71 |
| Model output tokens             |    7,070 |     9,028 |
| Median duration                 |  27.37 s |   28.73 s |
| Estimated provider cost         |   $1.776 |    $1.607 |

Observed tool-result bytes fell **80.9%**. Median task-level reduction was **54.5%**, and
all eight task groups returned fewer bytes. Total tokens including cache reads fell 8.9%.
These are descriptive results, not a passing causal or statistical claim.

| Task                          | Baseline bytes | Candidate bytes | Reduction |
| ----------------------------- | -------------: | --------------: | --------: |
| Ordered policy audit          |          5,030 |           3,200 |     36.4% |
| Latest-job reconciliation     |         51,730 |           1,868 |     96.4% |
| Release signing               |         57,122 |           4,421 |     92.3% |
| Active runbook contradictions |         67,938 |          15,318 |     77.5% |
| API compatibility             |          4,028 |           2,861 |     29.0% |
| Alias overrides               |         23,146 |           6,324 |     72.7% |
| Coverage gaps                 |          3,478 |           2,797 |     19.6% |
| Incident evidence             |          6,767 |           5,134 |     24.1% |

The candidate did not pass the frozen rollout rules:

- One candidate API-comparison answer failed its strict oracle. Both baseline repetitions
  of that task also failed, invalidating the efficiency comparison under the declared rules.
  The candidate did not lose any pair whose baseline answer passed, but the gate required
  every answer to pass. No answer contents or mismatch details were retained, so the cause
  of these checker failures is unknown.
- Useful adoption fell from 14 to 13 episodes under the predeclared definition requiring a
  correct answer and no failed Code Mode wrapper. Direct output bytes actually decreased;
  this was not evidence of data being shifted into direct tools.
- Model output tokens increased 27.7%, exceeding the 25% work allowance.
- All four full-content controls passed in each arm. Their bytes fell from 39,529 to 38,928,
  but candidate outer calls rose from seven to nine and total tokens rose about 25%, beyond
  the separate control work allowances.

No native or Code Mode truncations, containment violations, incomplete executions, or cleanup
failures were observed. The experimental guidance remains in `output-candidate.ts` only.
It was not applied to production.

Artifacts: `/tmp/code-mode-output-eval.D8E25V/results/`. Temporary cleanup may remove them.
The 48 evaluation sessions had a combined provider cost estimate of $5.282, excluding
implementation/review work and not representing a subscription charge.

Frozen manifest digests:

- Tasks: `8f51e93c09c9a5d6c2afd9dd511557a317a16655b61de4bcfb5f50c0914e8aef`
- Controller: `97faaf9dc4411777b677901f75f13879970f1763f4d617727098cf05ad6d4ce9`
- Candidate: `9bccef017d87edf5cc857f8bd080243e081b1dc9b803f2d40b6f732a8aebe9a3`

These tasks are now exposed regression material, not fresh held-out tasks for another tuning pass.

## Independent formatter change: applied

After the pilot finished, `src/tools/format.ts` was changed to serialize non-string successful
return values as compact JSON instead of expanding them with indentation. Returned strings
are untouched, including JSON-looking strings, source code, and verbatim documents. Log
contents, `outputKind`, runtime limits, and the final UTF-8 clamp remain unchanged. The UI
already accepts compact JSON and still accepts historical pretty JSON.

A deterministic replay using the fourteen fixture answer values compared the actual new
formatter against its previous pretty-when-it-fits behavior:

- Twelve structured values: **15,832 → 12,460 bytes, a 21.3% reduction**.
- Every parsed JSON value was identical.
- Both returned strings were byte-for-byte unchanged.

This is a serialization measurement, **not an end-to-end agent performance result**. The
formatter does not filter records or remove logs, and it cannot shrink strings the program
chooses to return. No additional model sessions were launched to test this separate change.
Unit tests cover lossless object/array/scalar serialization, whitespace-sensitive strings,
unchanged logs, and the existing execution-level UTF-8 limits.

Future pilot manifests also record the formatter digest, since controller guidance alone no
longer identifies the production output behavior.
