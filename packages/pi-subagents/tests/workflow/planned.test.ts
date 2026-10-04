// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { workflowRunSummary, workflowStatusText } from "../../src/tools/workflow-format.ts";
import type { WorkflowPlannedAgent, WorkflowRunView } from "../../src/workflow/model.ts";
import {
  claimSkippedWorkflowPlanned,
  claimWorkflowPlanned,
  reuseWorkflowResult,
  skipWorkflowPlanned,
  workflowAgentFromDraft,
  workflowServiceLog,
  withWorkflowEvent,
} from "../../src/workflow/state.ts";
import { workflowRunView } from "../fixtures/run-view.ts";
import {
  eventually,
  finished,
  reportTask,
  resultValue,
  runWhere,
  testHost,
  withWorkflows,
  workflowFixture,
} from "./fixtures/workflow-harness.ts";

const planned = (
  runId: string,
  phase: string,
  label: string,
  profile?: string,
): WorkflowPlannedAgent => ({ runId, phase, label, ...(profile !== undefined && { profile }) });

const run = (entries: ReadonlyArray<WorkflowPlannedAgent>): WorkflowRunView =>
  workflowRunView({ phases: [{ title: "Review" }, { title: "Verify" }], planned: entries });

const reviewPlan = [
  planned("agent-p-1", "Review", "correctness"),
  planned("agent-p-2", "Review", "security", "reviewer"),
  planned("agent-p-3", "Verify", "verifier"),
];

describe("claiming planned agents", () => {
  it("claims the entry with the call's label in its phase", () => {
    const [claimed, rest] = claimWorkflowPlanned(run(reviewPlan), {
      phase: "Review",
      label: "security",
    });
    expect(claimed?.runId).toBe("agent-p-2");
    expect(rest.planned.map((entry) => entry.runId)).toEqual(["agent-p-1", "agent-p-3"]);
  });

  it("gives an unlabelled call the phase's next entry and its label", () => {
    let current = run(reviewPlan);
    const claims: Array<string | undefined> = [];
    for (const callId of [1, 2, 3]) {
      const [claimed, rest] = claimWorkflowPlanned(current, { phase: "Review" });
      claims.push(claimed?.runId);
      current = rest;
      if (callId === 2)
        expect(
          workflowAgentFromDraft({ callId, queuedAt: 1, phase: "Review" }, "x", claimed),
        ).toMatchObject({ label: "security", phase: "Review" });
    }
    expect(claims).toEqual(["agent-p-1", "agent-p-2", undefined]);
    expect(current.planned.map((entry) => entry.runId)).toEqual(["agent-p-3"]);
  });

  it("claims nothing for a label no entry has, or a call outside any phase", () => {
    const original = run(reviewPlan);
    expect(claimWorkflowPlanned(original, { phase: "Review", label: "performance" })).toEqual([
      undefined,
      original,
    ]);
    expect(claimWorkflowPlanned(original, {})).toEqual([undefined, original]);
    expect(claimWorkflowPlanned(original, { phase: "Elsewhere" })).toEqual([undefined, original]);
  });

  it("lets a labelled call outside any phase claim its entry in any phase, and take that phase", () => {
    const [claimed, rest] = claimWorkflowPlanned(run(reviewPlan), { label: "verifier" });
    expect(claimed?.runId).toBe("agent-p-3");
    expect(rest.planned.map((entry) => entry.runId)).toEqual(["agent-p-1", "agent-p-2"]);
    expect(
      workflowAgentFromDraft({ callId: 1, queuedAt: 1, label: "verifier" }, "agent-p-3", claimed),
    ).toMatchObject({ phase: "Verify", state: "queued" });
    // A reused result counts in the claimed entry's phase too.
    const entry = { key: "k", result: "done", outputTokens: 3, chars: 6 };
    const [, reused] = reuseWorkflowResult(run(reviewPlan), entry, { label: "security" });
    expect(reused.reusedPhases).toEqual([{ title: "Review", count: 1 }]);
    // An unlabelled call outside any phase still claims nothing.
    expect(claimWorkflowPlanned(run(reviewPlan), {})[0]).toBeUndefined();
  });

  it("claims outside a phase only the entries the call's own workflow declares", () => {
    const nested = run([
      { ...planned("agent-p-2", "▸ child · Fix", "fixer"), workflow: "child" },
      planned("agent-p-1", "Review", "fixer"),
    ]);
    // A nested workflow's call takes its own entry, and the run's own call takes the script's.
    const [child] = claimWorkflowPlanned(nested, { label: "fixer", workflow: "child" });
    expect(child?.runId).toBe("agent-p-2");
    const [root] = claimWorkflowPlanned(nested, { label: "fixer" });
    expect(root?.runId).toBe("agent-p-1");
    expect(claimWorkflowPlanned(nested, { label: "fixer", workflow: "other" })[0]).toBeUndefined();
  });

  it("settles a call that claims a skipped entry as skipped, and skips only unclaimed entries of live runs", () => {
    const [skippedOnce, skipped] = skipWorkflowPlanned(run(reviewPlan), "agent-p-2", 5);
    expect(skippedOnce).toBe(true);
    expect(skipped.planned.map((entry) => entry.skippedAt)).toEqual([undefined, 5, undefined]);
    // Skipping it again changes nothing; an unknown entry or a finished run is refused.
    expect(skipWorkflowPlanned(skipped, "agent-p-2", 6)).toEqual([true, skipped]);
    expect(skipWorkflowPlanned(skipped, "agent-other", 6)[0]).toBe(false);
    expect(skipWorkflowPlanned({ ...run(reviewPlan), state: "completed" }, "agent-p-2", 6)[0]).toBe(
      false,
    );
    // Only a call that would claim a skipped entry claims it ahead of queuing.
    const correctness = { phase: "Review", label: "correctness" };
    expect(claimSkippedWorkflowPlanned(skipped, correctness)).toEqual([undefined, skipped]);
    // Claiming works as before; the claiming call is already skipped, with a reason.
    const [claimed, rest] = claimSkippedWorkflowPlanned(skipped, {
      phase: "Review",
      label: "security",
    });
    expect(rest.planned).toHaveLength(2);
    expect(
      workflowAgentFromDraft(
        { callId: 2, queuedAt: 7, label: "security", phase: "Review" },
        claimed!.runId,
        claimed,
      ),
    ).toMatchObject({
      runId: "agent-p-2",
      state: "skipped",
      endedAt: 7,
      reason: expect.any(String),
    });
  });

  it("keeps the call's own label and profile over the claimed entry's", () => {
    const [claimed] = claimWorkflowPlanned(run(reviewPlan), { phase: "Review", label: "security" });
    const agent = workflowAgentFromDraft(
      { callId: 4, queuedAt: 1, label: "security", phase: "Review", profile: "generalist" },
      claimed?.runId ?? "",
      claimed,
    );
    expect(agent).toMatchObject({ runId: "agent-p-2", label: "security", profile: "generalist" });
    expect(workflowAgentFromDraft({ callId: 5, queuedAt: 1 }, "agent-own")).toMatchObject({
      runId: "agent-own",
      label: "agent-5",
      state: "queued",
    });
  });

  it("shows only the profile a claimed call runs with, never the planned one", () => {
    const [byLabel] = claimWorkflowPlanned(run(reviewPlan), { phase: "Review", label: "security" });
    // The call runs with its own (default) profile, so its row doesn't show the planned one.
    expect(
      workflowAgentFromDraft(
        { callId: 1, queuedAt: 1, label: "security", phase: "Review" },
        byLabel!.runId,
        byLabel,
      ).profile,
    ).toBeUndefined();
    const [byOrder] = claimWorkflowPlanned(
      run([planned("agent-p-2", "Review", "security", "reviewer")]),
      { phase: "Review" },
    );
    expect(
      workflowAgentFromDraft({ callId: 2, queuedAt: 1, phase: "Review" }, byOrder!.runId, byOrder)
        .profile,
    ).toBeUndefined();
    expect(
      workflowAgentFromDraft(
        { callId: 3, queuedAt: 1, phase: "Review", profile: "scout" },
        byOrder!.runId,
        byOrder,
      ).profile,
    ).toBe("scout");
  });

  it("claims the planned entry of a reused result, which then counts as reused", () => {
    const entry = { key: "k", result: "done", outputTokens: 3, chars: 6 };
    const [claimed, rest] = reuseWorkflowResult(run(reviewPlan), entry, { phase: "Verify" });
    expect(claimed?.runId).toBe("agent-p-3");
    expect(rest.planned).toHaveLength(2);
    expect(rest.reused).toBe(1);
    expect(rest.reusedPhases).toEqual([{ title: "Verify", count: 1 }]);
  });
});

describe("planned agents in status", () => {
  it("counts a planned agent skipped before any call claimed it as skipped, not planned", () => {
    const [, skipped] = skipWorkflowPlanned(run(reviewPlan), "agent-p-3", 5);
    const summary = workflowRunSummary(skipped);
    expect(summary).toMatchObject({ skipped: 1, agents: 1 });
    const verify = workflowStatusText(skipped, 6)
      .split("\n")
      .find((line) => line.startsWith("- Verify"));
    expect(verify).toMatch(/skipped/u);
    expect(verify).not.toMatch(/planned/u);
  });

  it("counts each phase's agents that haven't started", () => {
    const phaseLine = (text: string, title: string) =>
      text.split("\n").find((line) => line.startsWith(`- ${title}`)) ?? "";
    const live = workflowStatusText(run(reviewPlan), 1);
    expect(phaseLine(live, "Review")).toMatch(/\b2\b/u);
    expect(phaseLine(live, "Verify")).toMatch(/\b1\b/u);
    const ended = workflowStatusText({ ...run(reviewPlan), state: "completed", endedAt: 2 }, 2);
    expect(phaseLine(ended, "Review")).toMatch(/\b2\b/u);
    expect(phaseLine(workflowStatusText(run([]), 1), "Review")).not.toMatch(/\d/u);
  });
});

describe("narrator line", () => {
  it("follows the newest non-blank log line on one bounded line", () => {
    const logged = (current: WorkflowRunView, message: string, level?: "warning") =>
      withWorkflowEvent(current, { type: "log", message, ...(level && { level }) }, 1);
    let current = logged(run([]), "scanning\n  src/auth");
    expect(current.lastLog).toBe("scanning src/auth");
    current = logged(current, "   ");
    expect(current.lastLog).toBe("scanning src/auth");
    current = logged(current, "agent failed", "warning");
    expect(current.lastLog).toBe("agent failed");
    current = logged(current, "x".repeat(500));
    expect(current.lastLog?.length).toBeLessThanOrEqual(200);
  });

  it("never narrates the service's own agent-facing lines, which the log still keeps", () => {
    const scripted = withWorkflowEvent(run([]), { type: "log", message: "reviewing auth" }, 1);
    const warned = withWorkflowEvent(
      scripted,
      workflowServiceLog("warning", 'agent "fix" is queued behind writer (agent-r1-4): busy'),
      2,
    );
    expect(warned.lastLog).toBe("reviewing auth");
    expect(warned.logs.at(-1)?.message).toContain("agent-r1-4");
    expect(warned.warningCount).toBe(1);
  });
});

const script = (meta: string, body: string) =>
  `export const meta = { name: "planned", description: "Planned agents", phases: ${meta} };\n${body}`;

const inline = (meta: string, body: string) => ({
  kind: "inline" as const,
  script: script(meta, body),
});

const REVIEW_META = `[{ title: "Review", agents: ["correctness", { label: "security", profile: "reviewer" }] }, { title: "Verify", agents: ["verifier"] }]`;

describe("planned agents in a run", () => {
  it.live("shows declared agents before they start and keeps one id through the run", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              REVIEW_META,
              'phase("Review"); return await agent("check security", { label: "security" });',
            ),
            args: null,
          },
          testHost(),
        );
        expect(started.planned.map(({ phase, label }) => [phase, label])).toEqual([
          ["Review", "correctness"],
          ["Review", "security"],
          ["Verify", "verifier"],
        ]);
        expect(new Set(started.planned.map((entry) => entry.runId)).size).toBe(3);
        const security = started.planned[1]!;

        const queued = yield* runWhere(workflows, started.id, (view) => view.agents.length === 1);
        expect(queued.agents[0]).toMatchObject({ runId: security.runId, label: "security" });
        expect(queued.planned.map((entry) => entry.label)).toEqual(["correctness", "verifier"]);

        // The subagent itself starts under the planned id.
        const subagentId = yield* reportTask(fixture, "check security", "No issues.");
        expect(subagentId).toBe(security.runId);

        const done = yield* finished(workflows, started.id);
        expect(done.state).toBe("completed");
        // Entries no call claimed stay as history of what never ran.
        expect(done.planned.map((entry) => entry.label)).toEqual(["correctness", "verifier"]);
      }),
    );
  });

  it.live("lets a resumed run's reused calls claim their planned entries", () => {
    const fixture = workflowFixture();
    const find = 'phase("Review"); const found = await agent("review it");';
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const original = yield* workflows.start(
          { source: inline(REVIEW_META, `${find}\nthrow new Error("not yet");`), args: null },
          testHost(),
        );
        yield* reportTask(fixture, "review it", "Reviewed.");
        expect((yield* finished(workflows, original.id)).planned).toHaveLength(2);
        const resumed = yield* workflows.start(
          {
            source: inline(REVIEW_META, `${find}\nreturn found;`),
            args: null,
            resumeFromRunId: original.id,
          },
          testHost(),
        );
        const done = yield* finished(workflows, resumed.id);
        expect(done.reused).toBe(1);
        expect(done.agents).toEqual([]);
        expect(done.planned.map((entry) => entry.label)).toEqual(["security", "verifier"]);
      }),
    );
  });

  it.live("claims the planned agents of a meta phase titled with surrounding spaces", () => {
    const fixture = workflowFixture();
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              `[{ title: " Review ", agents: ["first", "second"] }]`,
              'phase(" Review "); return await Promise.all([agent("check one"), agent("check two")]);',
            ),
            args: null,
          },
          testHost(),
        );
        const queued = yield* runWhere(workflows, started.id, (view) => view.agents.length === 2);
        expect(queued.agents.map((agent) => agent.label).sort()).toEqual(["first", "second"]);
        expect(queued.planned).toEqual([]);
        expect(queued.phases.map((phase) => phase.title)).toEqual(["Review"]);
        yield* reportTask(fixture, "check one", "1");
        yield* reportTask(fixture, "check two", "2");
        const done = yield* finished(workflows, started.id);
        expect(done.planned).toEqual([]);
      }),
    );
  });

  it.live("lets a nested workflow's call outside a phase claim only its own planned agents", () => {
    const fixture = workflowFixture({
      scripts: {
        child: script(
          `[{ title: "Fix", agents: ["fixer"] }]`,
          'return await agent("fix it", { label: "fixer" });',
        ),
      },
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          {
            source: inline(
              `[{ title: "Review", agents: ["fixer"] }]`,
              `const fixed = await workflow("child");
              phase("Review");
              return [fixed, await agent("review it", { label: "fixer" })];`,
            ),
            args: null,
          },
          testHost(),
        );
        const parent = started.planned[0]!;
        const loaded = yield* runWhere(workflows, started.id, (view) => view.agents.length === 1);
        const child = loaded.agents[0]!;
        // The child's call takes the child's entry, in the child's phase, and leaves the parent's.
        expect(child.runId).not.toBe(parent.runId);
        expect(child.phase).toBe(loaded.phases.at(-1)?.title);
        expect(loaded.planned).toEqual([parent]);
        yield* reportTask(fixture, "fix it", "Fixed.");
        const reviewed = yield* runWhere(workflows, started.id, (view) => view.agents.length === 2);
        expect(reviewed.agents[1]).toMatchObject({ runId: parent.runId, phase: "Review" });
        yield* reportTask(fixture, "review it", "Reviewed.");
        const done = yield* finished(workflows, started.id);
        expect(resultValue(done)).toEqual(["Fixed.", "Reviewed."]);
        expect(done.planned).toEqual([]);
      }),
    );
  });

  it.live("adds a nested workflow's planned agents under its phases", () => {
    const fixture = workflowFixture({
      scripts: {
        child: script(
          `[{ title: "Fix", agents: ["fixer"] }]`,
          'phase("Fix"); return await agent("fix it");',
        ),
      },
    });
    return withWorkflows(fixture, (workflows) =>
      Effect.gen(function* () {
        const started = yield* workflows.start(
          { source: inline(`[{ title: "Main" }]`, 'return await workflow("child");'), args: null },
          testHost(),
        );
        const loaded = yield* runWhere(workflows, started.id, (view) => view.agents.length === 1);
        const agent = loaded.agents[0]!;
        expect(agent.label).toBe("fixer");
        expect(agent.phase).toBe(loaded.phases.at(-1)?.title);
        expect(loaded.planned).toEqual([]);
        yield* reportTask(fixture, "fix it", "Fixed.");
        yield* eventually(() => fixture.delivered[0], "the workflow notification");
      }),
    );
  });
});
