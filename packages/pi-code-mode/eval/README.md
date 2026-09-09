# Code Mode evaluation pilots

These opt-in evaluations compare frozen guidance or formatter variants.
[The formatter benchmark](FORMATTER.md) uses `--experiment=formatter` with identical guidance
and pre-clamp access to the original values and logs.
[The wording benchmark](WORDING.md) uses `--experiment=wording` to compare the previous and
experimental first guideline with compact formatting fixed. Production retains the previous
guideline. Replay sessions explicitly apply their frozen guidance without changing production.
The [smaller-output protocol](OUTPUT.md) and adoption design below are archived. Their model-backed
modes are disabled because current production no longer reproduces their historical interventions.
Their fixtures and scorers remain available offline. Supported replays use real Pi model sessions,
the Code Mode extension lifecycle, and the shipped interpreter. Neither `test` nor `validate`
launches models.
See [adoption results](RESULTS.md), [output results](OUTPUT-RESULTS.md),
[wording results](WORDING-RESULTS.md), and [formatter results](FORMATTER-RESULTS.md).
All four cohorts are now exposed regression material and must not be reused as fresh evidence.
The completed budgets are exhausted. Any model-backed replay requires separate approval.

```sh
pnpm --filter pi-code-mode eval:pilot
pnpm --filter pi-code-mode eval:pilot --run --experiment=formatter \
  --provider=openai-codex --model=gpt-6-astra \
  --out=/absolute/new/directory --max-sessions=24
```

Model-backed commands require an explicit experiment and session cap, with no default budget.
The output directory must not already exist. Existing host model authentication is used
without copying credentials into fixtures. No model/provider fallback is allowed. The pilot
pins medium thinking, disables automatic retry and compaction, and excludes ambient
extensions, skills, context files, and system-prompt additions. An initial SDK/interpreter
smoke check makes no model request. Failed model-backed attempts consume budget; the runner
never retries an episode. Stop the enclosing process to cancel the pilot.

## Archived adoption design and decision

`tasks.ts` freezes four development tasks and ten held-out tasks. Development runs one pair
per task, eight sessions. Held-out runs two pairs per task, forty sessions. Eight held-out
tasks are eligible and two are negative controls, giving sixteen eligible episodes per arm.
Order alternates within pairs. Both arms expose Code Mode and the same direct tools. Only
selection guidance changes. The candidate is fixed before any held-out session; do not tune
it or the fixtures against held-out outcomes. The adoption runner tests one candidate per pilot,
not an unbounded prompt optimizer.

The primary measure is eligible episodes with at least one Code Mode call that dispatches
a non-discovery nested tool, divided by all scheduled eligible episodes. Empty scripts and
discovery-only programs do not count. Retries do not count as extra adoption. A completed
pilot passes when relative adoption increases at least 10%, every candidate answer passes,
no paired correctness regression or boundary/cleanup failure occurs, and newly adopted
episodes do successful nested work without failed Code Mode wrappers. Zero baseline makes
relative lift undefined; baseline above 90.9% makes the target unreachable.

Incomplete pilots cannot pass. Results are a small paired pilot, not statistical proof.
Production guidance changes require reviewing held-out results, costs, latency, and negative
controls. The runner does not edit production files or keep rerunning until the threshold is met.

## Restrictions and ownership

The first pilot covers read-only work. Evaluation-owned wrappers enforce fixture-only paths
on both direct and nested read, grep, find, and ls definitions. They reject parent/absolute
escapes and symlinks leaving the fixture. Nested shell and mutation tools are refused at the
dispatch boundary, not through Pi middleware. The same restriction is disclosed to both arms.
No background-task provider is installed. These restrictions differ from unrestricted
production Code Mode; results do not establish safety or adoption for shell/edit workflows.

`fixture-tools.ts` owns this fixed read-only SDK tool boundary and nested counters. It forwards
only the checked canonical absolute path to native definitions, including interpreter calls.
`host-files.ts` owns fixture path checks, materialization, and mutation checks through Effect's
file services. Standalone SDK and command entries provide `pi-cosmic-core`'s
`nodeFilePlatformLayer`; evaluator code has no direct Node filesystem imports.
`host-session.ts` owns each temporary fixture and SDK session. An Effect scope owns the
three-minute sleep and joins any started prompt abort before measurement. Ordered finalizers
emit `session_shutdown`, dispose the session and its subscriptions, then remove the fixture.
Foreign SDK calls use typed Effect boundaries; `errors.ts` keeps failures free of host paths,
provider errors, and credentials. Promise APIs remain at the SDK and command entry points.
Each episode has a fresh in-memory session and fixture. All sessions use a private temporary
agent configuration directory. No ambient resource discovery enters the model prompt.
`schedule.ts` owns pure offline plans for all four cohorts, including the archived schedules.
`replay.ts` admits only wording and formatter at both execution entries and owns their isolated
tool overrides. `pilot.ts` owns the attempt ledger, sequential execution, schema-encoded artifacts,
and Effect logging. It has no archived execution path or development gate. `run.mjs` owns the
enclosing private directory and opt-in command. Neither evaluation code nor artifacts ship in
the package.
The SDK abort deadline requests cooperative cancellation; it is not a forced process deadline.
For unattended use, run under a process supervisor with an outer timeout. A cleanup error
ends the pilot rather than permitting another episode.

## Artifacts and metrics

The external output directory contains the frozen manifest and hashes, append-only attempts
and run records, and the final report. Historical adoption/output artifacts also include a
development report and frozen candidate receipt. Wording and formatter modes have no development
phase; their manifests record the effective frozen guidelines as well as production source hashes.
No raw transcript, thinking, credentials, or tool output is persisted. Synthetic fixture
answers are checked in memory. Bounded mismatch paths come only from trusted oracle keys,
array indices, and fixed missing/extra/invalid-JSON markers, never actual answer values. Counts distinguish model-authored outer calls from actual
nested dispatch. Nested bytes are counted at the dispatch boundary, not from capped UI rows.
Tool-result bytes measure text actually returned to the model. Provider-native input, output,
cache-read, and cache-write tokens are separate; estimated cost is not a subscription bill.
All attempts and model turns contribute, including failures. Reports include paired adoption
outcomes and successful-only latency separately from all-run latency.

Tests under `tests/eval/` cover scoring, the attempt schedule, canonical-path restrictions
through the interpreter, mutation detection, dispatch counters, and the generated-log oracle
without model calls. TestClock checks deadline cancellation, abort joins, and typed cleanup
failures; cleanup tests require shutdown before disposal.
