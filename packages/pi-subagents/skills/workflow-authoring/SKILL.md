---
name: workflow-authoring
description: Claude Code's workflow-authoring reference adapted to Pi's subagent_workflow tool, covering when to run a workflow, pipelines and barriers, quality patterns, scaling to the request, claims-first implementations and budgets. Read before writing a non-trivial script for a workflow the user opted into with ultracode or /ultracode.
---

# Workflow authoring

A workflow structures work across many agents: to be **comprehensive** (decompose and cover in parallel), to be **confident** (independent perspectives and adversarial checks before committing), or to take on **scale one context can't hold** (migrations, audits, broad sweeps, large implementations). The script is where you encode that structure: what fans out, what verifies, what synthesizes.

This guide follows Claude Code's workflow-authoring reference, translated to Pi's API; the sections from [Large implementations](#large-implementations-claims-first) on cover what only Pi has. The `subagent_workflow` tool description is the API reference: hooks, options, limits, saved workflows and resume. Complete examples run as written; blocks marked `fragment` reuse the schemas, helpers and `args` of the examples around them.

## When to use a workflow

Use a workflow when the work splits into many independent pieces, when findings need independent verification before you commit to them, or when it is too big for one context. Use `subagent_start` for one to three agents you steer yourself, and work solo on conversational turns and trivial mechanical edits. A `/ultracode <task>` request opts that one task in, and the [Ultracode](#ultracode) rules below apply to it.

When you do call it, the right move is often **hybrid**: scout inline first (list the files, find the call sites, scope the diff) to discover the work list, then call `subagent_workflow` to pipeline over it. Pass the list as `args` (at most 64 KiB of JSON), or make discovery the first stage: a `scout` whose schema returns the list. You don't need to know the shape before the _task_, only before the _orchestration step_.

Common single-phase workflows you can chain across turns:

- **Understand:** parallel readers over relevant subsystems → structured map.
- **Design:** judge panel of N independent approaches → scored synthesis.
- **Review:** dimensions → find → adversarially verify (the [find-bugs example](#scale-to-what-the-user-asked-for)), or, for an audit, a wide first round plus gap rounds a critic proposes (the [exhaustive review](#composing-patterns-exhaustive-review)).
- **Research:** multi-modal sweep → deep-read → synthesize.
- **Migrate:** discover sites → transform each (a `worker` claiming the site's files, or worktree isolation) → verify.
- **Implement:** you build the core, then a worker per unit with disjoint claims, then a review workflow (see [Large implementations](#large-implementations-claims-first)).

For larger work, run several in sequence: read each result before deciding the next phase. You stay in the loop; each workflow is one well-scoped fan-out.

**One task is one workflow.** A review keeps find → dedup → verify → synthesize in the same script, and an audit keeps its rounds, panel and critic together. Chain workflows only between stages of larger work (understand → design → implement → review), never to split finding from verifying: a discovery-only workflow makes you read its raw findings to plan the next one, which is slower, fills your context with unverified claims, and returns nothing the user can act on.

## Ultracode

When ultracode is on, that opt-in is standing: author and run a workflow for every substantive task by default. The goal is the most exhaustive, correct answer you can produce; token cost is not a constraint, except a budget the user gives (see [Budgets](#budgets)). For multi-phase work (understand → design → implement → review), that often means several workflows in sequence, one per phase, so you stay in the loop between them; a single task such as a review or an audit stays one workflow, finding and verifying in the same script. The [quality patterns](#quality-patterns) (adversarial verify, multi-modal sweep, completeness critic, loop-until-dry) are the tools; pick what fits the task. Lean toward orchestrating with workflows and adversarially verifying your findings, unless the work is trivial or already verified. Work solo only on conversational turns, trivial mechanical edits and checks small enough to verify completely yourself, such as a diff of about ten changed lines or fewer: once you have traced every change through its callers with nothing left ambiguous, its findings are already verified, and a workflow would only repeat your reading. Independent agents verify findings you couldn't settle yourself. Say in your answer that you checked it yourself.

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

Dedup across all findings before expensive verification. Group by place (same file, lines a few apart), never by the claim's wording: finders describe one bug differently, so wording-based dedup turns three bugs into ten verifications.

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

A wide first round, verification as each round lands, then gap rounds a completeness critic proposes. This is the shape for "thoroughly audit this" or "be comprehensive". Scout first to list the areas (a file or a group of related files, a few hundred lines each) and give each its own finder, add a finder per cross-cutting failure class (concurrency, cleanup, error handling, data boundaries), then let the critic aim later rounds at what nobody covered. For a package of a few thousand lines that is typically 10 to 15 finders in the first round, four to six per gap round, and three rounds at most. You write the final report from what it returns.

```js
export const meta = {
  name: "exhaustive-review",
  description:
    "One finder per area and cross-cutting lens, three-lens verification, then gap rounds a critic proposes",
  args: {
    type: "object",
    properties: {
      scope: { type: "string" },
      areas: { type: "array", items: { type: "string" }, minItems: 1 },
      lenses: { type: "array", items: { type: "string" }, minItems: 1 },
    },
    required: ["scope", "areas", "lenses"],
    additionalProperties: false,
  },
  phases: [
    { title: "Find", detail: "one finder per area and lens, then the critic's angles" },
    { title: "Verify", detail: "three lenses per new bug; real when two agree" },
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

const JUDGE_LENSES = ["execution trace", "library and runtime semantics", "the author's defense"];
const MAX_ROUNDS = 3;
const MIN_ANGLES = 4;
const MAX_ANGLES = 6;
// Output tokens, for a budget: a first guess at a finder, a judge and a critic.
const FINDER_COST = 45_000;
const JUDGE_COST = 10_000;
const CRITIC_COST = 10_000;
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

// Every new bug judged concurrently, each through three distinct lenses; real when two agree.
const judge = async (bugs) => {
  const panelCost = JUDGE_LENSES.length * JUDGE_COST;
  const fits = budget.total
    ? Math.max(0, Math.floor((budget.remaining() - CRITIC_COST) / panelCost))
    : bugs.length;
  const judging = bugs.slice(0, fits);
  if (judging.length < bugs.length) {
    note(`The budget left ${bugs.length - judging.length} new bugs unjudged`);
    unverified.push(...bugs.slice(judging.length));
  }
  const verdicts = await parallel(
    judging.map(
      (bug) => () =>
        parallel(
          JUDGE_LENSES.map(
            (lens) => () =>
              agent(
                `Judge this reported bug through the ${lens} lens: is it real? It need not be a ${lens} issue to be real. Read the code, and default to real: false if uncertain.\n${JSON.stringify(bug)}`,
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
    if (verdicts[index]?.real) confirmed.push(bug);
    // Too few votes came back to decide, such as judges the budget refused.
    else if (!verdicts[index]?.decided) unverified.push(bug);
  });
};

let finders = [
  ...args.areas.map((area) => ({
    label: `area: ${area}`,
    task: `Find bugs in ${area}. Read it in full and follow calls into the rest of ${args.scope}.`,
  })),
  ...args.lenses.map((lens) => ({
    label: `lens: ${lens}`,
    task: `Find ${lens} bugs anywhere in ${args.scope}.`,
  })),
];
// Verification runs alongside the next rounds; every batch is awaited before returning.
const verifying = [];
let rounds = 0;
while (finders.length > 0) {
  if (rounds >= MAX_ROUNDS) {
    note(`The ${MAX_ROUNDS}-round cap left ${finders.length} critic angles unsearched`);
    break;
  }
  if (!affords(finders.length * FINDER_COST + CRITIC_COST)) {
    note(`The budget stopped discovery; ${finders.length} finders didn't run`);
    break;
  }
  rounds++;
  const known = seen.map(({ file, line, desc }) => ({ file, line, desc }));
  const results = await parallel(
    finders.map(
      (finder) => () =>
        agent(
          `${finder.task}\nReport each bug you can point to in the code, with file, line, a one-line desc and evidence. Skip these, already reported:\n${JSON.stringify(known)}`,
          { label: `${finder.label} r${rounds}`, phase: "Find", profile: "reviewer", schema: BUGS },
        ),
    ),
  );
  const answered = results.filter(Boolean);
  if (answered.length === 0) {
    note(`Round ${rounds}: every finder failed or the budget refused it, so discovery stopped`);
    break;
  }
  searched.push(...finders.map((finder) => finder.task));
  // Dedup against everything seen, judge-rejected bugs included: plain code, not an agent.
  const fresh = [];
  for (const bug of answered.flatMap((result) => result.bugs)) {
    if (seen.some((other) => sameBug(other, bug))) continue;
    seen.push(bug);
    fresh.push(bug);
  }
  log(`Round ${rounds}: ${fresh.length} new bugs from ${answered.length} finders`);
  if (fresh.length > 0) verifying.push(judge(fresh));
  if (rounds >= MAX_ROUNDS) break;
  // A top-level call the budget refuses fails the run, so check before each one.
  if (!affords(CRITIC_COST)) {
    note("The budget left nothing for the critic");
    break;
  }
  const critic = await agent(
    `A review of ${args.scope} ran these finders:\n${searched.join("\n")}\nThey reported:\n${JSON.stringify(seen.map(({ file, line, desc }) => ({ file, line, desc })))}\nName ${MIN_ANGLES} to ${MAX_ANGLES} specific angles no finder covered: functions, cross-file interactions or event sequences likely to hide bugs. Write each as a self-contained task for one finder. Return fewer only when coverage is that close to complete, and an empty list when nothing is left.`,
    { label: `critic r${rounds}`, phase: "Critic", profile: "reviewer", schema: GAPS },
  );
  const gaps = critic?.gaps ?? [];
  if (gaps.length > MAX_ANGLES)
    note(`The critic proposed ${gaps.length} angles; searching the first ${MAX_ANGLES}`);
  finders = gaps
    .slice(0, MAX_ANGLES)
    .map((task, index) => ({ label: `gap ${rounds}.${index + 1}`, task }));
}
await Promise.all(verifying);
if (unverified.length > 0) note(`${unverified.length} reported bugs stay unverified`);
const rejected = seen.filter((bug) => !confirmed.includes(bug) && !unverified.includes(bug));
return { confirmed, unverified, rejected, rounds, cutShort };
```

Dedup against `seen`, not `confirmed`: otherwise judge-rejected findings reappear every round and the review never converges. Verification of one round runs while the critic plans the next and its finders search, and the script awaits every batch before it returns. A round in which no finder answered stops discovery, and a bug with too few votes back stays unverified rather than rejected. With a budget, a round starts only while its finders and the critic fit, judging shrinks to what remains, and each cap and budget check logs and returns what it cut short.

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

**Loop-until-dry.** For discovery of unknown size (bugs, issues, edge cases), keep spawning finders until K consecutive rounds return nothing new. Simple counters (`while (count < N)`) miss the tail. The exhaustive review reaches the tail with gap rounds instead, ending when the critic finds nothing uncovered.

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

"Find any bugs", "review this diff" or "review this change" → a focused check. Read the code or diff yourself first, as part of scouting, and note the bugs you already see. If the change is small enough to verify completely yourself, about ten changed lines or fewer, every change traced through its callers and nothing ambiguous, report it yourself (see [Ultracode](#ultracode)). Otherwise run a few finders (one per changed file or lens, typically two to four), each with a concrete checklist from your reading (the functions, edge cases and callers' contracts to check) and told the bugs you noted, so it hunts for others. Finders report every candidate they can back with a concrete failing scenario, noting whether real callers reach it instead of dropping one they don't, and leave the filtering to the skeptics: a finder that reports only its strongest bug hides the rest. Dedup by place, then one skeptic per distinct candidate, yours included (two at most). "Thoroughly audit this" or "be comprehensive" → a wide finder pool (one per area plus cross-cutting lenses), a three-lens adversarial panel per finding and gap rounds a completeness critic proposes: the [exhaustive review](#composing-patterns-exhaustive-review). You write the final report from what it returns. Keep panels, critics and loop-until-dry for those thorough requests: under ultracode, "the most exhaustive, correct answer" means covering what was asked well, not putting a three-vote panel and a critic on a small diff. When unsure, lean toward thoroughness for research, review and audit requests and toward brevity for quick checks. The default workflow size is medium, under 10 agents: a guideline, not a hard limit, that a request calling for a different scale, such as a thorough audit, overrides.

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
      checklists: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 3 },
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
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
  required: ["refuted", "reason"],
  additionalProperties: false,
};

// Reports of one bug cite lines a little apart: the same file within 3 lines is the same bug.
const sameBug = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= 3;
const dedupe = (bugs) => {
  const kept = [];
  for (const bug of bugs) if (!kept.some((other) => sameBug(other, bug))) kept.push(bug);
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

Writers in the shared checkout follow file claims. `writes` lists the exact workspace-relative files an agent may change (no directories, globs, `./` or leading `/`), at most 64 per writer. Writers with disjoint claims run in parallel, overlapping claims queue, and a writer without `writes` runs alone. A writer that touches a file it didn't claim is contained, and new writers pause until you review it, so every list must be complete, tests, fixtures and docs included. A malformed claim is an invalid call that fails the run, so check each list before you start. Use `isolation: "worktree"` only for units whose files can't be known upfront or that overlap heavily; its proposal comes back in the notification for you to review and integrate with `subagent_workspace`.

A multi-file feature runs as two workflows with you in between:

1. **Scout and build the core yourself.** Read the code, settle the design (names, types, validation rules, error messages, where each piece lives), and implement the core everything else depends on, such as the schema, validation and service changes, so the writers build on code rather than on a description.
2. **Implement workflow.** Split the rest into units with disjoint files: each surface, the tests for each area, the docs. Give every writer the same brief (the final design decisions and the core you wrote) plus the files it owns, and run one `worker` per unit in parallel, each claiming its files. A feature across two dozen files is typically four to six units.
3. **Check it yourself.** Run the package's typecheck, lint and tests, and fix what is small.
4. **Review workflow.** Three to five reviewers over the change, not fewer for a feature of this size, each with a lens (correctness and contracts, tests and coverage, surfaces and docs, integration, error paths), dedup their findings by place, then two skeptics per finding. A worker can fill a test gap in files no one else claims.
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
  description: "Lens reviewers over the uncommitted change, dedup, then two skeptics per finding",
  args: {
    type: "object",
    properties: {
      goal: { type: "string" },
      lenses: { type: "array", items: { type: "string" }, minItems: 1, maxItems: 5 },
    },
    required: ["goal", "lenses"],
    additionalProperties: false,
  },
  phases: [
    { title: "Review", detail: "one reviewer per lens" },
    { title: "Verify", detail: "two skeptics per finding" },
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
  properties: { refuted: { type: "boolean" }, reason: { type: "string" } },
  required: ["refuted", "reason"],
  additionalProperties: false,
};

// Reports of one problem cite lines a little apart: the same file within 3 lines is one finding.
const sameFinding = (a, b) => a.file === b.file && Math.abs(a.line - b.line) <= 3;

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
for (const finding of found.filter(Boolean).flatMap((result) => result.findings))
  if (!findings.some((other) => sameFinding(other, finding))) findings.push(finding);
const judged = await parallel(
  findings.map(
    (finding) => () =>
      parallel(
        [1, 2].map(
          (n) => () =>
            agent(
              `Try to refute this review finding against the code. Default to refuted: true if uncertain.\n${JSON.stringify(finding)}`,
              {
                label: `verify ${finding.file}:${finding.line} #${n}`,
                phase: "Verify",
                profile: "reviewer",
                schema: VERDICT,
              },
            ),
        ),
      ).then((votes) => {
        const cast = votes.filter(Boolean);
        return { finding, real: cast.length > 0 && cast.every((vote) => !vote.refuted) };
      }),
  ),
);
return {
  confirmed: judged.filter((entry) => entry?.real).map((entry) => entry.finding),
  rejected: judged.filter((entry) => entry && !entry.real).map((entry) => entry.finding),
};
```

In the session's worktree writer mode every writer gets a worktree and nothing reaches the checkout until you integrate it: integrate the proposals before your checks and the review workflow. To repair as you go, run a worker again with the review's confirmed findings and the same `writes`.

## Budgets

The user sets a budget with `/ultracode +500k` or by stating a limit; pass it as the start's `budget` (output tokens). It is a hard ceiling: once it is spent, an `agent()` call whose agent hasn't started throws `WorkflowBudgetError`. Plan the run inside it before you write the script:

- **Scale depth to it, keeping room to finish.** Reserve what verification and the end need, and spend the rest on discovery: more gap rounds while the budget pays for them, as the [exhaustive review](#composing-patterns-exhaustive-review) does. For multi-phase work, split the budget across the phases up front.
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
- **Prompt size.** An `agent()` prompt holds at most 131,072 characters, and a longer one can't start, so the call resolves `null`. Give a critic or a synthesis compact summaries (file, line and a one-line desc per finding), not every finding's full evidence and votes.
- **Expect `null`.** `agent()` resolves `null` when its agent fails, is stopped or is skipped, and an item that throws inside `parallel()` or `pipeline()` becomes `null`, which `pipeline()` passes to the next stage. Filter with `.filter(Boolean)` or read `previous?.field ?? []`.
- **Invalid calls fail the run**, even inside `parallel()` and `pipeline()`: an unknown option or profile, a bad schema or claim, or more than 1,000 calls. A `catch` around `agent()` should rethrow errors whose `name` isn't `WorkflowBudgetError`.
- **Determinism.** `Date.now()`, `new Date()` and `Math.random()` throw, and there are no timers, `fetch`, files or modules, so runs can resume. Pass dates through `args`. Await every `agent()` call: agents still running when the script returns are stopped.
- **Declare the plan.** List the agents you already know in `meta.phases[].agents`, with exactly the labels your calls use, and make those calls in that phase, so the user sees the plan and can skip one. Leave `agents` out when a phase's count depends on earlier results or calls repeat across rounds.
- **Return what you act on**: confirmed findings with evidence, what was rejected or dropped, and what wasn't covered. The results journal keeps every agent's full output.
- **Runtime failures.** Follow the supplied recovery guidance, not script-edit advice: preserve outstanding worktree proposals and stop other active work before asking the user to fully restart Pi and continue this session, then retry unchanged with the same `args` and `resumeFromRunId`. Changed worktree writers cannot be reused across a restart. Check the runtime installation if failure persists.
- **Resume and extend.** For script errors or intentional changes, edit the script's file (an inline script's saved copy is named in the start result) and start it again with the same `args` and `resumeFromRunId`. Calls with the same prompt, profile, schema, isolation and writes reuse their results. Once a writer call without `isolation: "worktree"` runs live, every later call runs live too, so add new stages after the writers you keep. Don't restart a run the user stopped unless they ask.
- **Read the results journal** that the notification and status name before you diagnose an empty or surprising result.

## Run it

- **Write the script on short lines**, with schemas and prompts as named constants: a syntax error names its line, which is easy to fix on a short one.
- **Pass one-off work inline** as `script`. Write a saved workflow, in `.pi/workflows/` of a trusted project or the agent directory's `workflows/`, only when the user wants one to reuse.
- **End your turn after starting it.** `start` returns at once; finish any unrelated work, then end your turn. The run's one notification starts your next turn with its result, and you report from it then. Don't call `status` to wait; use it when the user asks how it is going or a run seems stuck. Answer agents' questions with `subagent_reply`.
- **Don't stop a run to answer sooner.** Its unfinished agents' work is lost, and a resume reruns them at full cost. Stop a run only when the user asks or it is clearly broken, such as a wrong script or a runaway loop.
