# Wording efficiency benchmark

The approved 24-session pilot is complete. See [results](WORDING-RESULTS.md). This cohort is now
exposed; the command below is for regression replay, not a fresh confirmation or a new budget.

This compares the previous first `promptGuidelines` entry with the experimental wording that
was applied during measurement. Production in `src/tools/controller.ts` has since been restored
to the previous guideline. `wording.ts` freezes both complete guidance snapshots and accepts
either known production state, but refuses unrelated guidance drift. Evaluation sessions apply
their selected snapshot without changing production. Only the first entry changes between arms. Compact JSON formatting, all other guidance, the model,
medium effort, tool definitions, limits, and fixture restrictions stay identical. Neither
historical experimental candidate is used. No production runtime behavior changes here.

## Frozen plan

The approved pilot has **24 model-backed sessions**: six fresh tasks, two repetitions per task,
two arms per repetition. All are confirmation runs. There is no model-backed development or
prompt tuning. Arm order alternates per task and repetition. The runner also supports a
separately approved 48-session plan with four repetitions, but this pilot must not be extended
based on its results. Failed attempts consume the cap. No automatic reruns.

| Task | Work and oracle                                                                                      |
| ---- | ---------------------------------------------------------------------------------------------------- |
| WB1  | Four known-schema inventory reads; enabled count, test total, sorted IDs                             |
| WB2  | Manifest, referenced index, then selected data files; selected count and score total                 |
| WB3  | Required IDs versus attestations; checked and verified counts, sorted missing IDs                    |
| WB4  | Sparse literal-prefix extraction; all complete matching lines, relative paths, physical line numbers |
| WB5  | One short file returned in full as a JSON string, including its final newline                        |
| WB6  | Two proposal metadata files; report both options and the need for approval, without reading details  |

WB1 through WB4 are the efficiency cohort. WB5 and WB6 are controls. Schemas, output fields, ordering,
path conventions, and line-number conventions are explicit. Fixtures stay below native and
Code Mode truncation limits. Tests independently recompute each oracle from the fixture data.
WB6 blocks detail-file access and ancestor-directory content searches before dispatch in both
routes, including canonical aliases. An attempted violation invalidates the run even if the
final answer looks correct. This tests an explicit checkpoint, not general judgment quality,
real approval UI, or production mutation safety.

## Measures and decision

`turns` counts finalized assistant messages, including the final answer and recovery work.
It is a round-trip proxy, not a count of proven missed batching opportunities. A successful
one-tool-round answer normally takes two such turns on these fixtures. If the baseline is
already at that floor, report it rather than changing the objective.

The primary target, frozen in `wording-score.ts`, is at least 10% fewer eligible model turns
in total and at least 10% mean paired proportional reduction. Average repetitions within
each task, then weight the four tasks equally. Report each pair's raw turn difference too.
More Code Mode calls, nested calls, or adoption cannot satisfy this target.

A passing pilot also requires:

- Every unique scheduled pair present, with the declared task identities and cohort assignments.
- Every answer correct in both arms, with actual successful file-tool work.
- Zero completion, cleanup, containment, mutation, wrapper, nested-tool, direct-tool, or truncation failures.
- At most 10% growth in all-route tool-result bytes and total tokens, including cache reads and writes.
- At most 25% growth in output tokens and median latency. No increase in outer tool calls.
- The same work guards on controls separately, plus no increase in their model turns.

Count all attempts. Do not discard failed or slow runs. Report output bytes, input/output/cache
tokens, outer calls, Code Mode calls, nested work, latency, and estimated cost alongside turns.
Cost estimates are not subscription charges. This small synthetic read-only pilot cannot
establish statistical significance or general coding-agent performance. It does not alter
production wording automatically, whatever the outcome.

## Run and artifacts

```sh
pnpm --filter pi-code-mode eval:pilot --run --experiment=wording \
  --provider=openai-codex --model=gpt-6-astra \
  --out=/absolute/new/directory --max-sessions=24
```

Run under a process supervisor with an outer deadline. Each arm first passes a no-inference
SDK/interpreter check that also verifies its actual system-prompt wording. The manifest is
written before these checks and before reserving any model attempt. It records both changed
strings, configuration, hashes, gates, and the complete schedule. The output directory must
not exist. Attempts are reserved before session creation and never refunded.

`report.json` has one `comparison` instead of development and held-out subsections. Records
retain bounded mismatch locations from the trusted synthetic oracle, such as `/missing/0` or
`/<extra-key>`, but never actual answer values or unexpected key names. No transcripts,
thinking, credentials, or tool contents are retained. Scope, cleanup, and containment rules
are shared with the [evaluator protocol](README.md).

After this pilot, this cohort is exposed regression material. Do not use it to tune the wording
or claim a fresh confirmation, and do not expand the approved session cap to chase a pass.
