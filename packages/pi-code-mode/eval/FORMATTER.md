# Formatter end-to-end benchmark

The approved 24-session pilot is complete. See [results](FORMATTER-RESULTS.md). This cohort is
now exposed; the command below is for regression replay, not fresh confirmation or a new budget.

This isolates the applied compact-JSON formatter from the historical pretty formatter in
`29b4dab`, before `e0e5f90`. The historical algorithm pretty-prints non-string values when the
value alone fits the output budget, otherwise uses compact JSON. Both versions preserve
strings and logs. Execution applies the same final UTF-8 clamp afterward.

The package-private `formatSuccess` dependency receives the original successful runtime value,
logs, and resolved budget before clamping. Live application registration supplies no override.
Both evaluation arms use the same observer, which computes both renderings and returns the
selected one. It retains only numeric counts and byte lengths. No displayed-text parsing or
post-clamp reconstruction is used. Failures, cancellation, runtime limits, and output-kind
metadata remain under production execution ownership.

## Frozen comparison

The approved budget is **24 model-backed attempts**: six fresh tasks, two repetitions, two arms.
All runs are confirmation runs, without model-backed development or tuning. A fixed-seed shuffle
of task blocks uses seed `20260909`. Arms run adjacently; each task has each arm first once.
The existing 48-session option requires separate prior approval, not extension after results.
Failed attempts consume budget, with no episode reruns.

Guidance is identical in both arms and matches production at measurement time, including the
experimental first guideline. Production has since reverted that guideline. Evaluation-only
replays explicitly apply the frozen measurement-time guidance in both arms, not current production
defaults. Neither older adoption/output prompt candidate is used. Model, medium effort, fixtures,
tools, configuration, and limits are also identical. Both arms first pass a structured
no-inference SDK/interpreter probe that checks exact rendered text and actual prompt guidance.

| Task | Required result                                                                            |
| ---- | ------------------------------------------------------------------------------------------ |
| FC1  | Complete multi-group receipt rollup, including groups with zero approvals                  |
| FC2  | Capability-bundle audit, including missing grants and empty requirements                   |
| FC3  | Every scheduling overlap, excluding touching endpoints and empty intervals                 |
| FC4  | Complete public release export with nested arrays, nulls, and whitespace-sensitive strings |
| FC5  | Minimal single-read queue-name answer                                                      |
| FC6  | Exact JSON-looking document, including tabs, escapes, and final newline                    |

FC1 through FC4 form the target cohort; FC5 and FC6 are controls. All schemas, output fields,
ordering, and edge-case rules are explicit. Tests independently recompute the oracles. Nothing
mandates Code Mode, an object return, a prewritten program, or an internal serialization style.
A final JSON answer does not establish that the formatter was exercised.

## Metrics and decision

The primary end-to-end target is at least **2% fewer whole-session tokens** on the target cohort,
both in aggregate and in the task-balanced paired mean. Tokens include input, output, cache
reads, and cache writes across every route and recovery turn. Average paired proportional
reductions within each task, then weight the four tasks equally.

The mechanism target is at least **10% fewer all-route tool-result bytes**, using the same two
summaries. Byte savings without the token target receive `bytes-only`, not an end-to-end gain.
Report every pair and all control results, without selecting only successful or exposed runs.

Require complete, unique scheduled identities; correct, completed answers and successful file
access in every episode; zero wrapper, direct-tool, nested-tool, access, mutation, cleanup, or
truncation failures. Neither same-value rendering may hit the final clamp. At least half of
target episodes in each arm must contain an actually byte-changing formatter call. Otherwise
report insufficient exposure. Scalars, empty containers, string returns, and direct-tool bypass
remain in the primary denominator.

No increase in model turns or outer calls is allowed. Output-token growth is capped at 10%,
median latency growth at 25%. Controls receive the same guards, plus at most 10% token and
all-route byte growth. `pilot-token-benefit` requires both targets and every guard.

Record actual structured/string return counts and the two clamped byte lengths for each observed
value. This distinguishes causal serialization savings from differences in model-selected
programs. Report estimated cost, latency, and input/cache/output token components separately,
including cache use by arm and pair order. Fresh sessions do not imply cold provider caches.
The symmetric observer adds serialization work to both arms, so this is not a formatter CPU
microbenchmark. Cost estimates are not subscription charges; latency and cost alone do not
establish a gain. A 24-session synthetic read-only pilot is not statistical proof or a general
coding-agent performance estimate.

## Run and retention

```sh
pnpm --filter pi-code-mode eval:pilot --run --experiment=formatter \
  --provider=openai-codex --model=gpt-6-astra \
  --out=/absolute/new/directory --max-sessions=24
```

Use a process supervisor with an outer deadline. Existing attempt reservation, containment,
private configuration, session cleanup, and redacted artifact rules apply. The manifest stores
both formatter identities, the comparison-source hash, production controller hash, task hash,
schedule seed, gates, and plan before inference. Replay manifests also store effective guidance
for both arms, since production wording no longer matches the measurement-time snapshot. Reports use one `comparison` section.
No raw values, logs, tool contents, thinking, transcripts, or credentials are persisted.

Once run, this cohort is exposed regression material. Do not tune against it or expand the
budget to chase a favorable result. This benchmark does not automatically change production.
