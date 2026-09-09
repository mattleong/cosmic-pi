# Smaller-output pilot

This pilot is complete. See [results and the separate formatter change](OUTPUT-RESULTS.md).
Its tasks are now exposed regression material, not a fresh held-out cohort. Production gained
compact JSON formatting after the pilot; reruns therefore do not reproduce its original baseline.

The experiment compares current production guidance with `output-candidate.ts`. It keeps
selection and intent guidance, tool availability, execution limits, and the interpreter
unchanged. The candidate replaces the output guidance only. Production is not edited until
held-out results have been reviewed.

```sh
pnpm --filter pi-code-mode eval:pilot --run --experiment=output \
  --provider=openai-codex --model=gpt-6-astra \
  --out=/absolute/new/directory --max-sessions=48
```

The historical adoption experiment remains available as `--experiment=adoption`; it is not
the baseline for this test. Its previously inspected H1-H10 tasks are exposed and cannot
supply fresh confirmation evidence.

## Candidate and tasks

The candidate asks agents to choose the fields or excerpts they need before calling tools,
keep raw results inside the program, serialize selected structured results without indentation,
compute over full input after inspecting a small schema sample, and avoid logging intermediate data. Parse failures should return a bounded diagnostic
and relevant sample rather than dumping input. Required evidence and complete exports must
remain complete, including fetching missing or truncated input.

`output-tasks.ts` supplies three development reduction tasks and one full-content development
control. The confirmation suite has eight reduction tasks and two full-content controls,
with two repetitions per variant. Total allocation is eight development sessions and forty
confirmation sessions. The separate no-inference smoke fixture is not part of either split.

Confirmation tasks cover ordered access policies, latest-job reconciliation, release signing,
active runbook contradictions, API compatibility, alias overrides, coverage gaps, and sparse
incident evidence. Oracles require completeness counts and exact source evidence where the
request calls for it. Complete record export and verbatim document retrieval are controls,
not opportunities to discard output. Every file fits below unchanged native read bounds.
Independent deterministic checks recompute all confirmation oracles from fixture contents.

## Frozen decision rules

Primary measurement is **all model-visible tool-result text bytes**, including direct tools,
Code Mode, errors, and retries. Internal nested bytes are diagnostic only. Use all scheduled
reduction episodes, not just successful attempts.

`output-score.ts` requires:

- Complete, unique pairs and valid per-route byte accounting. The forty confirmation sessions
  contain sixteen reduction episodes and four controls per variant.
- Every candidate answer correct, with all requested evidence and complete control outputs.
- Every baseline answer correct. An incorrect baseline makes the comparison invalid rather
  than producing an apparent efficiency win.
- No containment, mutation, cleanup, or completion failure, and no native or Code Mode
  truncation in either arm.
- At least 15% lower aggregate reduction-task bytes and at least 10% median task-level reduction.
  Each task's repetitions are combined before its reduction ratio is calculated. A zero
  baseline denominator is undefined, not a win.
- No decrease in useful Code Mode adoption. Direct-result bytes may not grow by more than
  the larger of 1 KiB or 10% of baseline reduction-task bytes.
- No increase above 25% in outer calls or model output tokens, above 10% in total tokens
  including cache reads, or above 25% in median episode duration on reduction tasks.
- The same work and route-offload guardrails apply separately to the full-result controls.
  Controls need not shrink, but their total tool-result bytes may not grow by more than 25%.

Report each task's results, controls separately, estimated costs, and the all-run totals.
These gates screen a small pilot; they do not establish statistical significance. No task or
threshold changes, held-out retuning, or automatic replacement runs are allowed after launch.
A failed development validity gate stops the pilot. A failed confirmation gate prevents
promotion. No more than 48 model-backed attempts may start, including failed launches.

## Measurement and privacy

The byte counters partition total tool-result bytes into Code Mode and direct routes. They
must sum exactly. Each episode also retains its five largest tool results as metadata only:
ordinal index, tool name, byte count, and error flag. There are no prompts, program source,
thinking, tool contents, or credentials in these records. This identifies oversized calls
without claiming to distinguish returned data from logs when that evidence is unavailable.

The earlier pilot's H4:1 pair accounted for 97% of its output regression. Without a transcript,
we cannot reconstruct that program or determine whether it dumped raw input or logged it.
This experiment tests both failure patterns through guidance, rather than assuming a cause.
See `README.md` for fixture restrictions, SDK lifecycle ownership, and the cooperative timeout.
