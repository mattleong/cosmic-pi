# First pilot, 2026-09-08

Completed 48 model-backed sessions with `openai-codex/gpt-6-astra`, medium effort,
using Pi 0.85.1. Eight development sessions preceded forty held-out sessions. Both
variants kept Code Mode available. The candidate changed only its selection guidance.
No held-out tuning or model reruns occurred.

## Held-out results

Each variant ran twenty sessions, sixteen eligible and four negative controls.

| Metric                              | Baseline | Candidate |                    Change |
| ----------------------------------- | -------: | --------: | ------------------------: |
| Raw Code Mode calls                 |       25 |        33 |                      +32% |
| Eligible episodes using Code Mode   |    16/16 |     16/16 |               No increase |
| Correct answers                     |    20/20 |     20/20 |    No observed regression |
| Negative controls using Code Mode   |      0/4 |       0/4 |                 No change |
| Model turns                         |       74 |        67 |                     -9.5% |
| Median episode duration             |  14.10 s |   12.04 s |                    -14.6% |
| Model-visible tool-result bytes     |    7,999 |    60,430 |       7.55 times baseline |
| Total tokens, including cache reads |  245,129 |   254,700 |                     +3.9% |
| Estimated provider cost             |   $1.063 |    $1.269 |                    +19.4% |
| Failed Code Mode calls              |        2 |         2 |                 No change |
| Truncated Code Mode outputs         |        0 |         1 | One additional truncation |

No containment violations, native truncations, or cleanup failures were observed.
Across eligible matched pairs, raw calls increased in six pairs, decreased in one,
and stayed equal in nine. The small paired sample does not establish a reliable
improvement across models or repositories.

## Decision

The raw-call target exceeded 10% in this sample. The predeclared adoption target did
not pass: the baseline already adopted Code Mode on every eligible episode. More
calls did not mean broader adoption, and the output/cost regressions argue against
promoting this candidate. Production guidance remains unchanged.

The next experiment should target output reduction and useful work per call, or
measure adoption on a separately declared, broader task distribution. Do not tune
on these held-out tasks and then call them held-out again. Shell/edit workflows
remain unmeasured because this pilot enforced read-only fixture access.

## Evidence

Local aggregate artifacts: `/tmp/code-mode-eval.Gs43rN/results/`. This directory may
be removed by temporary-file cleanup. It contains no raw conversation or tool output.
Provider estimates total $2.832 for the 48 evaluation sessions only, not subscription
charges or the implementation/review work.

Frozen manifest digests:

- Tasks: `7fdee44ef4192a7a04b78a4cf9d3fd9a10ce603344a22c4c4c953ff067997534`
- Production controller: `97faaf9dc4411777b677901f75f13879970f1763f4d617727098cf05ad6d4ce9`
- Candidate guidelines: `50c5a66fa5c579f401325cd3eb73b5dd5860c85ac61d2248798cbf0366d98c68`

The running pilot loaded the original standalone SDK runner. During execution, its
host orchestration was migrated to Effect to satisfy workspace validation. The
fixture, guidance, schedule, and scoring definitions stayed frozen. The migrated
runner passed deterministic lifecycle and containment tests; it has not consumed an
additional model-backed pilot budget.
