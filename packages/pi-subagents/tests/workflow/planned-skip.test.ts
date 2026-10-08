// Explicit test entry-point Layer provision owns each scoped service runtime.
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { emptyUsage } from "../../src/run/model.ts";
import { workflowRunSummary } from "../../src/tools/workflow-format.ts";
import { WORKFLOW_SKIPPED_BEFORE_START, type WorkflowRunView } from "../../src/workflow/model.ts";
import {
  controlForTask,
  eventually,
  finished,
  inline,
  journalLines,
  reportTask,
  resultValue,
  runningTask,
  runWhere,
  startScript,
  stateOfTask,
  workflowTest,
} from "./fixtures/workflow-harness.ts";

const REVIEW_META = `[{ title: "Review", agents: ["correctness", "security"] }, { title: "Verify", agents: ["verifier"] }]`;

const plannedSource = (body: string) => inline(body, "planned", REVIEW_META);

const plannedId = (run: WorkflowRunView, label: string): string => {
  const entry = run.planned.find((candidate) => candidate.label === label);
  if (!entry) throw new Error(`No planned agent ${label}.`);
  return entry.runId;
};

const agentNamed = (run: WorkflowRunView, label: string) =>
  run.agents.find((agent) => agent.label === label);

describe("skipping planned agents", () => {
  it.live("resolves the call that claims a skipped agent to null without starting it", () => {
    // One slot, so a call that waited for one couldn't settle while the verifier holds it.
    return workflowTest({ concurrency: 1 }, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        plannedSource(`
              phase("Review");
              const first = await agent("check correctness", { label: "correctness" });
              const [verified, security] = await Promise.all([
                agent("verify it", { label: "verifier", phase: "Verify" }),
                agent("check security", { label: "security" }),
              ]);
              return { first, verified, security };`),
      );
      const security = plannedId(started, "security");
      yield* workflows.skip(security);
      const marked = yield* runWhere(workflows, started.id, (run) =>
        run.planned.some((entry) => entry.runId === security && entry.skippedAt !== undefined),
      );
      expect(marked.agents).toEqual([]);
      yield* reportTask(fixture, "check correctness", "Correct.");
      // It settles while the verifier still holds the run's only slot, keeping its row id.
      const settled = yield* runWhere(
        workflows,
        started.id,
        (run) => agentNamed(run, "security")?.state === "skipped",
      );
      expect(agentNamed(settled, "security")).toMatchObject({
        runId: security,
        phase: "Review",
        reason: WORKFLOW_SKIPPED_BEFORE_START,
      });
      expect(agentNamed(settled, "security")?.startedAt).toBeUndefined();
      expect(agentNamed(settled, "verifier")?.state).not.toBe("completed");
      yield* reportTask(fixture, "verify it", "Verified.");
      const done = yield* finished(workflows, started.id);
      expect(resultValue(done)).toEqual({
        first: "Correct.",
        verified: "Verified.",
        security: null,
      });
      // No subagent ever received its task.
      expect(stateOfTask(fixture, "check security")).toBeUndefined();
      expect(
        journalLines(fixture.runFiles, done.journalPath).find((line) => line.label === "security"),
      ).toMatchObject({
        state: "skipped",
        reason: WORKFLOW_SKIPPED_BEFORE_START,
        runId: security,
        result: null,
      });
      expect(workflowRunSummary(done).skipped).toBe(1);
      const notification = yield* eventually(() => fixture.delivered[0], "the notification");
      expect(notification.agents.skipped).toBe(1);
    });
  });

  it.live("keeps a skipped agent no call claimed as skipped history, not as never run", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        plannedSource(
          'phase("Review"); return await agent("check correctness", { label: "correctness" });',
        ),
      );
      const verifier = plannedId(started, "verifier");
      yield* workflows.skip(verifier);
      yield* reportTask(fixture, "check correctness", "Correct.");
      const done = yield* finished(workflows, started.id);
      expect(done.state).toBe("completed");
      expect(done.planned.find((entry) => entry.runId === verifier)?.skippedAt).toBeDefined();
      expect(done.planned.find((entry) => entry.label === "security")?.skippedAt).toBeUndefined();
      expect(workflowRunSummary(done).skipped).toBe(1);
      const notification = yield* eventually(() => fixture.delivered[0], "the notification");
      expect(notification.agents.skipped).toBe(1);
      // A finished run's planned agents can no longer be skipped, nor can unknown ones.
      const late = yield* Effect.flip(workflows.skip(plannedId(done, "security")));
      expect(late._tag).toBe("WorkflowNotFoundError");
      expect((yield* Effect.flip(workflows.skip("agent-unknown")))._tag).toBe(
        "WorkflowNotFoundError",
      );
    }),
  );

  it.live("runs a call skipped before it started again when its run is resumed", () => {
    const body = `
      phase("Review");
      const first = await agent("check correctness", { label: "correctness" });
      const security = await agent("check security", { label: "security" });
      return [first, security];`;
    return workflowTest({}, function* ({ fixture, workflows }) {
      const original = yield* startScript(workflows, plannedSource(body));
      yield* workflows.skip(plannedId(original, "security"));
      yield* reportTask(fixture, "check correctness", "Correct.");
      expect(resultValue(yield* finished(workflows, original.id))).toEqual(["Correct.", null]);
      const resumed = yield* startScript(workflows, plannedSource(body), {
        resumeFromRunId: original.id,
      });
      // It had no result to reuse, so it runs live this time.
      yield* reportTask(fixture, "check security", "Secure.");
      const done = yield* finished(workflows, resumed.id);
      expect(resultValue(done)).toEqual(["Correct.", "Secure."]);
      expect(done.reused).toBe(1);
      expect(agentNamed(done, "security")?.state).toBe("completed");
    });
  });

  it.live("resolves a resumed call skipped before it started to null instead of reusing", () => {
    const first = 'const first = await agent("check correctness", { label: "correctness" });';
    const security = 'const security = await agent("check security", { label: "security" });';
    return workflowTest({}, function* ({ fixture, workflows }) {
      const original = yield* startScript(
        workflows,
        plannedSource(`phase("Review"); ${first} ${security} return [first, security];`),
      );
      yield* reportTask(fixture, "check correctness", "Correct.");
      yield* reportTask(fixture, "check security", "Secure.");
      yield* finished(workflows, original.id);
      // A live call holds the script until the skip is in.
      const resumed = yield* startScript(
        workflows,
        plannedSource(`phase("Review"); ${first}
              const gate = await agent("verify it", { label: "verifier", phase: "Verify" });
              ${security} return [first, gate, security];`),
        { resumeFromRunId: original.id },
      );
      yield* workflows.skip(plannedId(resumed, "security"));
      yield* reportTask(fixture, "verify it", "Verified.");
      const done = yield* finished(workflows, resumed.id);
      expect(resultValue(done)).toEqual(["Correct.", "Verified.", null]);
      expect(done.reused).toBe(1);
      expect(agentNamed(done, "security")?.state).toBe("skipped");
    });
  });

  it.live("resolves a skipped call to null once the budget is spent, which it doesn't need", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        plannedSource(`
              phase("Review");
              const first = await agent("check correctness", { label: "correctness" });
              const security = await agent("check security", { label: "security" });
              return [first, security];`),
        { budget: 100 },
      );
      yield* workflows.skip(plannedId(started, "security"));
      yield* runningTask(fixture, "check correctness");
      const control = yield* controlForTask(fixture, "check correctness");
      control.offer({ type: "usage", usage: { ...emptyUsage(), output: 150 } });
      yield* reportTask(fixture, "check correctness", "Correct.");
      const done = yield* finished(workflows, started.id);
      expect(done.state).toBe("completed");
      expect(resultValue(done)).toEqual(["Correct.", null]);
      expect(done.budget).toMatchObject({ spent: 150, refused: 0 });
      expect(agentNamed(done, "security")).toMatchObject({
        state: "skipped",
        reason: WORKFLOW_SKIPPED_BEFORE_START,
      });
    }),
  );

  it.live(
    "lets a later call with the same label reuse its result once a skipped call claimed the entry",
    () => {
      const first = 'const first = await agent("check correctness", { label: "correctness" });';
      const checks = `const checks = await Promise.all([
      agent("check auth", { label: "security" }),
      agent("check input", { label: "security" }),
    ]);`;
      return workflowTest({}, function* ({ fixture, workflows }) {
        const original = yield* startScript(
          workflows,
          plannedSource(`phase("Review"); ${first} ${checks} return [first, ...checks];`),
        );
        yield* reportTask(fixture, "check correctness", "Correct.");
        yield* reportTask(fixture, "check auth", "Auth fine.");
        yield* reportTask(fixture, "check input", "Input fine.");
        yield* finished(workflows, original.id);
        // A live call holds the script until the skip is in.
        const resumed = yield* startScript(
          workflows,
          plannedSource(`phase("Review"); ${first}
              const gate = await agent("verify it", { label: "verifier", phase: "Verify" });
              ${checks} return [first, gate, ...checks];`),
          { resumeFromRunId: original.id },
        );
        yield* workflows.skip(plannedId(resumed, "security"));
        yield* reportTask(fixture, "verify it", "Verified.");
        const done = yield* finished(workflows, resumed.id);
        // The first call claimed the one skipped entry; the second still reuses its result.
        expect(resultValue(done)).toEqual(["Correct.", "Verified.", null, "Input fine."]);
        expect(done.reused).toBe(2);
      });
    },
  );
});

describe("claiming planned agents outside any phase", () => {
  it.live("gives a labelled call its entry's phase and leaves an unlabelled one unclaimed", () =>
    workflowTest({}, function* ({ fixture, workflows }) {
      const started = yield* startScript(
        workflows,
        plannedSource(
          'return await Promise.all([agent("verify it", { label: "verifier" }), agent("loose work")]);',
        ),
      );
      const verifier = plannedId(started, "verifier");
      const queued = yield* runWhere(workflows, started.id, (run) => run.agents.length === 2);
      expect(agentNamed(queued, "verifier")).toMatchObject({ runId: verifier, phase: "Verify" });
      const loose = queued.agents.find((agent) => agent.label !== "verifier");
      expect(loose?.phase).toBeUndefined();
      expect(queued.planned.map((entry) => entry.label)).toEqual(["correctness", "security"]);
      expect(queued.planned.some((entry) => entry.runId === loose?.runId)).toBe(false);
      // Its subagent runs in that phase too, so Activity nests it there.
      const subagentId = yield* reportTask(fixture, "verify it", "Verified.");
      expect(subagentId).toBe(verifier);
      expect(
        fixture.projections.at(-1)?.runs.find((run) => run.id === verifier)?.workflow?.phase,
      ).toBe("Verify");
      yield* reportTask(fixture, "loose work", "Done.");
      expect(resultValue(yield* finished(workflows, started.id))).toEqual(["Verified.", "Done."]);
    }),
  );
});
