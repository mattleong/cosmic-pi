---
name: workflow-authoring
description: How to size, structure and verify a subagent_workflow script for a workflow the user opted into with ultracode or /ultracode. Read before writing a non-trivial workflow script.
---

# Workflow authoring

A workflow runs work across many agents so the result is **comprehensive** (decompose and cover in parallel), **confident** (independent perspectives and adversarial checks before anything is reported), or **bigger than one context can hold** (audits, migrations, broad sweeps, large implementations). The script encodes that structure: what fans out, what verifies, and what synthesizes.

The `subagent_workflow` tool description is the API reference: hooks, options, limits, saved workflows and resume. This guide covers how to shape a script. Complete examples run as written; blocks marked `fragment` reuse the schemas, helpers and `args` of the examples around them.

## When to use a workflow

- **Work solo** on small, specific tasks, even when the ultracode setting is on: a conversational turn such as a quick question, or a trivial edit such as a rename. A workflow adds latency and cost there without adding confidence.
- **Use `subagent_start`** for one to three agents you steer yourself, or when you need their answers to decide what to do next in this turn.
- **Use a workflow** when the work splits into many independent pieces, when findings need independent verification before you report them, or when it is too big for one context.

A `/ultracode <task>` request asks for a workflow explicitly: run one even for a small task, sized as a focused check.

Scout first. List the files, scope the diff or find the call sites yourself, then pass that work list to the workflow as `args` (at most 64 KiB of JSON), or make discovery the first stage: a `scout` whose schema returns the list. You need to know the work list before you write the orchestration, not before you start the task.

## Size it from the request

- **A focused check**, such as "any bugs in this function?" or "is this change safe?": 2 to 4 finders and one verifier per finding, 3 to 10 agents.
- **A normal review or investigation**, such as "review this PR" or "how does auth work here?": finders per dimension or subsystem, 1 to 3 refuters per finding and one synthesis, 10 to 40 agents.
- **"Thoroughly audit", "be comprehensive", a whole package, a large implementation or migration:** finders per dimension and area, loop until dry, 3 to 5 refuters per finding with a majority vote, a synthesis and a completeness critic; or a planner, then a worker and a reviewer per unit. That is 40 to 200 agents or more, over several workflows.

When unsure, lean thorough for research, review and audits, and brief for quick checks.

Dozens of agents in one phase is normal for large work. Each run executes up to `min(16, CPUs - 2)` agents at once (often 6 to 16), apart from the main agent's own subagent limit, and queues the rest in call order, so pass every item to `parallel()` or `pipeline()`: 100 items all complete, a few at a time. The limit of 1,000 `agent()` calls per run is a runaway backstop, not a target.

When the user gives a token budget, pass it as the start's `budget` and plan the whole run inside it before you write the script:

1. **Split it across phases up front**, keeping room to verify and synthesize: for example half to find, most of the rest to verify, and about 10k output tokens for a synthesis or critic. A find phase that spends everything leaves nothing to verify.
2. **Size each phase from its share** with realistic output-token costs per agent: a finder or worker that reads a whole package spends 30k to 60k (eight finders auditing a 5,000-line package spent about 38k each); a verifier checking one finding, 5k to 15k; a synthesis or critic, about 10k.
3. **Never start more agents at once than the remaining budget covers.** `budget.spent()` counts finished agents only, while the ceiling also counts running ones, so a phase launched wider than `remaining() / cost` overshoots and every later call is refused. Run a wide phase in waves.
4. **Guard every phase and every top-level call.** Check `budget.remaining()` first, shrink the phase to what fits (fewer refuters, highest-severity findings first) and `log()` what you dropped. Once the budget is spent, an `agent()` call whose agent hasn't started throws `WorkflowBudgetError`: inside `parallel()` or `pipeline()` its item becomes `null`, but a top-level call fails the run and loses everything after it.

`budget.total` is `null` without a budget and `budget.remaining()` is then `Infinity`, so guard on `budget.total`:

```js fragment
// FINDINGS and VERDICT are the review example's schemas, below; AREAS comes from scouting.
const FINDER = 45_000; // output tokens a finder reading a package spends
const VERIFIER = 10_000; // output tokens a verifier checking one finding spends
const fit = (count, cost, pool) => Math.max(1, Math.min(count, Math.floor(pool / cost)));

// Find with half the budget, in waves no wider than the find share left can pay for.
const findPool = budget.total ? budget.total * 0.5 : Infinity;
const findStart = budget.spent();
const candidates = [];
let next = 0;
while (next < AREAS.length && budget.spent() - findStart + FINDER <= findPool) {
  const wave = AREAS.slice(
    next,
    next + fit(AREAS.length - next, FINDER, findPool - (budget.spent() - findStart)),
  );
  next += wave.length;
  const found = await parallel(
    wave.map(
      (area) => () =>
        agent(`Find real bugs in ${area}. Report file, line and claim for each.`, {
          label: area,
          phase: "Find",
          profile: "reviewer",
          schema: FINDINGS,
        }),
    ),
  );
  candidates.push(...found.filter(Boolean).flatMap((review) => review.findings));
}
if (next < AREAS.length)
  log(
    `The budget covered ${next} of ${AREAS.length} areas; skipped: ${AREAS.slice(next).join(", ")}`,
  );

// Verify with most of what is left, keeping 10k for the summary: three refuters each, fewer when short.
const verifyPool = budget.total ? Math.max(0, budget.remaining() - 10_000) : Infinity;
const refuters = Math.min(3, Math.floor(verifyPool / VERIFIER / Math.max(1, candidates.length)));
if (refuters < 3) log(`The budget allows ${refuters} refuter(s) per finding instead of 3`);
const verdicts =
  refuters === 0
    ? []
    : await parallel(
        candidates.map(
          (bug) => () =>
            parallel(
              Array.from(
                { length: refuters },
                (_, n) => () =>
                  agent(
                    `Try to refute this reported bug against the code; answer refuted: true unless you confirm it.\n${JSON.stringify(bug)}`,
                    {
                      label: `refute ${bug.file}:${bug.line} #${n + 1}`,
                      phase: "Verify",
                      profile: "reviewer",
                      schema: VERDICT,
                    },
                  ),
              ),
            ),
        ),
      );
const confirmed = candidates.filter(
  (_, index) =>
    (verdicts[index] ?? []).filter((vote) => vote && !vote.refuted).length > refuters / 2,
);

// A top-level call fails the run once the budget is spent, so check before the summary.
const summary =
  !budget.total || budget.remaining() >= 10_000
    ? await agent(`Summarize these confirmed bugs by impact:\n${JSON.stringify(confirmed)}`, {
        label: "summary",
        profile: "reviewer",
      })
    : null;
return { confirmed, summary, unverified: refuters === 0 ? candidates : [] };
```

For open-ended discovery under a budget, loop while the costliest round so far still fits:

```js fragment
// A round that fails spends nothing and never shrinks remaining(), so stop on a failed or empty
// round, and bound the rounds anyway.
const reported = [];
let perRound = 0;
let round = 0;
while (budget.total && budget.remaining() > perRound * 1.5 && round < 20) {
  round++;
  const before = budget.spent();
  const found = await agent(
    `Find issues in ${args.scope}. Skip these, already reported: ${JSON.stringify(reported)}`,
    { label: `find r${round}`, profile: "reviewer", schema: FINDINGS },
  );
  perRound = Math.max(perRound, budget.spent() - before);
  if (found === null) {
    log(`Round ${round} failed; stopping`);
    break;
  }
  if (found.findings.length === 0) break;
  reported.push(...found.findings.map(({ file, line, claim }) => ({ file, line, claim })));
}
log(
  `Stopped after round ${round} with ${reported.length} issues and ${budget.remaining()} tokens left`,
);
```

## Structure

**Pipeline by default.** `pipeline(items, ...stages)` runs each item through every stage on its own, so item A can be verified while item B is still being found, and the run takes as long as the slowest single chain. Use `parallel()` between stages, a barrier, only when the next stage needs every earlier result together:

- deduplicating or merging across the whole set before expensive work;
- stopping early when the total is zero;
- a prompt that compares an item with "the other findings".

A barrier is not justified by needing to flatten, map or filter first (do that inside a stage), by the stages being conceptually separate, or by cleaner code. The smell test: `parallel(...)`, then a transform with no cross-item dependency, then `parallel(...)` again should be one `pipeline()`. Inside concurrent stages, pass the `phase` option instead of calling `phase()`, which is shared state.

**One workflow per phase for big jobs.** Run understand, design, implement and review as separate workflows in sequence, and read each result before you write the next. Common single-phase shapes:

- **Understand:** scouts read subsystems in parallel and return a structured map.
- **Design:** a judge panel scores several independent approaches and one planner synthesizes.
- **Review:** find by dimension, merge duplicate reports, then verify adversarially.
- **Research:** a multi-modal sweep, deep reads of what it found, then a synthesis.
- **Implement:** a planner claims files, workers implement units in parallel, and reviewers check each unit (see [Large implementations](#large-implementations-claims-first)).
- **Migrate:** a scout lists the sites and the files each one touches; a pipeline gives each site a `worker` whose `writes` are those files, then a reviewer; then one integration check. Use `isolation: "worktree"` only for sites whose edits spread to files you can't name upfront.

**Declare the plan.** List the agents you already know in `meta.phases[].agents`, with exactly the labels your `agent()` calls use (a call labelled `"auth r1"` doesn't claim a planned `"auth"`), and make those calls in that phase (with `phase()` or the `phase` option), so the user sees the plan before it runs and can skip an agent. Leave a phase's `agents` out when its count depends on what earlier phases find, or when calls repeat across rounds.

**No silent caps.** When you bound coverage (top N, sampling, one round only), `log()` what was dropped and return it, because a silent cut reads as "covered everything":

```js fragment
const MAX_FILES = 40;
const files = args.files.slice(0, MAX_FILES);
const skipped = args.files.slice(MAX_FILES);
if (skipped.length > 0) log(`Reviewing ${files.length} files; skipped ${skipped.join(", ")}`);
```

**Return what you act on.** Return a compact structured value: confirmed findings with evidence, what was refuted or dropped, and what wasn't covered. The results journal keeps every agent's full output.

## Review and verification

Find by dimension, merge the reports of all finders (a justified barrier, since it needs every finder's results), then give each finding three independent `reviewer` refuters and keep it only when a majority can't refute it. Deduplicating on `file:line` alone would silently drop a second, different defect on the same line, so an agent merges the reports that share a location:

```js
export const meta = {
  name: "review-changes",
  description: "Review a change by dimension, then adversarially verify each finding",
  args: {
    type: "object",
    properties: { scope: { type: "string" } },
    required: ["scope"],
    additionalProperties: false,
  },
  phases: [
    {
      title: "Find",
      agents: ["find:correctness", "find:security", "find:error handling", "find:tests"],
    },
    { title: "Merge", detail: "only findings reported at the same location" },
    { title: "Verify", detail: "three refuters per finding, majority vote" },
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
          claim: { type: "string" },
          evidence: { type: "string" },
        },
        required: ["file", "line", "claim", "evidence"],
        additionalProperties: false,
      },
    },
  },
  required: ["findings"],
  additionalProperties: false,
};
const VERDICT = {
  type: "object",
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
  required: ["refuted", "reason"],
  additionalProperties: false,
};

const key = (finding) => `${finding.file}:${finding.line}`;

// One location can hold one defect reported twice or two different defects, so an agent merges
// the reports that share a location, against any defects already known there. A lone new report
// passes through, and a merge that fails keeps every report.
const distinct = (findings, known = []) => {
  const groups = new Map();
  for (const finding of findings)
    groups.set(key(finding), [...(groups.get(key(finding)) ?? []), finding]);
  return parallel(
    [...groups].map(([location, group]) => () => {
      const before = known.filter((finding) => key(finding) === location);
      if (group.length === 1 && before.length === 0) return group;
      return agent(
        `Defects reported at ${location}:\n${JSON.stringify(group)}\nAlready known there:\n${JSON.stringify(before)}\nRead the code, then return each distinct defect that isn't already known, once, merging reports of the same defect.`,
        { label: `merge ${location}`, phase: "Merge", profile: "reviewer", schema: FINDINGS },
      ).then((merged) => merged?.findings ?? group);
    }),
  ).then((lists) => lists.filter(Boolean).flat());
};

// Three independent skeptics; the finding survives only if at least two confirm it.
const survives = (finding) =>
  parallel(
    [1, 2, 3].map(
      (n) => () =>
        agent(
          `Try to refute this reported defect against the actual code. Answer refuted: true unless you can confirm it is real; when unsure, it is refuted.\n${JSON.stringify(finding)}`,
          {
            label: `refute ${key(finding)} #${n}`,
            phase: "Verify",
            profile: "reviewer",
            schema: VERDICT,
          },
        ),
    ),
  ).then((votes) => votes.filter((vote) => vote && !vote.refuted).length >= 2);

const DIMENSIONS = ["correctness", "security", "error handling", "tests"];
const reviews = await parallel(
  DIMENSIONS.map(
    (dimension) => () =>
      agent(
        `Review ${args.scope} for ${dimension} problems. Read the changed code and what it calls. Report only defects you can point to, each with file, line, claim and evidence.`,
        { label: `find:${dimension}`, phase: "Find", profile: "reviewer", schema: FINDINGS },
      ),
  ),
);

const findings = await distinct(reviews.filter(Boolean).flatMap((review) => review.findings));
log(`${findings.length} distinct findings to verify`);

const kept = await parallel(findings.map((finding) => () => survives(finding)));
const confirmed = findings.filter((_, index) => kept[index] === true);
const refuted = findings.filter((_, index) => kept[index] !== true);
return { confirmed, refuted };
```

Without the merge, the same shape is a pipeline that verifies each finder's findings as soon as it returns: `pipeline(DIMENSIONS, find, (review) => parallel((review?.findings ?? []).map(...)))`.

**Perspective-diverse verify.** When a finding can be wrong in more than one way, give each verifier a distinct lens instead of N identical refuters:

```js fragment
const LENSES = [
  "correctness: is the described behavior actually wrong?",
  "reproduction: can you construct a concrete input or call sequence that triggers it?",
  "impact: does any caller in this repository reach it?",
];
const holdsUp = (finding) =>
  parallel(
    LENSES.map(
      (lens) => () =>
        agent(
          `Judge this reported defect through one lens only, ${lens} Answer refuted: true if it fails that lens.\n${JSON.stringify(finding)}`,
          { phase: "Verify", profile: "reviewer", schema: VERDICT },
        ),
    ),
  ).then((votes) => votes.filter((vote) => vote && !vote.refuted).length >= 2);
```

**Loop until dry.** For discovery of unknown size, keep finding until two consecutive rounds turn up nothing new. Deduplicate against everything seen, not only what was confirmed, or refuted findings come back every round and the loop never ends. Show the finders the known claims rather than only their locations, so they can still report a different defect on a line already seen. Bound the rounds and log when the bound cut the search short:

```js fragment
const AREAS = args.areas;
const seen = [];
const confirmed = [];
let dry = 0;
let round = 0;
while (dry < 2 && round < 8) {
  round++;
  const known = seen.map(({ file, line, claim }) => ({ file, line, claim }));
  const found = await parallel(
    AREAS.map(
      (area) => () =>
        agent(`Find defects in ${area}. Skip these, already reported: ${JSON.stringify(known)}`, {
          label: `find:${area} r${round}`,
          phase: "Find",
          profile: "reviewer",
          schema: FINDINGS,
        }),
    ),
  );
  const fresh = await distinct(
    found.filter(Boolean).flatMap((review) => review.findings),
    seen,
  );
  if (fresh.length === 0) {
    dry++;
    continue;
  }
  dry = 0;
  seen.push(...fresh);
  const kept = await parallel(fresh.map((finding) => () => survives(finding)));
  confirmed.push(...fresh.filter((_, index) => kept[index] === true));
}
if (dry < 2) log(`Stopped after ${round} rounds while still finding new defects`);
```

**Judge panel.** When the solution space is wide, generate independent attempts from different angles, score them with independent judges, and synthesize from the winner while grafting the best of the rest:

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
const ANGLES = [
  "the smallest change that works",
  "robustness to future change",
  "the user-facing behavior",
];
const plans = (
  await parallel(
    ANGLES.map(
      (angle) => () =>
        agent(`Design ${args.goal}. Optimize for ${angle}.`, {
          phase: "Design",
          profile: "planner",
          schema: PLAN,
        }),
    ),
  )
).filter(Boolean);
if (plans.length === 0) return { error: "No plan came back." };
const picks = await parallel(
  [1, 2, 3].map(
    (n) => () =>
      agent(
        `Judge these plans for ${args.goal} on correctness, risk and effort. Name the best by its 0-based index.\n${JSON.stringify(plans)}`,
        { label: `judge #${n}`, phase: "Judge", profile: "reviewer", schema: PICK },
      ),
  ),
);
const votes = plans.map((_, index) => picks.filter((pick) => pick?.best === index).length);
const winner = votes.indexOf(Math.max(...votes));
return await agent(
  `Write the final plan for ${args.goal}. Start from plan ${winner} and graft the strongest ideas of the others.\n${JSON.stringify(plans)}`,
  { phase: "Synthesize", profile: "planner", schema: PLAN },
);
```

**Multi-modal sweep.** One search method misses things another finds, so run several blind to each other, then deep-read the union:

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
const MODES = [
  "by name: search for the symbol, its aliases and re-exports",
  "by behavior: find code that has the same effect without naming it",
  "by tests: find tests and fixtures that exercise it",
  "by history: use git log -S and recent diffs that touched it",
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
          `Read ${path} closely and explain how it bears on this question: ${args.question}\nA search flagged it because: ${why}`,
          { label: `read ${path}`, phase: "Deep read", profile: "scout" },
        ),
  ),
);
```

**Completeness critic.** End with an agent that asks what is missing: an area not searched, a claim not verified, a planned file not changed. Its gaps become the next round, or the next workflow:

```js fragment
const GAPS = {
  type: "object",
  properties: { gaps: { type: "array", items: { type: "string" } } },
  required: ["gaps"],
  additionalProperties: false,
};
const critic = await agent(
  `This workflow was asked to: ${args.goal}\nIt covered ${seen.length} findings across ${AREAS.join(", ")}.\nList what is missing: areas not searched, claims not verified, modalities not run. Return an empty list if nothing is.`,
  { phase: "Critic", profile: "reviewer", schema: GAPS },
);
if (critic && critic.gaps.length > 0) log(`Critic found ${critic.gaps.length} gaps`);
```

## Large implementations: claims first

Writers in the shared checkout follow file claims. `writes` lists the exact workspace-relative files an agent may change (no directories, globs, `./` or leading `/`), at most 64 per writer. Writers with disjoint claims run in parallel; overlapping claims simply queue, and a writer without `writes` runs alone. A writer that touches a file it didn't claim is contained and new writers pause until you review it, so every list must be complete, tests, fixtures and docs included. A malformed claim is an invalid call, which fails the whole run, so check the planner's lists before passing them and send any unit whose list looks doubtful to a worktree.

Use `isolation: "worktree"` only for units whose files can't be known upfront or that overlap heavily; in the session's worktree writer mode every writer gets one anyway. A worktree unit's proposal isn't in the checkout: it comes back in the notification for you to review and integrate with `subagent_workspace`.

Plan with claims, implement each unit with a `worker`, review each unit as it finishes, then run one integration check and one completeness check against the plan:

```js
export const meta = {
  name: "implement-change",
  description: "Plan claimed units, implement them in parallel, review each, then check the whole",
  args: {
    type: "object",
    properties: { goal: { type: "string" }, check: { type: "string" } },
    required: ["goal", "check"],
    additionalProperties: false,
  },
  phases: [
    { title: "Plan", agents: [{ label: "plan", profile: "planner" }] },
    { title: "Implement", detail: "one worker per unit, claiming its files" },
    { title: "Review", detail: "each unit as it finishes" },
    {
      title: "Check",
      agents: [
        { label: "integration", profile: "reviewer" },
        { label: "completeness", profile: "reviewer" },
      ],
    },
  ],
};

const PLAN = {
  type: "object",
  properties: {
    units: {
      type: "array",
      items: {
        type: "object",
        properties: {
          title: { type: "string" },
          task: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          filesKnown: { type: "boolean" },
        },
        required: ["title", "task", "files", "filesKnown"],
        additionalProperties: false,
      },
    },
  },
  required: ["units"],
  additionalProperties: false,
};
const REVIEW = {
  type: "object",
  properties: { ok: { type: "boolean" }, problems: { type: "array", items: { type: "string" } } },
  required: ["ok", "problems"],
  additionalProperties: false,
};

const plan = await agent(
  `Plan this change: ${args.goal}\nSplit it into units that can be implemented in parallel, with as little file overlap as possible. For each unit give a self-contained task and the complete list of files it will create or modify, tests, fixtures and docs included: exact workspace-relative file paths such as src/parser.ts (no directories or globs), at most 64. Set filesKnown to false only when the files can't be known before doing the work.`,
  { label: "plan", phase: "Plan", profile: "planner", schema: PLAN },
);
if (!plan || plan.units.length === 0) return { error: "The planner returned no units." };

// A malformed claim fails the run and a glob claims no real file, so a unit with anything
// doubtful runs in a worktree instead: globs, absolute or Windows paths, backslashes, control
// characters, surrounding spaces, empty or dot segments.
const DOUBTFUL = /[*?[\]{}\\\u0000-\u001f\u007f-\u009f]|^[a-zA-Z]:|^\s|\s$/u;
const claimable = (files) =>
  files.length > 0 &&
  files.length <= 64 &&
  files.every(
    (file) =>
      file.length <= 512 &&
      !DOUBTFUL.test(file) &&
      file.split("/").every((part) => part !== "" && part !== "." && part !== ".."),
  );

const units = await pipeline(
  plan.units,
  (unit) => {
    const isolated = !unit.filesKnown || !claimable(unit.files);
    if (isolated) log(`${unit.title}: runs in a worktree; review its proposal`);
    const scope = isolated
      ? "You work in your own worktree."
      : `Change only these files: ${unit.files.join(", ")}.`;
    return agent(
      `${unit.task}\nThis is one unit of a larger change: ${args.goal}\n${scope} Run the focused checks for what you changed and report it.`,
      {
        label: `implement:${unit.title}`,
        phase: "Implement",
        profile: "worker",
        ...(isolated ? { isolation: "worktree" } : { writes: unit.files }),
      },
    ).then((report) => ({ unit, isolated, report }));
  },
  ({ unit, isolated, report }) => {
    if (report === null) return { unit: unit.title, ok: false, problems: ["the worker failed"] };
    if (isolated) return { unit: unit.title, ok: null, problems: ["review its worktree proposal"] };
    return agent(
      `Review this just-implemented unit of: ${args.goal}\nTask: ${unit.task}\nFiles: ${unit.files.join(", ")}\nWorker report: ${report}\nRead the changed files and report anything wrong or incomplete.`,
      { label: `review:${unit.title}`, phase: "Review", profile: "reviewer", schema: REVIEW },
    ).then((review) => ({
      unit: unit.title,
      ok: review ? review.ok : false,
      problems: review ? review.problems : ["the review failed"],
    }));
  },
);

phase("Check");
const [integration, completeness] = await parallel([
  () =>
    agent(
      `The shared-checkout units of this change were just implemented: ${args.goal}\nRun ${args.check}. Report each failure with its file and likely cause; don't edit files.`,
      { label: "integration", profile: "reviewer", schema: REVIEW },
    ),
  () =>
    agent(
      `Compare this plan with the uncommitted changes in the checkout. Report planned work that is missing or incomplete, and changes outside the plan.\nPlan: ${JSON.stringify(plan.units)}`,
      { label: "completeness", profile: "reviewer", schema: REVIEW },
    ),
]);
return { units: units.filter(Boolean), integration, completeness };
```

If the session's writer mode is worktree, every writer gets a worktree and nothing reaches the checkout until you integrate it: leave the per-unit review and the checks out of the script, review the proposals with `subagent_workspace`, and run the integration check after integrating them.

To repair as you go, add a stage after the review that runs the worker again with the review's problems and the same `writes`. Worktree proposals reach the checkout only once you integrate them, so run the integration check again after that.

## Pi specifics

- **Profiles** choose the model and effort; `model`, `effort` and `agentType` are rejected. `scout` maps code cheaply without judging it, `researcher` consults external sources, `planner` designs and splits work, `reviewer` finds and verifies problems, `worker` is the writer profile, and `generalist` is the default. `oracle` forks your conversation by default, so it sees it; the others start fresh. `writes` or `isolation` on a read-only profile is an invalid call.
- **Prompts are self-contained.** Agents don't see this conversation, so give each one the goal, the paths, the constraints and the user's words it needs. They already follow the workspace's `AGENTS.md` and know their final answer is data for your script, so don't paste repository rules; name a specific rule only when a stage depends on it.
- **The final answer is the return value.** Without `schema`, `agent()` returns text. With `schema`, it returns the validated value, and the agent retries when its value doesn't match. Use object schemas with `required` and `additionalProperties: false`. `$ref` and `$defs` are rejected, and every pattern must compile with the `u` flag.
- **Expect `null`.** `agent()` resolves `null` when its agent fails, is stopped or is skipped, and an item that throws inside `parallel()` or `pipeline()` becomes `null`. `pipeline()` passes a `null` result on to the next stage, so start a stage with `if (!previous) return null` or read `previous?.field ?? []`. Filter with `.filter(Boolean)` before using results.
- **Invalid calls fail the run**, even inside `parallel()` and `pipeline()`: an unknown option or profile, a bad schema or claim, writer options on a read-only profile, or more than 1,000 calls. A budget error isn't an invalid call; a `catch` around `agent()` should rethrow errors whose `name` isn't `WorkflowBudgetError`.
- **Determinism.** `Date.now()`, `new Date()` and `Math.random()` throw, and there are no timers, `fetch`, files or modules, so runs can resume. Vary prompts by index and pass dates through `args`. Await every `agent()` call: agents still running when the script returns are stopped.
- **Resume and extend.** To fix a failed run or add a stage to a finished one, edit the script's file (an inline script's saved copy is named in the start result) and start it again with the same `args` and `resumeFromRunId`. Calls with the same prompt, profile, schema, isolation and writes reuse their results; labels and phases don't matter. Once a writer call without `isolation: "worktree"` runs live, because it changed, is new or didn't finish before, every later call runs live too, so add new stages after the writers you keep. Don't restart a run the user stopped unless they ask.
- **Read the results journal** that the notification and status name before you diagnose an empty or surprising result: one line per finished `agent()` call with what it actually returned.

## Run it

- **Pass one-off work inline.** Give the script as `script`: the run keeps a private copy, named in the start result, that you can edit and start again with `resumeFromRunId`. Write a saved workflow, in `.pi/workflows/` of a trusted project or the agent directory's `workflows/` (the tool description names this session's directories), only when the user wants a workflow to reuse.
- **End your turn after starting it.** `start` returns at once. Finish any unrelated work, then end your turn: the run's one notification starts your next turn with its result or error, and you report from it then. Don't call `status` to wait: it can't make the run finish sooner, and a repeat while nothing changed gets one line. Agents may ask you questions: answer with `subagent_reply` and the workflow continues. Use `status` when the user asks how it is going or a run seems stuck; it also shows anything else that waits on you.
- **Don't stop a run to answer sooner.** Its unfinished agents' work is lost, and a resume reruns them at full cost. Stop a run only when the user asks or it is clearly broken, such as a wrong script or a runaway loop; a run you stop sends no notification, since the stop result has its final state.
