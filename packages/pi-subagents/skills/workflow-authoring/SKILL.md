---
name: workflow-authoring
description: Claude Code's workflow-authoring reference adapted to Pi's subagent_workflow tool, covering when to run a workflow, pipelines and barriers, quality patterns, scaling to the request, claims-first implementations and budgets. Read before writing a non-trivial script for a workflow the user opted into with ultracode or /ultracode.
---

# Workflow authoring

A workflow structures work across many agents: to be **comprehensive** (decompose and cover in parallel), to be **confident** (independent perspectives and adversarial checks before committing), or to take on **scale one context can't hold** (migrations, audits, broad sweeps, large implementations). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

This guide follows Claude Code's workflow-authoring reference, translated to Pi's API; the sections from [Large implementations](#large-implementations-claims-first) on cover what only Pi has. The `subagent_workflow` tool description is the API reference: hooks, options, limits, saved workflows and resume. Complete examples run as written; blocks marked `fragment` reuse the schemas, helpers and `args` of the examples around them.

## When to use a workflow

Use a workflow when the work splits into many independent pieces, when findings need independent verification before you commit to them, or when it is too big for one context. Use `subagent_start` for one to three agents you steer yourself, and work solo on conversational turns and trivial mechanical edits. A `/ultracode <task>` request asks for a workflow explicitly: run one even for a small task.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the call sites, scope the diff) to discover the work list, then call `subagent_workflow` to pipeline over it. Pass the list as `args` (at most 64 KiB of JSON), or make discovery the first stage: a `scout` whose schema returns the list. You don't need to know the shape before the _task_, only before the _orchestration step_.

Common single-phase workflows you can chain across turns:

- **Understand:** parallel readers over relevant subsystems → structured map.
- **Design:** judge panel of N independent approaches → scored synthesis.
- **Review:** dimensions → find → adversarially verify (the [find-bugs example](#scale-to-what-the-user-asked-for)), or rounds of it until nothing new for an audit (the [exhaustive review](#composing-patterns-exhaustive-review)).
- **Research:** multi-modal sweep → deep-read → synthesize.
- **Migrate:** discover sites → transform each (a `worker` claiming the site's files, or worktree isolation) → verify.
- **Implement:** plan claimed units → a worker per unit → review each (see [Large implementations](#large-implementations-claims-first)).

For larger work, run several in sequence: read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

## Ultracode

When ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce; token cost is not a constraint, except a budget the user gives (see [Budgets](#budgets)). For multi-phase work (understand → design → implement → review), that often means several workflows in sequence, one per phase, so you stay in the loop between them. The [quality patterns](#quality-patterns) (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings, unless the work is trivial or already verified. Work solo only on conversational turns or trivial mechanical edits.

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

Dedup across all findings before expensive verification:

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

Accumulate to a target. Bound the rounds as well, or a finder that keeps returning nothing loops to the 1,000-call cap:

```js fragment
const bugs = [];
let round = 0;
while (bugs.length < 10 && round < 20) {
  round++;
  const result = await agent(
    `Find bugs in this codebase. Skip these, already found: ${JSON.stringify(bugs)}`,
    { label: `find r${round}`, profile: "reviewer", schema: BUGS },
  );
  bugs.push(...(result?.bugs ?? []));
  log(`${bugs.length}/10 found`);
}
if (bugs.length < 10) log(`Stopped after ${round} rounds with ${bugs.length}/10 found`);
```

### Loop until budget

Scale depth to the user's budget: the start's `budget`, from `/ultracode +500k` or a limit the user states. Guard on `budget.total`: with no budget set, `remaining()` is `Infinity` and the loop would run straight to the 1,000-call cap. A call that fails at once spends nothing and leaves `remaining()` unchanged, so stop on a failed call rather than retry it:

```js fragment
const bugs = [];
while (budget.total && budget.remaining() > 50_000) {
  const result = await agent(
    `Find bugs in this codebase. Skip these, already found: ${JSON.stringify(bugs)}`,
    { profile: "reviewer", schema: BUGS },
  );
  if (!result) {
    const unspent = Math.round(budget.remaining() / 1000);
    log(`A finder failed; stopping with ${bugs.length} found and ${unspent}k unspent`);
    break;
  }
  bugs.push(...result.bugs);
  log(`${bugs.length} found, ${Math.round(budget.remaining() / 1000)}k remaining`);
}
```

### Composing patterns: exhaustive review

Find → dedup against everything seen → a diverse-lens panel → loop until dry, then a synthesis and a completeness critic whose gaps become the next round. This is the shape for "thoroughly audit this" or "be comprehensive": every area through every lens, round after round, so discovery spends across rounds instead of stopping after one pass.

```js
export const meta = {
  name: "exhaustive-review",
  description:
    "Find bugs in rounds until two find nothing new, judge each through three lenses, then synthesize and look for gaps",
  args: {
    type: "object",
    properties: {
      scope: { type: "string" },
      areas: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["scope", "areas"],
    additionalProperties: false,
  },
  phases: [
    { title: "Find", detail: "every area through every lens, each round" },
    { title: "Verify", detail: "three lenses per fresh bug; real when two agree" },
    { title: "Synthesize" },
    { title: "Critic", detail: "its gaps become the next round" },
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
  properties: { real: { type: "boolean" }, reason: { type: "string" } },
  required: ["real", "reason"],
  additionalProperties: false,
};
const GAPS = {
  type: "object",
  properties: { gaps: { type: "array", items: { type: "string" } } },
  required: ["gaps"],
  additionalProperties: false,
};

const FIND_LENSES = ["logic and edge cases", "security and trust boundaries", "errors and cleanup"];
const JUDGE_LENSES = ["correctness", "security", "reproduction"];
const MAX_ROUNDS = 10;
const MAX_CRITIC_PASSES = 2;
// Output tokens, for a budget: a first guess at a finder, a judge, and a synthesis or critic.
const FINDER_COST = 45_000;
const JUDGE_COST = 10_000;
const FINAL_COST = 10_000;
// No agent runs between barriers, so remaining() is exact there. Without a budget, all fits.
const affords = (tokens) => !budget.total || budget.remaining() >= tokens;

// Reports of one bug cite lines a little apart: the same file within 3 lines is the same bug.
const sameBug = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= 3;

const seen = [];
const confirmed = [];
const unverified = [];
const searched = [];
// No silent caps: what a cap, the budget or failed finders cut short is logged and returned.
const cutShort = [];
const note = (message) => {
  log(message);
  cutShort.push(message);
};
let rounds = 0;

// Loop until dry: another round until two in a row find nothing new. Returns whether it got there.
const findUntilDry = async (finders) => {
  let answeredRounds = 0;
  let dry = 0;
  let roundCost = finders.length * FINDER_COST; // then what the last round spent
  while (dry < 2) {
    const skipped = `${finders.length} finders didn't run round ${rounds + 1}`;
    if (rounds >= MAX_ROUNDS) {
      note(`The ${MAX_ROUNDS}-round cap stopped discovery before it ran dry; ${skipped}`);
      break;
    }
    if (!affords(roundCost + 2 * FINAL_COST)) {
      note(`The budget stopped discovery before it ran dry; ${skipped}`);
      break;
    }
    rounds++;
    const before = budget.spent();
    const known = seen.map(({ file, line, desc }) => ({ file, line, desc }));
    const results = await parallel(
      finders.map(
        (finder) => () =>
          agent(
            `${finder.task}\nScope: ${args.scope}\nReport only bugs you can point to in the code, each with file, line, a one-line desc and evidence. Skip these, already reported:\n${JSON.stringify(known)}`,
            {
              label: `${finder.label} r${rounds}`,
              phase: "Find",
              profile: "reviewer",
              schema: BUGS,
            },
          ),
      ),
    );
    // A round in which no finder answered isn't a dry round: nothing was searched.
    const answered = results.filter(Boolean);
    if (answered.length === 0) {
      note(`Round ${rounds}: every finder failed or the budget refused it, so discovery stopped`);
      break;
    }
    answeredRounds++;
    const found = answered.flatMap((result) => result.bugs);
    // Dedup against everything seen, judge-rejected bugs included: plain code, not an agent.
    const fresh = [];
    for (const bug of found) {
      if (seen.some((other) => sameBug(other, bug))) continue;
      seen.push(bug);
      fresh.push(bug);
    }
    log(`Round ${rounds}: ${fresh.length} new of ${found.length} reported`);
    if (fresh.length === 0) {
      dry++;
    } else {
      dry = 0;
      // Judge what the budget pays for, keeping room for the synthesis and critic.
      const panelCost = JUDGE_LENSES.length * JUDGE_COST;
      const fits = budget.total
        ? Math.max(0, Math.floor((budget.remaining() - 2 * FINAL_COST) / panelCost))
        : fresh.length;
      const judging = fresh.slice(0, fits);
      if (judging.length < fresh.length) {
        note(
          `The budget left ${fresh.length - judging.length} new bugs of round ${rounds} unjudged`,
        );
        unverified.push(...fresh.slice(judging.length));
      }
      // Every fresh bug judged concurrently, each through three distinct lenses.
      const judged = await parallel(
        judging.map(
          (bug) => () =>
            parallel(
              JUDGE_LENSES.map(
                (lens) => () =>
                  agent(
                    `Judge this reported bug via the ${lens} lens: is it real? It need not be a ${lens} issue to be real. Read the code.\n${JSON.stringify(bug)}`,
                    {
                      label: `${lens} ${bug.file}:${bug.line}`,
                      phase: "Verify",
                      profile: "reviewer",
                      schema: VERDICT,
                    },
                  ),
              ),
            ).then((votes) => {
              const cast = votes.filter(Boolean);
              const yes = cast.filter((vote) => vote.real).length;
              return { real: yes >= 2, decided: yes >= 2 || cast.length - yes >= 2 };
            }),
        ),
      );
      judging.forEach((bug, index) => {
        if (judged[index]?.real) confirmed.push(bug);
        // Too few votes came back to decide, such as judges the budget refused.
        else if (!judged[index]?.decided) unverified.push(bug);
      });
    }
    roundCost = budget.spent() - before;
  }
  if (answeredRounds > 0) searched.push(...finders.map((finder) => finder.task));
  return dry >= 2;
};

let finders = args.areas.flatMap((area) =>
  FIND_LENSES.map((lens) => ({
    label: `${area} · ${lens}`,
    task: `Find ${lens} bugs in ${area}.`,
  })),
);
let report = null;
let gaps = [];
for (let pass = 1; pass <= MAX_CRITIC_PASSES; pass++) {
  const searchedBefore = searched.length;
  const ranDry = await findUntilDry(finders);
  if (searched.length === searchedBefore) break; // nothing searched, so nothing new to report
  // A top-level call the budget refuses fails the run, so check before each one.
  if (!affords(FINAL_COST)) {
    note("The budget left nothing for the synthesis and the critic");
    break;
  }
  report = await agent(
    `Write the final report of a review of ${args.scope}: the confirmed bugs grouped by impact, most severe first, each with file, line and evidence.\n${JSON.stringify(confirmed)}`,
    { label: `synthesis ${pass}`, phase: "Synthesize", profile: "reviewer" },
  );
  if (!affords(FINAL_COST)) {
    note("The budget left nothing for the critic");
    break;
  }
  const critic = await agent(
    `A review of ${args.scope} ran these finders over ${rounds} rounds and confirmed ${confirmed.length} of ${seen.length} reported bugs:\n${searched.join("\n")}\nReport:\n${report ?? "(none)"}\nWhat is missing: an area or file not searched, a lens not applied, a claim not verified, a source not read? Write each gap as a self-contained task for one finder; return an empty list if nothing is missing.`,
    { label: `critic ${pass}`, phase: "Critic", profile: "reviewer", schema: GAPS },
  );
  gaps = critic?.gaps ?? [];
  // What the critic finds becomes the next round of work, once discovery ran dry.
  if (gaps.length === 0 || !ranDry) break;
  finders = gaps.map((gap, index) => ({ label: `gap ${pass}.${index + 1}`, task: gap }));
}
const unsearched = gaps.filter((gap) => !searched.includes(gap));
if (unsearched.length > 0)
  note(`The critic's ${unsearched.length} gaps weren't searched: ${unsearched.join("; ")}`);
if (unverified.length > 0) note(`${unverified.length} reported bugs stay unverified`);
const rejected = seen.filter((bug) => !confirmed.includes(bug) && !unverified.includes(bug));
return { confirmed, unverified, rejected, unsearched, cutShort, report };
```

Dedup against `seen`, not `confirmed`: otherwise judge-rejected findings reappear every round and the loop never converges. A round in which no finder answered stops discovery instead of counting as dry, and a bug with too few votes back stays unverified rather than rejected. With a budget, a round starts only while the last round's cost and the end still fit, judging shrinks to what remains, and the synthesis and critic run only when they fit; the round cap and each budget check log and return what they cut short.

### Quality patterns

Common shapes; pick by task and compose freely.

**Adversarial verify.** Spawn N independent skeptics per finding, each prompted to refute it, and kill the finding if a majority refute. This keeps plausible-but-wrong findings from surviving:

```js fragment
// claim is one finding's text.
const REFUTAL = {
  type: "object",
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
  required: ["refuted", "reason"],
  additionalProperties: false,
};
const votes = await parallel(
  Array.from(
    { length: 3 },
    (_, n) => () =>
      agent(`Try to refute: ${claim}. Default to refuted: true if uncertain.`, {
        label: `refute #${n + 1}`,
        phase: "Verify",
        profile: "reviewer",
        schema: REFUTAL,
      }),
  ),
);
const survives = votes.filter(Boolean).filter((vote) => !vote.refuted).length >= 2;
```

**Perspective-diverse verify.** When a finding can fail in more than one way, give each verifier a distinct lens (correctness, security, performance, does it reproduce) instead of N identical refuters: diversity catches failure modes redundancy can't. The exhaustive review's panel does this.

**Judge panel.** Generate N independent attempts from different angles (MVP-first, risk-first, user-first), score them with parallel judges, and synthesize from the winner while grafting the best ideas from the runners-up. This beats one attempt iterated when the solution space is wide:

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
const ANGLES = ["MVP-first", "risk-first", "user-first"];
const plans = (
  await parallel(
    ANGLES.map(
      (angle) => () =>
        agent(`Design ${args.goal}. Take a ${angle} approach.`, {
          label: angle,
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
  `Write the final plan for ${args.goal}. Start from plan ${winner} and graft the best ideas of the others.\n${JSON.stringify(plans)}`,
  { phase: "Synthesize", profile: "planner", schema: PLAN },
);
```

**Loop-until-dry.** For discovery of unknown size (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new, as the exhaustive review does with K = 2. Simple counters (`while (count < N)`) miss the tail.

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
```

**Completeness critic.** A final agent that asks "what's missing: a modality not run, a claim unverified, a source unread?" What it finds becomes the next round of work, as in the exhaustive review.

**No silent caps.** If a workflow bounds coverage (top N, no retry, sampling), `log()` what was dropped and return it: silent truncation reads as "covered everything" when it didn't.

```js fragment
const MAX_FILES = 40;
const files = args.files.slice(0, MAX_FILES);
const skipped = args.files.slice(MAX_FILES);
if (skipped.length > 0) log(`Reviewing ${files.length} files; skipped ${skipped.join(", ")}`);
```

## Scale to what the user asked for

"Find any bugs" → a few finders, single-vote verify. "Thoroughly audit this" or "be comprehensive" → a larger finder pool over rounds until nothing new, a 3–5 vote adversarial pass (or a panel of distinct lenses), a synthesis stage and a completeness critic: the [exhaustive review](#composing-patterns-exhaustive-review). When unsure, lean toward thoroughness for research, review and audit requests and toward brevity for quick checks.

"Find any bugs" in a change:

```js
export const meta = {
  name: "find-bugs",
  description: "A few finders over the changed files, dedup, then one skeptic per bug",
  args: {
    type: "object",
    properties: { files: { type: "array", items: { type: "string" }, minItems: 1 } },
    required: ["files"],
    additionalProperties: false,
  },
  phases: [
    { title: "Find", agents: ["find:logic", "find:errors", "find:edge cases"] },
    { title: "Verify", detail: "one skeptic per bug" },
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
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
  required: ["refuted", "reason"],
  additionalProperties: false,
};

const LENSES = ["logic", "errors", "edge cases"];
// Reports of one bug cite lines a little apart: the same file within 3 lines is the same bug.
const sameBug = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= 3;
const dedupe = (bugs) => {
  const kept = [];
  for (const bug of bugs) if (!kept.some((other) => sameBug(other, bug))) kept.push(bug);
  return kept;
};

const found = await parallel(
  LENSES.map(
    (lens) => () =>
      agent(
        `Review the uncommitted changes to ${args.files.join(", ")} for ${lens} bugs. Report only real defects, each with file, line, a one-line desc and evidence.`,
        { label: `find:${lens}`, phase: "Find", profile: "reviewer", schema: BUGS },
      ),
  ),
);
// A justified barrier: dedup across every finder, and skip verifying when nothing was found.
const bugs = dedupe(found.filter(Boolean).flatMap((result) => result.bugs));
if (bugs.length === 0) return { bugs: [], unconfirmed: [] };
const verdicts = await parallel(
  bugs.map(
    (bug) => () =>
      agent(
        `Try to refute this reported bug against the code. Default to refuted: true if uncertain.\n${JSON.stringify(bug)}`,
        {
          label: `verify ${bug.file}:${bug.line}`,
          phase: "Verify",
          profile: "reviewer",
          schema: VERDICT,
        },
      ),
  ),
);
return {
  bugs: bugs.filter((_, index) => verdicts[index]?.refuted === false),
  unconfirmed: bugs.filter((_, index) => verdicts[index]?.refuted !== false),
};
```

These patterns aren't exhaustive: compose novel harnesses when the task calls for it (tournament brackets, self-repair loops, staged escalation, whatever fits). Use a workflow for multi-step orchestration where control flow should be deterministic (loops, conditionals, fan-out) rather than model-driven.

## What agents return

Agents are told their final text is the return value, not a human-facing message, so they return raw data. For structured output, use the `schema` option: validation happens at the tool-call layer, so the agent retries on a mismatch. Agents get the workspace's instruction files (`AGENTS.md`) as you did: don't tell them to re-read those or paste their rules into the prompt; name the specific rule a stage needs, if any. They don't see this conversation, so give each prompt the goal, paths, constraints and user's words it needs.

## Large implementations: claims first

Writers in the shared checkout follow file claims. `writes` lists the exact workspace-relative files an agent may change (no directories, globs, `./` or leading `/`), at most 64 per writer. Writers with disjoint claims run in parallel, overlapping claims queue, and a writer without `writes` runs alone. A writer that touches a file it didn't claim is contained, and new writers pause until you review it, so every list must be complete, tests, fixtures and docs included. A malformed claim is an invalid call that fails the run, so check the planner's lists and send a doubtful unit to a worktree.

Use `isolation: "worktree"` only for units whose files can't be known upfront or that overlap heavily; its proposal comes back in the notification for you to review and integrate with `subagent_workspace`. Plan with claims, implement each unit with a `worker`, review each unit as it finishes, then run one integration check and one completeness check against the plan:

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

// A malformed claim fails the run, so a unit with anything doubtful runs in a worktree: globs,
// absolute or Windows paths, backslashes, control characters, surrounding spaces, empty or dot
// segments.
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

In the session's worktree writer mode every writer gets a worktree and nothing reaches the checkout until you integrate it: leave the per-unit review and the checks out of the script, and run them after integrating the proposals. To repair as you go, add a stage after the review that runs the worker again with the review's problems and the same `writes`.

## Budgets

The user sets a budget with `/ultracode +500k` or by stating a limit; pass it as the start's `budget` (output tokens). It is a hard ceiling: once it is spent, an `agent()` call whose agent hasn't started throws `WorkflowBudgetError`. Plan the run inside it before you write the script:

- **Scale depth to it, keeping room to finish.** Reserve what verification and the end need, and spend the rest on discovery: more finder rounds until they run dry or the budget can't pay for another, as the [exhaustive review](#composing-patterns-exhaustive-review) does. For multi-phase work, split the budget across the phases up front.
- **Use realistic costs per agent**: a finder reading a whole package spends 30k to 60k output tokens, a verifier checking one finding 5k to 15k, a synthesis or critic about 10k. Size the next round from what the last one spent, the change in `budget.spent()`.
- **Guard every phase and top-level call.** Check `budget.remaining()` first, shrink the phase to what fits (fewer finders or votes, the most severe findings first) and `log()` what you dropped. Inside `parallel()` or `pipeline()` a refused call becomes `null`, which is no answer: count its finding as unverified, not refuted. A refused top-level call fails the run and loses everything after it.
- **Expect wide phases to overshoot.** `budget.spent()` counts finished agents only, while the ceiling also counts running ones, so a phase wider than `remaining() / cost` overshoots and every later call is refused. Run a wide phase in waves:

```js fragment
// items, COST (output tokens per agent) and RESERVE (kept for what follows) are yours.
const results = [];
let next = 0;
while (next < items.length) {
  const fits = budget.total ? Math.floor((budget.remaining() - RESERVE) / COST) : items.length;
  if (fits < 1) break;
  const wave = items.slice(next, next + fits);
  next += wave.length;
  results.push(
    ...(await parallel(wave.map((item) => () => agent(item.prompt, { profile: "reviewer" })))),
  );
}
if (next < items.length)
  log(`The budget covered ${next} of ${items.length} items; skipped the rest`);
```

## Pi specifics

- **Profiles** choose the model and effort; `model`, `effort` and `agentType` are rejected. `scout` maps code cheaply, `researcher` consults external sources, `planner` designs and splits work, `reviewer` finds and verifies problems, `worker` writes, and `generalist` is the default. `oracle` forks your conversation; the others start fresh. Writer options on a read-only profile are an invalid call.
- **Schemas** are objects with `required` and `additionalProperties: false`; `$ref` and `$defs` are rejected, and every pattern must compile with the `u` flag.
- **Expect `null`.** `agent()` resolves `null` when its agent fails, is stopped or is skipped, and an item that throws inside `parallel()` or `pipeline()` becomes `null`, which `pipeline()` passes to the next stage. Filter with `.filter(Boolean)` or read `previous?.field ?? []`.
- **Invalid calls fail the run**, even inside `parallel()` and `pipeline()`: an unknown option or profile, a bad schema or claim, or more than 1,000 calls. A `catch` around `agent()` should rethrow errors whose `name` isn't `WorkflowBudgetError`.
- **Determinism.** `Date.now()`, `new Date()` and `Math.random()` throw, and there are no timers, `fetch`, files or modules, so runs can resume. Pass dates through `args`. Await every `agent()` call: agents still running when the script returns are stopped.
- **Declare the plan.** List the agents you already know in `meta.phases[].agents`, with exactly the labels your calls use, and make those calls in that phase, so the user sees the plan and can skip one. Leave `agents` out when a phase's count depends on earlier results or calls repeat across rounds.
- **Return what you act on**: confirmed findings with evidence, what was rejected or dropped, and what wasn't covered. The results journal keeps every agent's full output.
- **Resume and extend.** Edit the script's file (an inline script's saved copy is named in the start result) and start it again with the same `args` and `resumeFromRunId`. Calls with the same prompt, profile, schema, isolation and writes reuse their results. Once a writer call without `isolation: "worktree"` runs live, every later call runs live too, so add new stages after the writers you keep. Don't restart a run the user stopped unless they ask.
- **Read the results journal** that the notification and status name before you diagnose an empty or surprising result.

## Run it

- **Write the script on short lines**, with schemas and prompts as named constants: a syntax error names its line, which is easy to fix on a short one.
- **Pass one-off work inline** as `script`. Write a saved workflow, in `.pi/workflows/` of a trusted project or the agent directory's `workflows/`, only when the user wants one to reuse.
- **End your turn after starting it.** `start` returns at once; finish any unrelated work, then end your turn. The run's one notification starts your next turn with its result, and you report from it then. Don't call `status` to wait; use it when the user asks how it is going or a run seems stuck. Answer agents' questions with `subagent_reply`.
- **Don't stop a run to answer sooner.** Its unfinished agents' work is lost, and a resume reruns them at full cost. Stop a run only when the user asks or it is clearly broken, such as a wrong script or a runaway loop.
