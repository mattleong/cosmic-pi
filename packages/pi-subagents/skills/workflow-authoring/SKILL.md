---
name: workflow-authoring
description: Claude Code's workflow-authoring reference adapted to Pi's subagent_workflow tool, covering when to run a workflow, pipelines and barriers, quality patterns, scaling to the request, claims-first implementations and budgets. Read before writing a non-trivial script for a workflow the user opted into with ultracode or /ultracode.
---

# Workflow authoring

A workflow structures work across many agents: to be **comprehensive** (decompose and cover in parallel), to be **confident** (independent perspectives and adversarial checks before committing), or to take on **scale one context can't hold** (migrations, audits, broad sweeps, large implementations). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

This guide adapts Claude Code's workflow patterns to Pi's API and intent-led scaling; the sections from [Large implementations](#large-implementations-claims-first) on cover what only Pi has. The `subagent_workflow` tool description is the API reference: hooks, options, limits, saved workflows and resume. Complete examples run as written; blocks marked `fragment` reuse the schemas, helpers and `args` of the examples around them.

## When to use a workflow

Use a workflow when the work splits into many independent pieces, when findings need independent verification before you commit to them, or when it is too big for one context. Use `subagent_start` for agents you need to steer individually. Work solo when orchestration adds no value, including conversational turns, trivial edits and tasks you can fully verify yourself. A `/ultracode <task>` request opts that one task in, and the [Ultracode](#ultracode) rules below apply to it.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the call sites, scope the diff) to discover the work list, then call `subagent_workflow` to pipeline over it. Pass the list as `args` (at most 64 KiB of JSON), or make discovery the first stage: a `scout` whose schema returns the list. You don't need to know the shape before the _task_, only before the _orchestration step_.

Common single-phase workflows you can chain across turns:

- **Understand:** parallel readers over relevant subsystems → structured map.
- **Design:** warranted alternatives → evidence-based comparison → synthesis or an unresolved choice.
- **Review:** dimensions → find → adversarially verify (the [find-bugs example](#scale-to-what-the-user-asked-for)), or, for an audit, a wide first round plus gap rounds a critic proposes (the [exhaustive review](#composing-patterns-exhaustive-review)).
- **Research:** multi-modal sweep → deep-read → synthesize.
- **Migrate:** discover sites → transform each (a `worker` claiming the site's files, or worktree isolation) → verify.
- **Implement:** you build the core, then a worker per unit with disjoint claims, then a review workflow (see [Large implementations](#large-implementations-claims-first)).

For larger work, run several in sequence: read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

**Keep related work together.** Keep finding, verification and synthesis in one workflow when they serve one deliverable. Separate phases when the main agent needs to inspect results or decide the next scope. Discovery alone is useful when the requested deliverable is a map or inventory; distinguish that from verified review findings.

## Ultracode

When ultracode is on, that opt-in is standing: use workflows for substantive tasks when parallel or staged work helps. Enabling workflows is **not a request for maximal effort**. Choose scope and acceptance criteria from the user's intent before choosing agents. Scout the actual areas and dependencies, then scale breadth to independent work, depth to requested assurance and unresolved uncertainty, and verification to consequences, reversibility and the strength of evidence. Neither line count nor a default agent count determines the plan.

Clarify material ambiguity about requirements, scope or consequential trade-offs **before fan-out**. For cheap, reversible choices, state an explicit assumption and proceed. Briefly state the chosen scope, why parallel or staged work helps, and what evidence or stopping condition will finish it; this is a concise plan, not routine approval. Conversational turns, trivial mechanical edits and work you can fully verify yourself need no workflow; say what you checked.

Use adaptive, justified waves, not quotas. Stop **scheduling new work** when the requested outcome is supported, no concrete relevant gap remains, progress stalls, or a resource bound is reached. Await every started call; do not cancel useful work to answer sooner. Return limitations and unresolved evidence, not an implication that an empty finding list proves complete coverage.

## Pipeline by default

**Default to `pipeline()`.** Only reach for a barrier (`parallel()` between stages) when you genuinely need _all_ prior-stage results together. A barrier is correct only when stage N needs cross-item context from all of stage N-1:

- deduplicating or merging across the full result set before expensive downstream work;
- an early exit when the total count is zero ("0 bugs found → skip verification entirely");
- stage N's prompt references "the other findings" for comparison.

A barrier is not justified by:

- "I need to flatten, map or filter first": do it inside a pipeline stage, as in `pipeline(items, stageA, (r) => transform([r]).flat(), stageB)`.
- "The stages are conceptually separate": that's what `pipeline()` models. Separate stages aren't synchronized stages.
- "It's cleaner code": barrier latency is real. If 5 finders run and the slowest takes 3× the fastest, a barrier wastes 2/3 of the fast finders' time.

The smell test: if you wrote

```text
const a = await parallel(...)
const b = transform(a)        // flatten, map, filter: no cross-item dependency
const c = await parallel(b.map(...))
```

that middle transform doesn't need the barrier. Rewrite it as a pipeline with the transform inside a stage. When in doubt: pipeline. Stages run concurrently, so give each `agent()` call its `phase` option instead of calling `phase()`, which is shared state.

## Concurrency

Concurrent `agent()` calls are capped at `min(16, CPUs - 2)` per workflow (at least one), apart from your own subagent limit; excess calls queue and start in call order as slots free up. You can still pass 100 items to `parallel()` or `pipeline()` and they all complete; only that many run at any moment. Total `agent()` calls across a run's lifetime are capped at 1,000, counting calls the budget refused: a runaway-loop backstop set far above any real workflow.

## Patterns

### When a barrier is correct

Deduplicate across findings before expensive verification, conservatively: exact file, line and claim matches can share a check only if every source's evidence is retained. Nearby lines do not establish the same defect. Keep differing claims separate unless a semantic check establishes equivalence.

```js fragment
// DIMENSIONS comes from scouting; BUGS, VERDICT and dedupe() are the find-bugs example's.
const all = await parallel(
  DIMENSIONS.map(
    (d) => () =>
      agent(d.prompt, { label: d.name, phase: "Find", profile: "reviewer", schema: BUGS }),
  ),
);
const deduped = dedupe(all.filter(Boolean).flatMap((r) => r.bugs)); // genuinely needs ALL at once
const verified = await parallel(
  deduped.map(
    (b) => () =>
      agent(`Try to refute this reported bug against the code.\n${JSON.stringify(b)}`, {
        phase: "Verify",
        profile: "reviewer",
        schema: VERDICT,
      }),
  ),
);
```

### Loop until count

Use a count only when the user explicitly requests a finite set, such as examples or test cases. Never turn bug discovery into a quota. Stop if a round fails or adds nothing; report a shortfall rather than inventing items. Here `args.count` is the requested count and `CASES` describes concrete test cases:

```js fragment
const cases = [];
const MAX_ROUNDS = 8; // An illustrative runaway backstop, not a completion target.
for (let round = 0; cases.length < args.count && round < MAX_ROUNDS; round++) {
  const [result] = await parallel([
    () =>
      agent(
        `Suggest distinct test cases for ${args.goal}; at most ${args.count - cases.length} more. Existing cases: ${JSON.stringify(cases)}`,
        { profile: "reviewer", schema: CASES },
      ),
  ]);
  if (!result) break;
  const fresh = [...new Set(result.cases)].filter((item) => !cases.includes(item));
  if (fresh.length === 0) break;
  cases.push(...fresh.slice(0, args.count - cases.length));
}
return { cases, shortfall: Math.max(0, args.count - cases.length) };
```

### Loop until budget

A budget is a ceiling, **not a spending target**. The start's `budget` comes from the user; reserve verification and ending capacity before discovery. Initial targets must come from scouting and a concrete coverage gap. This fragment stops on failure or no new evidence or coverage even with budget left; it does not retry until tokens are spent:

```js fragment
// targets, BUGS, sameBug, addsProgress and verify come from the scoped plan.
// addsProgress checks new evidence or coverage, not the number of bugs.
const bugs = [];
const uncovered = [];
const RESERVE = 30_000; // Illustrative estimate for verification and the ending.
const COST = 45_000; // Calibrate from completed calls, not a universal per-agent cost.
let next = 0;
while (next < targets.length) {
  if (budget.total && budget.remaining() < COST + RESERVE) break;
  const target = targets[next++];
  const [result] = await parallel([() => agent(target, { profile: "reviewer", schema: BUGS })]);
  if (!result) {
    uncovered.push(target);
    break;
  }
  const fresh = result.bugs.filter((bug) => !bugs.some((other) => sameBug(other, bug)));
  bugs.push(...fresh);
  if (!addsProgress(result, target)) break;
}
uncovered.push(...targets.slice(next));
const verification = await verify(bugs);
return { bugs, verification, uncovered };
```

### Composing patterns: exhaustive review

For "thoroughly audit this" or "be comprehensive", scout a coverage map first: actual areas, their interactions and relevant cross-cutting failure classes. Give independently useful scopes their own finders; don't derive a pool size from lines or a number target. The critic proposes only concrete relevant gaps supported by that map, and subsequent rounds must add coverage. The round cap below is an illustrative safety backstop, not a goal. Findings receive evidence-based verification; add distinct verification lenses only where consequences or unresolved uncertainty warrant them (see [Quality patterns](#quality-patterns)).

```js
export const meta = {
  name: "exhaustive-review",
  description: "Coverage-map finders, evidence-based verification, then justified gap rounds",
  args: {
    type: "object",
    properties: {
      scope: { type: "string" },
      areas: { type: "array", items: { type: "string" }, minItems: 1 },
      lenses: { type: "array", items: { type: "string" } },
    },
    required: ["scope", "areas", "lenses"],
    additionalProperties: false,
  },
  phases: [
    { title: "Find", detail: "one finder per area and lens, then the critic's angles" },
    { title: "Verify", detail: "trace, reproduce or refute each new candidate" },
    { title: "Critic", detail: "its angles become the next round" },
  ],
};

const BUGS = {
  type: "object",
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          desc: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["file", "line", "desc", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["bugs"],
  additionalProperties: false,
};
const VERDICT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["confirmed", "refuted", "unverified"] },
    evidence: { type: "string" },
  },
  required: ["status", "evidence"],
  additionalProperties: false,
};
const GAPS = {
  type: "object",
  properties: { gaps: { type: "array", items: { type: "string" } } },
  required: ["gaps"],
  additionalProperties: false,
};

const MAX_ROUNDS = 3; // Illustrative safety backstop, not a coverage or completion goal.
// Initial output-token estimates; calibrate from completed calls.
const FINDER_COST = 45_000;
const JUDGE_COST = 10_000;
const CRITIC_COST = 10_000;
const END_RESERVE = 10_000;
const affords = (tokens) => !budget.total || budget.remaining() >= tokens;

// Conservative identity: differing claims remain separate; all source evidence stays.
const sameBug = (a, b) => a.file === b.file && a.line === b.line && a.desc === b.desc;
const classification = (verification) =>
  verification?.evidence?.trim() && ["confirmed", "refuted"].includes(verification.status)
    ? verification.status
    : "unverified";

const seen = [];
const outcomes = { confirmed: [], refuted: [], unverified: [] };
const assessments = new Map();
const searched = [];
const attempted = new Set();
const uncovered = [];
const cutShort = [];
const note = (message) => {
  log(message);
  cutShort.push(message);
};

const judge = async (bugs) => {
  // New evidence invalidates an earlier classification until this check settles.
  for (const status of Object.keys(outcomes))
    outcomes[status] = outcomes[status].filter((entry) => !bugs.includes(entry.finding));
  const fits = budget.total
    ? Math.max(0, Math.floor((budget.remaining() - CRITIC_COST - END_RESERVE) / JUDGE_COST))
    : bugs.length;
  const judging = bugs.slice(0, fits);
  if (judging.length < bugs.length)
    note(`The budget left ${bugs.length - judging.length} new bugs unverified`);
  const verdicts = await parallel(
    judging.map(
      (bug) => () =>
        agent(
          `Check this candidate against the code with an execution trace, reproduction or concrete counterevidence. Confirm only with supporting evidence; refute only with counterevidence. Uncertainty or conflicting evidence is unverified. Retain the evidence and unknowns, including prior assessments.\n${JSON.stringify({ finding: bug, previousAssessments: assessments.get(bug) ?? [] })}`,
          {
            label: `verify ${bug.file}:${bug.line}`,
            phase: "Verify",
            profile: "reviewer",
            schema: VERDICT,
          },
        ),
    ),
  );
  bugs.forEach((finding, index) => {
    const verification = verdicts[index] ?? null;
    const history = [...(assessments.get(finding) ?? []), verification];
    assessments.set(finding, history);
    const latest = classification(verification);
    const disagrees = history.some(
      (entry) => classification(entry) !== "unverified" && classification(entry) !== latest,
    );
    const status = disagrees ? "unverified" : latest;
    outcomes[status].push({ finding, verification, assessments: history });
  });
};

let finders = [
  ...args.areas.map((area) => ({
    label: `area: ${area}`,
    task: `Find bugs in ${area}. Read it in full and follow relevant calls into ${args.scope}.`,
  })),
  ...args.lenses.map((lens) => ({
    label: `lens: ${lens}`,
    task: `Find ${lens} bugs in ${args.scope}.`,
  })),
];
let rounds = 0;
while (finders.length > 0) {
  if (
    rounds >= MAX_ROUNDS ||
    !affords(finders.length * FINDER_COST + JUDGE_COST + CRITIC_COST + END_RESERVE)
  ) {
    uncovered.push(...finders.map(({ task }) => ({ task, reason: "round or budget bound" })));
    note("Discovery reached a resource bound; pending scopes remain uncovered");
    break;
  }
  rounds++;
  const known = seen.map(({ file, line, desc }) => ({ file, line, desc }));
  const results = await parallel(
    finders.map(
      (finder) => () =>
        agent(
          `${finder.task}\nReport candidates with file, line, description and concrete evidence. Already reported:\n${JSON.stringify(known)}`,
          { label: `${finder.label} r${rounds}`, phase: "Find", profile: "reviewer", schema: BUGS },
        ),
    ),
  );
  finders.forEach(({ task }, index) => {
    attempted.add(task);
    if (results[index]) searched.push(task);
    else uncovered.push({ task, reason: "finder failed, skipped or budget-refused" });
  });
  const answered = results.filter(Boolean);
  if (answered.length === 0) {
    note("No finder answered; discovery made no progress");
    break;
  }
  const fresh = [];
  for (const bug of answered.flatMap((result) => result.bugs)) {
    const existing = seen.find((other) => sameBug(other, bug));
    if (existing) {
      if (!existing.reports.some((report) => JSON.stringify(report) === JSON.stringify(bug))) {
        existing.reports.push(bug);
        if (!fresh.includes(existing)) fresh.push(existing);
      }
      continue;
    }
    const finding = { ...bug, reports: [bug] };
    seen.push(finding);
    fresh.push(finding);
  }
  // Await started verification before assessing remaining capacity.
  await judge(fresh);
  if (!affords(CRITIC_COST + END_RESERVE)) {
    uncovered.push({ task: "coverage assessment", reason: "budget bound" });
    note("No capacity for the coverage critic");
    break;
  }
  const current = seen.map((finding) => ({
    file: finding.file,
    line: finding.line,
    desc: finding.desc,
    status: Object.keys(outcomes).find((status) =>
      outcomes[status].some((entry) => entry.finding === finding),
    ),
    evidence: finding.reports.map((report) => report.evidence.slice(0, 500)),
    assessments: (assessments.get(finding) ?? []).map((entry) =>
      entry ? { status: entry.status, evidence: entry.evidence.slice(0, 500) } : null,
    ),
  }));
  const [critic] = await parallel([
    () =>
      agent(
        `Assess coverage of ${args.scope}. Map: ${JSON.stringify({ areas: args.areas, lenses: args.lenses })}. Completed scopes: ${JSON.stringify(searched)}. Uncovered: ${JSON.stringify(uncovered)}. Findings: ${JSON.stringify(current)}. Propose only concrete relevant unsearched tasks justified by this map and evidence, not a target number. Include each gap's rationale in its task; return no gaps when none is justified.`,
        { label: `critic r${rounds}`, phase: "Critic", profile: "reviewer", schema: GAPS },
      ),
  ]);
  if (!critic) {
    uncovered.push({
      task: "coverage assessment",
      reason: "critic failed, skipped or budget-refused",
    });
    note("Coverage is unknown without the critic's assessment");
    break;
  }
  const gaps = [...new Set(critic.gaps.map((gap) => gap.trim()).filter(Boolean))];
  finders = gaps
    .filter((task) => !attempted.has(task))
    .map((task, index) => ({ label: `gap ${rounds}.${index + 1}`, task }));
  if (gaps.length > 0 && finders.length === 0) {
    uncovered.push(...gaps.map((task) => ({ task, reason: "repeated gap; no new progress" })));
    note("The critic repeated attempted work; discovery stopped");
  }
}
return { ...outcomes, searched, uncovered, rounds, cutShort };
```

Deduplicate against everything seen, not only confirmed findings. Retain all source reports and verification assessments; new evidence triggers a recheck, and conflicting assessments stay unverified. Successful finder scopes, failed or skipped scopes, verification evidence and unknown coverage remain distinct. A critic failure is not "no gaps". New rounds require new justified scope; exhausted resources or stalled progress leave explicit limitations. Await all calls already started, even after deciding not to schedule another wave.

### Quality patterns

Common shapes; pick by task and compose freely.

**Adversarial verify.** Ask for a concrete trace, reproduction or counterevidence, not a vote. One check may settle a finding; add independent checks only for consequential decisions or specific unresolved uncertainty. Nulls and unsupported conclusions remain unverified.

**Perspective-diverse verify.** For a finding with several relevant failure modes, select distinct lenses from the evidence. This optional fragment uses `args.verificationLenses` chosen for this claim, not a mandatory panel. Agreement alone is not proof; each decisive assessment needs concrete evidence. Conflicting assessments remain unverified for targeted resolution, with every answer retained:

```js fragment
const VERDICT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["confirmed", "refuted", "unverified"] },
    evidence: { type: "string" },
  },
  required: ["status", "evidence"],
  additionalProperties: false,
};
const assessments = await parallel(
  args.verificationLenses.map(
    (lens) => () =>
      agent(
        `Check ${args.claim} through ${lens}. Trace or reproduce it, or provide concrete counterevidence. Report unverified for uncertainty or conflicting evidence; do not decide by popularity.`,
        { label: lens, phase: "Verify", profile: "reviewer", schema: VERDICT },
      ),
  ),
);
const decisive =
  assessments.length > 0 &&
  assessments.every(
    (entry) => entry?.evidence?.trim() && ["confirmed", "refuted"].includes(entry.status),
  );
const status =
  decisive && assessments.every((entry) => entry.status === assessments[0].status)
    ? assessments[0].status
    : "unverified";
return { claim: args.claim, status, assessments };
```

**Judge panel.** When the solution space or trade-offs warrant alternatives, choose approaches and evaluation criteria from the task. Do not synthesize from the first plan merely because all judges failed, and do not treat a majority as truth. Disagreement or missing evidence leaves the choice open:

```js fragment
const PLAN = {
  type: "object",
  properties: {
    summary: { type: "string" },
    steps: { type: "array", items: { type: "string" } },
    risks: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "steps", "risks"],
  additionalProperties: false,
};
const PICK = {
  type: "object",
  properties: { best: { type: "integer" }, why: { type: "string" } },
  required: ["best", "why"],
  additionalProperties: false,
};
const plans = await parallel(
  args.angles.map(
    (angle) => () =>
      agent(`Design ${args.goal}. Take a ${angle} approach.`, {
        label: angle,
        phase: "Design",
        profile: "planner",
        schema: PLAN,
      }),
  ),
);
const picks = await parallel(
  args.criteria.map(
    (criterion) => () =>
      agent(
        `Evaluate these plans for ${args.goal} against ${criterion}. Choose a non-null plan by 0-based index with concrete reasoning, or -1 if undecided.\n${JSON.stringify(plans)}`,
        { label: criterion, phase: "Judge", profile: "reviewer", schema: PICK },
      ),
  ),
);
const valid = (pick) =>
  pick &&
  pick.why.trim() &&
  Number.isInteger(pick.best) &&
  pick.best >= 0 &&
  plans[pick.best] != null;
const decided =
  picks.length > 0 && picks.every(valid) && picks.every((pick) => pick.best === picks[0].best);
if (!decided) return { status: "unverified", plans, picks, synthesis: null };
const [synthesis] = await parallel([
  () =>
    agent(
      `Write the final plan for ${args.goal}. Start from plan ${picks[0].best}, address the evidence and retain unresolved risks.\n${JSON.stringify({ plans, picks })}`,
      { phase: "Synthesize", profile: "planner", schema: PLAN },
    ),
]);
return { status: synthesis ? "proposed" : "unverified", plans, picks, synthesis };
```

**Loop-until-dry.** For discovery of unknown size, make each additional wave earn its place through a concrete relevant gap and new evidence or coverage. Stop when acceptance is supported, no justified gap remains or progress stalls, not after a quota of empty rounds. Keep a resource backstop and disclose what it leaves unverified or uncovered.

**Multi-modal sweep.** Parallel agents each search a different way (by container, by content, by entity, by time). Each is blind to what the others surface; use it when one search angle won't find everything:

```js fragment
const PLACES = {
  type: "object",
  properties: {
    places: {
      type: "array",
      items: {
        type: "object",
        properties: { path: { type: "string" }, why: { type: "string" } },
        required: ["path", "why"],
        additionalProperties: false,
      },
    },
  },
  required: ["places"],
  additionalProperties: false,
};
// Example-specific modes selected after scouting; omit modes irrelevant to the question.
const MODES = [
  "by name: the symbol, its aliases and re-exports",
  "by behavior: code with the same effect that doesn't name it",
  "by tests: tests and fixtures that exercise it",
  "by history: git log -S and recent diffs that touched it",
];
const sweeps = await parallel(
  MODES.map(
    (mode) => () =>
      agent(
        `Find every file where ${args.question}. Search ${mode}. Return each workspace-relative path with one line on why it matters.`,
        { phase: "Sweep", profile: "scout", schema: PLACES },
      ),
  ),
);
const union = new Map();
for (const place of sweeps.filter(Boolean).flatMap((sweep) => sweep.places))
  if (!union.has(place.path)) union.set(place.path, place.why);
log(`${union.size} files from ${sweeps.filter(Boolean).length} of ${MODES.length} sweeps`);
const notes = await parallel(
  [...union].map(
    ([path, why]) =>
      () =>
        agent(
          `Read ${path} closely and explain how it bears on: ${args.question}\nA search flagged it because: ${why}`,
          { label: `read ${path}`, phase: "Deep read", profile: "scout" },
        ),
  ),
);
return {
  places: [...union].map(([path, why], index) => ({ path, why, note: notes[index] ?? null })),
  uncovered: MODES.filter((_, index) => !sweeps[index]),
};
```

**Completeness critic.** When a coverage assessment is warranted, ask "what concrete relevant gap remains: an interaction not checked, a claim unverified, a source unread?" Only justified gaps become new work; a failed critic leaves coverage unknown.

**No silent caps.** If a workflow bounds coverage (top N, no retry, sampling), `log()` what was dropped and return it: silent truncation reads as "covered everything" when it didn't.

```js fragment
const MAX_FILES = 40;
const files = args.files.slice(0, MAX_FILES);
const skipped = args.files.slice(MAX_FILES);
if (skipped.length > 0) log(`Reviewing ${files.length} files; skipped ${skipped.join(", ")}`);
return { files, skipped };
```

## Scale to what the user asked for

Decide intent first, then keep breadth, depth and verification separate:

- **Quick but broad:** scout all relevant areas, choose a disclosed sample or shallow pass across them, and return what was not checked. "Quick" limits depth, not necessarily the number of independent areas.
- **Tiny but high-risk:** a small authorization, migration or deletion change may need a narrow, deep execution trace, reproduction and counterevidence despite its size. Consequences and reversibility determine verification.
- **Comprehensive:** maintain a coverage map, include relevant interactions, and use a critic only to identify justified gaps. Empty findings alone prove neither safety nor coverage; stop when the scoped outcome is supported or further progress is unjustified.
- **Implementation:** establish shared contracts and dependencies, then assign independently owned units. Writer and reviewer counts follow actual ownership and risk, not file counts.

Read the code or diff while scouting and retain candidates you already found. Ask finders for concrete scenarios and reachability, deduplicate without losing evidence, and verify with traces, reproductions or counterevidence. Missing, uncertain or conflicting evidence stays **unverified**, never silently refuted or confirmed by a vote. Prefer a focused pass when it meets the request; uncertainty calls for a targeted check or material clarification, not automatic thoroughness.

"Find any bugs" in a change, with `known` holding the bugs you noted while reading it (as `BUGS` items) and one checklist per finder from your reading:

```js
export const meta = {
  name: "find-bugs",
  description: "A few finders over the changed files, dedup, then one skeptic per candidate",
  args: {
    type: "object",
    properties: {
      files: { type: "array", items: { type: "string" }, minItems: 1 },
      known: { type: "array", items: { type: "object" } },
      checklists: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["files", "known", "checklists"],
    additionalProperties: false,
  },
  phases: [
    { title: "Find", detail: "one finder per checklist" },
    { title: "Verify", detail: "one skeptic per candidate, yours included" },
  ],
};

const BUGS = {
  type: "object",
  properties: {
    bugs: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          desc: { type: "string" },
          evidence: { type: "string" },
          reachable: { type: "string" },
        },
        required: ["file", "line", "desc", "evidence", "reachable"],
        additionalProperties: false,
      },
    },
  },
  required: ["bugs"],
  additionalProperties: false,
};
const VERDICT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["confirmed", "refuted", "unverified"] },
    evidence: { type: "string" },
  },
  required: ["status", "evidence"],
  additionalProperties: false,
};

// Group only exact candidate matches; retain every source's evidence.
const sameBug = (a, b) => a.file === b.file && a.line === b.line && a.desc === b.desc;
const dedupe = (bugs) => {
  const kept = [];
  for (const bug of bugs) {
    const existing = kept.find((other) => sameBug(other, bug));
    if (existing) existing.reports.push(bug);
    else kept.push({ ...bug, reports: [bug] });
  }
  return kept;
};

const found = await parallel(
  args.checklists.map(
    (checklist, index) => () =>
      agent(
        `Review the uncommitted changes to ${args.files.join(", ")} for bugs. Check: ${checklist}\nReport every candidate you can back with a concrete failing scenario, each with file, line, a one-line desc, evidence and whether real callers reach it: skeptics check each one, so don't hold back a plausible one. These are already known; find others:\n${JSON.stringify(args.known)}`,
        { label: `find ${index + 1}`, phase: "Find", profile: "reviewer", schema: BUGS },
      ),
  ),
);
// A justified barrier: dedup across every finder, and skip verifying when nothing was found.
const bugs = dedupe([...args.known, ...found.filter(Boolean).flatMap((result) => result.bugs)]);
const uncovered = args.checklists.filter((_, index) => !found[index]);
const classify = (verification) =>
  verification?.evidence?.trim() && ["confirmed", "refuted"].includes(verification.status)
    ? verification.status
    : "unverified";
const verdicts = await parallel(
  bugs.map(
    (bug) => () =>
      agent(
        `Check this candidate with a trace, reproduction or concrete counterevidence. Confirm or refute only with evidence; uncertainty is unverified. Retain unknowns.\n${JSON.stringify(bug)}`,
        {
          label: `verify ${bug.file}:${bug.line}`,
          phase: "Verify",
          profile: "reviewer",
          schema: VERDICT,
        },
      ),
  ),
);
const outcomes = { confirmed: [], refuted: [], unverified: [], uncovered };
bugs.forEach((finding, index) => {
  const verification = verdicts[index] ?? null;
  outcomes[classify(verification)].push({ finding, verification });
});
return outcomes;
```

These patterns aren't exhaustive: compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits). Use a workflow for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## What agents return

Agents are told their final text is the return value, not a human-facing message, so they return raw data. For structured output, use the `schema` option: validation happens at the tool-call layer, so the agent retries on a mismatch. Agents get the workspace's instruction files (`AGENTS.md`) as you did: don't tell them to re-read those or paste their rules into the prompt; name the specific rule a stage needs, if any. They don't see this conversation, so give each prompt the goal, paths, constraints and user's words it needs.

## Large implementations: claims first

Writers in the shared checkout follow file claims. `writes` lists the exact workspace-relative files an agent may change (no directories, globs, `./` or leading `/`), at most 64 per writer. Writers with disjoint claims run in parallel, overlapping claims queue, and a writer without `writes` runs alone. A writer that touches a file it didn't claim is contained, and new writers pause until you review it, so every list must be complete, tests, fixtures and docs included. A malformed claim is an invalid call that fails the run, so check each list before you start. Use `isolation: "worktree"` only for units whose files can't be known upfront or that overlap heavily; its proposal comes back in the notification for you to review and integrate with `subagent_workspace`.

A multi-file feature runs as two workflows with you in between:

1. **Scout and build the core yourself.** Read the code, settle the design (names, types, validation rules, error messages, where each piece lives), and implement the core everything else depends on, such as the schema, validation and service changes, so the writers build on code rather than on a description.
2. **Implement workflow.** Split the rest into units with disjoint files: each surface, the tests for each area, the docs. Give every writer the same brief (the final design decisions and the core you wrote) plus the files it owns, and run one `worker` per unit in parallel, each claiming its files. Split by independent ownership and dependencies, not a writer quota.
3. **Check it yourself.** Run the package's typecheck, lint and tests, and fix what is small.
4. **Review workflow.** Choose independent scopes and lenses from the changed contracts, risks and checks still needed. Deduplicate findings while retaining evidence, then verify in proportion to consequences and uncertainty. A worker can fill a test gap in files no one else claims.
5. **Fix and finish.** Fix the confirmed findings, run the checks again, and report.

The implement workflow, with the units from your plan as `args`:

```js
export const meta = {
  name: "implement-units",
  description: "One worker per planned unit, each claiming its files, all in parallel",
  args: {
    type: "object",
    properties: {
      brief: { type: "string" },
      units: {
        type: "array",
        minItems: 1,
        items: {
          type: "object",
          properties: {
            title: { type: "string" },
            task: { type: "string" },
            files: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 64 },
          },
          required: ["title", "task", "files"],
          additionalProperties: false,
        },
      },
    },
    required: ["brief", "units"],
    additionalProperties: false,
  },
  phases: [{ title: "Implement", detail: "one worker per unit, claiming its files" }],
};

const REPORT = {
  type: "object",
  properties: {
    summary: { type: "string" },
    filesChanged: { type: "array", items: { type: "string" } },
    checks: { type: "string" },
    concerns: { type: "array", items: { type: "string" } },
  },
  required: ["summary", "filesChanged", "checks", "concerns"],
  additionalProperties: false,
};

const reports = await parallel(
  args.units.map(
    (unit) => () =>
      agent(
        `${args.brief}\n\nYour unit: ${unit.title}\n${unit.task}\nYou own these files and change only them: ${unit.files.join(", ")}. Run the focused checks for what you changed and report them.`,
        {
          label: `implement:${unit.title}`,
          phase: "Implement",
          profile: "worker",
          writes: unit.files,
          schema: REPORT,
        },
      ),
  ),
);
return args.units.map((unit, index) => ({
  unit: unit.title,
  report: reports[index] ?? "the worker failed",
}));
```

The review workflow, after your checks pass:

```js
export const meta = {
  name: "review-change",
  description: "Scoped reviewers over the change, dedup, then evidence-based verification",
  args: {
    type: "object",
    properties: {
      goal: { type: "string" },
      lenses: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["goal", "lenses"],
    additionalProperties: false,
  },
  phases: [
    { title: "Review", detail: "one reviewer per lens" },
    { title: "Verify", detail: "trace, reproduce or refute each candidate" },
  ],
};

const FINDINGS = {
  type: "object",
  properties: {
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string" },
          line: { type: "integer" },
          desc: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["file", "line", "desc", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};
const VERDICT = {
  type: "object",
  properties: {
    status: { type: "string", enum: ["confirmed", "refuted", "unverified"] },
    evidence: { type: "string" },
  },
  required: ["status", "evidence"],
  additionalProperties: false,
};

// Nearby reports can be unrelated; group only exact candidate matches.
const sameFinding = (a, b) => a.file === b.file && a.line === b.line && a.desc === b.desc;

const found = await parallel(
  args.lenses.map(
    (lens) => () =>
      agent(
        `Review the uncommitted change that implements: ${args.goal}\nLens: ${lens}\nRead the diff and the code it touches. Report each bug, unmet requirement or missing test with file, line, a one-line desc and evidence.`,
        { label: `review:${lens}`, phase: "Review", profile: "reviewer", schema: FINDINGS },
      ),
  ),
);
// A justified barrier: dedup across every reviewer before verifying.
const findings = [];
for (const finding of found.filter(Boolean).flatMap((result) => result.findings)) {
  const existing = findings.find((other) => sameFinding(other, finding));
  if (existing) existing.reports.push(finding);
  else findings.push({ ...finding, reports: [finding] });
}
const verdicts = await parallel(
  findings.map(
    (finding) => () =>
      agent(
        `Check this finding against the code. Confirm with a concrete trace or reproduction, refute with counterevidence; uncertainty or conflicting evidence is unverified. Retain unknowns.\n${JSON.stringify(finding)}`,
        {
          label: `verify ${finding.file}:${finding.line}`,
          phase: "Verify",
          profile: "reviewer",
          schema: VERDICT,
        },
      ),
  ),
);
const outcomes = {
  confirmed: [],
  refuted: [],
  unverified: [],
  uncovered: args.lenses.filter((_, index) => !found[index]),
};
findings.forEach((finding, index) => {
  const verification = verdicts[index] ?? null;
  const status =
    verification?.evidence?.trim() && ["confirmed", "refuted"].includes(verification.status)
      ? verification.status
      : "unverified";
  outcomes[status].push({ finding, verification });
});
return outcomes;
```

In the session's worktree writer mode every writer gets a worktree and nothing reaches the checkout until you integrate it: integrate the proposals before your checks and the review workflow. To repair as you go, run a worker again with the review's confirmed findings and the same `writes`.

## Budgets

The user sets a budget with `/ultracode +500k` or by stating a limit; pass it as the start's `budget` (output tokens). It is an admission ceiling, not a guaranteed spending cap: once it is spent, an `agent()` call whose agent hasn't started throws `WorkflowBudgetError`; agents already running finish and may overshoot. Plan the run inside it before you write the script:

- **Treat it as a ceiling, not a target.** Reserve capacity for verification and the ending before discovery. Add a round only for a concrete relevant gap, and stop scheduling when the requested outcome is supported, progress stalls or resources bind—even with tokens left. For multi-phase work, allocate reserves up front.
- **Estimate costs from the work**, not a fixed agent quota. Update the estimate from completed calls, the change in `budget.spent()`, and keep headroom for uncertainty.
- **Guard every phase and top-level call.** Check `budget.remaining()` first, shrink the phase to what fits (narrower discovery or the most consequential findings first) and `log()` what you dropped. Inside `parallel()` or `pipeline()` a refused call becomes `null`, which is no answer: count its finding as unverified, not refuted. A refused top-level call fails the run and loses everything after it.
- **Allow for overshoot.** `budget.spent()` excludes live calls, while admission also counts their live usage. Estimates aren't guarantees: running calls finish even after admission closes. Use bounded waves, await them, and retain failed and unscheduled work:

```js fragment
// items, COST and RESERVE come from the plan; addsProgress checks evidence or coverage.
const results = [];
let next = 0;
while (next < items.length) {
  const fits = budget.total ? Math.floor((budget.remaining() - RESERVE) / COST) : items.length;
  if (fits < 1) break;
  const wave = items.slice(next, next + fits);
  next += wave.length;
  const answers = await parallel(
    wave.map((item) => () => agent(item.prompt, { profile: "reviewer" })),
  );
  results.push(...wave.map((item, index) => ({ item, answer: answers[index] ?? null })));
  if (answers.every((answer) => answer === null) || !addsProgress(answers)) break;
}
const skipped = items.slice(next);
const failed = results.filter(({ answer }) => answer === null).map(({ item }) => item);
if (skipped.length) log(`Left ${skipped.length} items unscheduled`);
return { results, failed, skipped };
```

## Pi specifics

- **Profiles** choose the model and effort; `model`, `effort` and `agentType` are rejected. `scout` maps code cheaply, `researcher` consults external sources, `planner` designs and splits work, `reviewer` finds and verifies problems, `worker` writes, and `generalist` is the default. `oracle` forks your conversation; the others start fresh. Writer options on a read-only profile are an invalid call.
- **Schemas** are objects with `required` and `additionalProperties: false`; `$ref` and `$defs` are rejected, and every pattern must compile with the `u` flag.
- **Prompt size.** An `agent()` prompt holds at most 131,072 characters, and a longer one can't start, so the call resolves `null`. Give a critic or a synthesis compact summaries (file, line and a one-line desc per finding), not every finding's full evidence and votes.
- **Expect `null`.** `agent()` resolves `null` when its agent fails, is stopped or is skipped, and an item that throws inside `parallel()` or `pipeline()` becomes `null`, which `pipeline()` passes to the next stage. Preserve the failed item's scope as uncovered and its candidate as unverified before filtering nulls; do not confuse no answer with no findings.
- **Invalid calls fail the run**, even inside `parallel()` and `pipeline()`: an unknown option or profile, a bad schema or claim, or more than 1,000 calls. A `catch` around `agent()` should rethrow errors whose `name` isn't `WorkflowBudgetError`.
- **Determinism.** `Date.now()`, `new Date()` and `Math.random()` throw, and there are no timers, `fetch`, files or modules, so runs can resume. Pass dates through `args`. Await every `agent()` call: agents still running when the script returns are stopped.
- **Declare the plan.** List the agents you already know in `meta.phases[].agents`, with exactly the labels your calls use, and make those calls in that phase, so the user sees the plan and can skip one. Leave `agents` out when a phase's count depends on earlier results or calls repeat across rounds.
- **Return what you act on**: confirmed, refuted and unverified candidates with their full evidence, missing assessments, and failed, skipped or budget-limited coverage. The results journal keeps every agent's full output.
- **Runtime failures.** Follow the supplied recovery guidance, not script-edit advice: preserve outstanding worktree proposals and stop other active work before asking the user to fully restart Pi and continue this session, then retry unchanged with the same `args` and `resumeFromRunId`. Changed worktree writers cannot be reused across a restart. Check the runtime installation if failure persists. A sandbox failure whose error mentions memory is the script's: it held too much data at once, so reduce it and resume.
- **Resume and extend.** For script errors or intentional changes, edit the script's file (an inline script's saved copy is named in the start result) and start it again with the same `args` and `resumeFromRunId`. Calls with the same prompt, profile, schema, isolation and writes reuse their results. Once a writer call without `isolation: "worktree"` runs live, every later call runs live too, so add new stages after the writers you keep. Don't restart a run the user stopped unless they ask.
- **Read the results journal** that the notification and status name before you diagnose an empty or surprising result.

## Run it

- **Write the script on short lines**, with schemas and prompts as named constants: a syntax error names its line, which is easy to fix on a short one.
- **Pass one-off work inline** as `script`. Write a saved workflow, in `.pi/workflows/` of a trusted project or the agent directory's `workflows/`, only when the user wants one to reuse.
- **End your turn after starting it.** `start` returns at once; finish any unrelated work, then end your turn. The run's one notification starts your next turn with its result, and you report from it then. Don't call `status` to wait; use it when the user asks how it is going or a run seems stuck. Answer agents' questions with `subagent_reply`.
- **Don't stop a run to answer sooner.** Its unfinished agents' work is lost, and a resume reruns them at full cost. Stop a run only when the user asks or it is clearly broken, such as a wrong script or a runaway loop.
