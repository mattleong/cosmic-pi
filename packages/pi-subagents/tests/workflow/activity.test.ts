import { describe, expect, it } from "@effect/vitest";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { formatTokens } from "pi-cosmic-core";
import { ActivitySnapshotSchema, type ActivityItem } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { vi } from "vitest";
import {
  makeWorkflowActivitySource,
  registerSubagentActivity,
} from "../../src/boundary/host-activity.ts";
import {
  subagentActivityDetail,
  subagentActivityItems,
  type WorkflowActivitySnapshot,
} from "../../src/ui/run-activity.ts";
import { makeSubagentProjectionBridge } from "../../src/boundary/host-ui.ts";
import { workflowActivityItems } from "../../src/ui/workflow-activity.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import {
  type WorkflowAgentView,
  type WorkflowPlannedAgent,
  type WorkflowRunView,
} from "../../src/workflow/model.ts";
import { makeWorkflowRuns } from "../../src/workflow/runs.ts";
import { view, workflowAgentView, workflowRunView } from "../fixtures/run-view.ts";
import { effectTest, step } from "../support/effect-test.ts";

const agent = (patch: Partial<WorkflowAgentView> = {}): WorkflowAgentView =>
  workflowAgentView({ phase: "Find", ...patch });

const workflow = (patch: Partial<WorkflowRunView> = {}): WorkflowRunView =>
  workflowRunView({
    description: "Review the diff by dimension",
    phases: [{ title: "Find" }, { title: "Verify" }],
    currentPhase: "Find",
    args: { scope: "src" },
    ...patch,
  });

const plan = (index: number, patch: Partial<WorkflowPlannedAgent> = {}): WorkflowPlannedAgent => ({
  runId: `agent-r1-p${index}`,
  phase: "Verify",
  label: `verify:${index}`,
  ...patch,
});

const snapshot = (...runs: ReadonlyArray<WorkflowRunView>): WorkflowActivitySnapshot => ({
  runs,
});

/** Activity items for subagent `runs` beside `workflows`. */
const itemsOf = (
  runs: ReadonlyArray<SubagentRunView>,
  ...workflows: ReadonlyArray<WorkflowRunView>
) => subagentActivityItems({ revision: 1, runs }, undefined, snapshot(...workflows));

const items = (...workflows: ReadonlyArray<WorkflowRunView>) => itemsOf([], ...workflows);

/** The detail of an item that has no subagent run behind it. */
const detailOf = (id: string, ...workflows: ReadonlyArray<WorkflowRunView>) =>
  subagentActivityDetail({ revision: 1, runs: [] }, id, snapshot(...workflows));

const WORKFLOW_PARENT = { providerId: "pi-subagents", itemId: "workflow:wf-a-1" };

const owned = (id: string, phase = "Find") =>
  view({ id, task: id, workflow: { workflowId: "wf-a-1", name: "review", phase } });

const byId = (items: ReadonlyArray<ActivityItem>) =>
  new Map(items.map((item) => [item.id, item] as const));

const isSnapshot = Schema.is(ActivitySnapshotSchema);

/** The items the host was last published, as it holds them. */
const hostItems = (transport: ReturnType<typeof fakeActivityHost>): ReadonlyArray<ActivityItem> => {
  const published = transport.get()?.items;
  return isSnapshot(published) ? published : [];
};

/** A registered provider over subagent `runs` and a workflow source, recording workflow actions. */
const registeredWorkflows = (
  runs: ReadonlyArray<SubagentRunView> = [],
  subagents: Pick<Parameters<typeof registerSubagentActivity>[0], "act" | "input"> = {
    act: () => Promise.reject(new Error("Unexpected subagent action")),
  },
) => {
  const transport = fakeActivityHost();
  const bridge = makeSubagentProjectionBridge();
  const workflows = makeWorkflowActivitySource();
  bridge.publish({ revision: 1, runs });
  const actWorkflow = vi.fn(() => Promise.resolve());
  const dispose = registerSubagentActivity({
    events: transport.events,
    sessionId: "session",
    bridge,
    workflows,
    actWorkflow,
    isCurrent: () => true,
    ...subagents,
  });
  return { transport, bridge, workflows, actWorkflow, dispose };
};

describe("workflow activity", () => {
  it("nests owned runs under their phase and shows queued agents with a skip action", () => {
    const published = itemsOf(
      [owned("agent-r1-1")],
      workflow({
        agents: [
          agent({ state: "running" }),
          agent({ callId: 2, runId: "agent-r1-2", label: "verifier", phase: "Verify" }),
        ],
      }),
    );
    expect(isSnapshot(published)).toBe(true);
    const found = byId(published);
    expect(found.get("workflow:wf-a-1")).toMatchObject({
      kind: "workflow",
      status: "running",
      phases: [{ title: "Find" }, { title: "Verify" }],
      phase: "Find",
      actions: [expect.objectContaining({ id: "stop" })],
    });
    const parent = WORKFLOW_PARENT;
    expect(found.get("agent-r1-1")).toMatchObject({ kind: "agent", parent, phase: "Find" });
    // Skipping resolves the agent() call to null, so it asks first.
    expect(found.get("agent-r1-2")).toMatchObject({
      kind: "agent",
      status: "pending",
      parent,
      phase: "Verify",
      actions: [{ id: "skip", handoff: false, confirmation: expect.any(String) }],
    });
    expect(found.get("agent-r1-2")?.startedAt).toBeUndefined();
  });

  it("offers resume on a completed member only once its workflow no longer owns it", () => {
    const completed = view({ ...owned("agent-r1-1"), state: "completed", endedAt: 4 });
    const paused = view({ ...owned("agent-r1-2"), state: "paused" });
    const resumable = (...workflows: ReadonlyArray<WorkflowRunView>) =>
      itemsOf([completed, paused], ...workflows)
        .filter((item) => item.actions?.some((action) => action.id === "resume"))
        .map((item) => item.id);
    // A running or stopping workflow still receives the completed member's result.
    expect(resumable(workflow())).toEqual(["agent-r1-2"]);
    expect(resumable(workflow({ state: "stopping" }))).toEqual(["agent-r1-2"]);
    // Once the workflow ends, or leaves the snapshot, its members are the root's.
    expect(resumable(workflow({ state: "completed", endedAt: 9 }))).toEqual([
      "agent-r1-1",
      "agent-r1-2",
    ]);
    expect(resumable()).toEqual(["agent-r1-1", "agent-r1-2"]);
  });

  it("publishes a former member working again after its workflow ended as a root run", () => {
    const finished = workflow({ state: "completed", endedAt: 9 });
    const placement = (
      state: SubagentRunView["state"],
      ...workflows: ReadonlyArray<WorkflowRunView>
    ) => {
      const item = byId(itemsOf([view({ ...owned("agent-r1-1"), state })], ...workflows)).get(
        "agent-r1-1",
      );
      return { parent: item?.parent?.itemId, phase: item?.phase };
    };
    const member = { parent: "workflow:wf-a-1", phase: "Find" };
    const root = { parent: undefined, phase: undefined };
    expect(placement("running", workflow())).toEqual(member);
    // Finished members stay under their finished workflow as history, even once it leaves.
    expect(placement("completed", finished)).toEqual(member);
    expect(placement("completed")).toEqual(member);
    // A resumed former member is the root's; it no longer reopens the workflow.
    for (const state of ["running", "waiting_for_parent", "paused", "stopping"] as const) {
      expect(placement(state, finished)).toEqual(root);
      expect(placement(state)).toEqual(root);
    }
  });

  effectTest("refuses resume on a completed member until its workflow ends", function* () {
    const input = vi.fn(() => Promise.resolve("continue"));
    const act = vi.fn(() => Promise.resolve());
    const { transport, workflows, dispose } = registeredWorkflows(
      [view({ ...owned("agent-r1-1"), state: "completed", endedAt: 4 })],
      { input, act },
    );
    const member = () => byId(hostItems(transport)).get("agent-r1-1")!;
    const signal = new AbortController().signal;
    const invoke = transport.capability()!.invoke!;
    workflows.publish([workflow({ currentPhase: "Verify" })]);
    const owner = member();
    yield* step(() => expect(invoke(owner.id, "resume", owner.revision, signal)).rejects.toThrow());
    expect(input).not.toHaveBeenCalled();
    workflows.publish([workflow({ state: "completed", endedAt: 9 })]);
    const released = member();
    yield* step(() => invoke(released.id, "resume", released.revision, signal));
    expect(act.mock.calls).toEqual([["agent-r1-1", "resume", signal, "continue"]]);
    dispose();
  });

  it("shows an admitted agent once even before its workflow view catches up", () => {
    const published = itemsOf([owned("agent-r1-1")], workflow({ agents: [agent()] }));
    expect(published.filter((item) => item.id === "agent-r1-1")).toHaveLength(1);
    expect(byId(published).get("agent-r1-1")?.status).not.toBe("pending");
  });

  it("bounds queued rows per workflow", () => {
    const queued = Array.from({ length: 100 }, (_, index) =>
      agent({ callId: index + 1, runId: `agent-r1-${index + 1}` }),
    );
    const one = items(workflow({ agents: queued }));
    expect(one.filter((item) => item.status === "pending")).toHaveLength(64);
  });

  it("offers no stop on finished workflows and keeps phases valid for runtime additions", () => {
    const longPrefix = `▸ ${"n".repeat(80)} · ${"p".repeat(150)}`;
    const published = items(
      workflow({
        state: "completed",
        endedAt: 9,
        phases: [{ title: "Find" }, { title: longPrefix.slice(0, 160) }],
        currentPhase: longPrefix.slice(0, 160),
      }),
    );
    expect(isSnapshot(published)).toBe(true);
    expect(published[0]).toMatchObject({ status: "done", actions: [] });
  });

  it("hands off actions that open input and keeps stop, interrupt and skip in place", () => {
    const question = { requestId: "q", message: "Question" };
    const offered = [
      view({ id: "running" }),
      view({ id: "paused", state: "paused" }),
      view({ id: "asking", state: "waiting_for_parent", question }),
    ];
    const published = itemsOf(offered, workflow({ agents: [agent()] }));
    const actions = published.flatMap((item) => item.actions ?? []);
    const handoff = (id: string) =>
      new Set(actions.filter((action) => action.id === id).map((action) => action.handoff));
    for (const input of ["message", "rename", "resume", "reply"])
      expect(handoff(input)).toEqual(new Set([true]));
    expect(published.find((item) => item.kind === "workflow")?.actions).toEqual([
      expect.objectContaining({ id: "stop", handoff: false }),
    ]);
    for (const inPlace of ["stop", "interrupt", "skip"])
      expect(handoff(inPlace)).toEqual(new Set([false]));
  });

  it("counts every agent per phase, including ones whose rows are gone", () => {
    const published = items(
      workflow({
        currentPhase: "Verify",
        agents: [
          agent({ state: "completed" }),
          agent({ callId: 2, runId: "agent-r1-2", state: "skipped" }),
          agent({ callId: 3, runId: "agent-r1-3", phase: "Verify", state: "running" }),
        ],
      }),
    );
    expect(published[0]?.phases).toEqual([
      { title: "Find", work: { items: 2, finished: 2, stopped: 0, failed: 0, skipped: 1 } },
      { title: "Verify", work: { items: 1, finished: 0, stopped: 0, failed: 0, skipped: 0 } },
    ]);
  });

  it("counts results reused on resume as finished work in their phase", () => {
    const resumed = (state: WorkflowRunView["state"]) =>
      items(
        workflow({
          state,
          currentPhase: "Verify",
          resumedFrom: "wf-a-0",
          reused: 21,
          reusedPhases: [
            { title: "Find", count: 20 },
            { title: "Verify", count: 1 },
          ],
          agents: [
            agent({ phase: "Verify", state: state === "running" ? "running" : "completed" }),
          ],
        }),
      )[0]?.phases;
    // Every Find call was reused, so Find is finished work rather than an empty, passed phase.
    expect(resumed("running")).toEqual([
      { title: "Find", work: { items: 20, finished: 20, stopped: 0, failed: 0, skipped: 0 } },
      { title: "Verify", work: { items: 2, finished: 1, stopped: 0, failed: 0, skipped: 0 } },
    ]);
    expect(resumed("completed")).toEqual([
      { title: "Find", work: { items: 20, finished: 20, stopped: 0, failed: 0, skipped: 0 } },
      { title: "Verify", work: { items: 2, finished: 2, stopped: 0, failed: 0, skipped: 0 } },
    ]);
  });

  effectTest("confirms workflow stop and skip after unrelated publications", function* () {
    const member = owned("agent-r1-1");
    const { transport, bridge, workflows, actWorkflow, dispose } = registeredWorkflows([member]);
    const running = workflow({
      agents: [
        agent({ state: "running" }),
        agent({ callId: 2, runId: "agent-r1-2", phase: "Verify" }),
      ],
    });
    workflows.publish([running]);
    const shown = byId(hostItems(transport));
    // A member streams, a sibling starts, launches and another workflow publish meanwhile.
    bridge.publish({
      revision: 2,
      runs: [{ ...member, progress: "Reading files", lastActivityAt: 5 }, view({ id: "other" })],
    });
    bridge.bindToolPresentation().beginStart(1);
    workflows.publish([running, workflow({ id: "wf-a-2", name: "audit" })]);
    const signal = new AbortController().signal;
    const invoke = transport.capability()!.invoke!;
    const stop = shown.get("workflow:wf-a-1")!;
    yield* step(() => invoke(stop.id, "stop", stop.revision, signal));
    const skip = shown.get("agent-r1-2")!;
    yield* step(() => invoke(skip.id, "skip", skip.revision, signal));
    expect(actWorkflow.mock.calls).toEqual([
      ["stop", "wf-a-1", signal],
      ["skip", "agent-r1-2", signal],
    ]);
    dispose();
  });

  it("describes a workflow in the detail pane", () => {
    const detail = detailOf(
      "workflow:wf-a-1",
      workflow({ logs: [{ at: 3, level: "warning", message: "agent finder was skipped" }] }),
    );
    expect(detail).toContain("Review the diff by dimension");
    expect(detail).toContain("agent finder was skipped");
    expect(detail).toContain('"scope":"src"');
  });

  it("shows what a queued agent waits for, on its row and in its detail", () => {
    const queued = (waiting: WorkflowAgentView["waiting"]) => {
      const run = workflow({ agents: [agent({ waiting })] });
      const row = byId(items(run)).get("agent-r1-1");
      return { summary: row?.summary, detail: detailOf("agent-r1-1", run) };
    };
    const writer = queued({ kind: "writer", runId: "agent-r1-9", name: "migrator", paused: true });
    expect(writer.summary).toContain("migrator");
    expect(writer.detail).toContain("migrator");
    const summaries = new Set(
      [undefined, { kind: "slot" as const }].map((waiting) => queued(waiting).summary),
    );
    expect(summaries.size).toBe(2);
  });

  it("publishes declared agents as planned rows beneath their phase, skippable while pending", () => {
    const planned = [plan(1, { profile: "reviewer" }), plan(2)];
    for (const [state, status] of [
      ["running", "pending"],
      ["completed", "cancelled"],
      ["stopped", "cancelled"],
    ] as const) {
      const published = items(workflow({ state, planned }));
      expect(isSnapshot(published)).toBe(true);
      const rows = published.filter((item) => item.planned === true);
      expect(rows.map((item) => item.id)).toEqual(["agent-r1-p1", "agent-r1-p2"]);
      for (const row of rows) {
        // Never under way and never counted as phase work.
        expect(row).toMatchObject({
          kind: "agent",
          status,
          phase: "Verify",
          parent: WORKFLOW_PARENT,
        });
        expect(row.startedAt).toBeUndefined();
        // The script can still call a pending one, so it can be skipped, after confirmation.
        expect(row.actions ?? []).toEqual(
          status === "pending"
            ? [
                expect.objectContaining({
                  id: "skip",
                  handoff: false,
                  confirmation: expect.any(String),
                }),
              ]
            : [],
        );
      }
      expect(rows[0]?.profile).toBe("reviewer");
      expect(published[0]?.phases).toEqual([
        { title: "Find", work: { items: 0, finished: 0, stopped: 0, failed: 0, skipped: 0 } },
        {
          title: "Verify",
          work: { items: 0, finished: 0, stopped: 0, failed: 0, skipped: 0 },
          planned: 2,
        },
      ]);
    }
  });

  it("keeps a planned row's id when the script's call claims it", () => {
    const planned = items(workflow({ planned: [plan(1), plan(2)] }));
    const claimed = items(
      workflow({
        planned: [plan(2)],
        agents: [agent({ runId: "agent-r1-p1", label: "verify:1", phase: "Verify" })],
      }),
    );
    expect(byId(planned).get("agent-r1-p1")?.planned).toBe(true);
    // The same row moves from planned to queued work that can be skipped.
    expect(byId(claimed).get("agent-r1-p1")).toMatchObject({
      status: "pending",
      actions: [expect.objectContaining({ id: "skip" })],
    });
    expect(byId(claimed).get("agent-r1-p1")?.planned).toBeUndefined();
    expect(claimed.filter((item) => item.id === "agent-r1-p1")).toHaveLength(1);
    expect(claimed[0]?.phases?.[1]).toMatchObject({ planned: 1, work: { items: 1 } });
    // A running claimed agent is shown by its own run; the planned id never repeats.
    const running = itemsOf([owned("agent-r1-p2", "Verify")], workflow({ planned: [plan(2)] }));
    expect(running.filter((item) => item.id === "agent-r1-p2")).toHaveLength(1);
  });

  it("bounds planned rows per workflow while phases count every planned agent", () => {
    const planned = Array.from({ length: 200 }, (_, index) => plan(index));
    const one = items(workflow({ planned }));
    expect(one.filter((item) => item.planned === true)).toHaveLength(64);
    expect(one[0]?.phases?.[1]).toMatchObject({ planned: 200 });
    const queued = Array.from({ length: 64 }, (_, index) =>
      agent({ callId: index + 1, runId: `agent-r1-q${index}` }),
    );
    const many = items(
      ...Array.from({ length: 12 }, (_, index) =>
        workflow({
          id: `wf-a-${index}`,
          agents: queued.map((entry) => ({ ...entry, runId: `${entry.runId}-${index}` })),
          planned: planned.map((entry) => ({ ...entry, runId: `${entry.runId}-${index}` })),
        }),
      ),
    );
    expect(many.length).toBeLessThanOrEqual(512);
    expect(isSnapshot(many)).toBe(true);
    expect(many.filter((item) => item.kind === "workflow")).toHaveLength(12);
    // Queued work the script already asked for takes slots before planned rows do.
    const placeholders = many.filter((item) => item.status === "pending" && !item.planned);
    expect(placeholders.length).toBe(Math.min(12 * 64, 512 - 12));
  });

  it("counts planned agents in phases past the ones Activity shows on the workflow", () => {
    const titles = Array.from({ length: 40 }, (_, index) => `P${index + 1}`);
    const planned = titles.flatMap((phase, index) => [
      plan(2 * index, { phase }),
      plan(2 * index + 1, { phase }),
    ]);
    const published = items(
      workflow({ phases: titles.map((title) => ({ title })), currentPhase: "P1", planned }),
    );
    expect(isSnapshot(published)).toBe(true);
    const [run] = published;
    const phased = (run?.phases ?? []).reduce((sum, phase) => sum + (phase.planned ?? 0), 0);
    expect(phased).toBeLessThan(planned.length);
    // Every planned agent is counted once: by its shown phase, or by the workflow.
    expect(phased + (run?.unphasedPlanned ?? 0)).toBe(planned.length);
    expect(items(workflow({ planned: [plan(1)] }))[0]?.unphasedPlanned).toBeUndefined();
  });

  it("dates never-run agents to their workflow's end, so history drops older ones first", () => {
    const ended = items(workflow({ state: "completed", endedAt: 9, planned: [plan(1)] }));
    expect(ended.find((item) => item.planned === true)?.endedAt).toBe(9);
    const live = items(workflow({ planned: [plan(1)] }));
    expect(live.find((item) => item.planned === true)?.endedAt).toBeUndefined();
  });

  it("shows a planned agent skipped before it started as skipped, and its call as skipped work", () => {
    const skipped = plan(1, { skippedAt: 7 });
    for (const state of ["running", "completed"] as const) {
      const published = items(
        workflow({
          state,
          planned: [skipped, plan(2)],
          ...(state === "completed" && { endedAt: 9 }),
        }),
      );
      expect(isSnapshot(published)).toBe(true);
      // Its row is skipped work with the reason, no longer planned and no longer skippable.
      const row = byId(published).get("agent-r1-p1");
      expect(row).toMatchObject({
        status: "cancelled",
        skipped: true,
        phase: "Verify",
        endedAt: 7,
      });
      expect(row?.planned).toBeUndefined();
      expect(row?.actions ?? []).toEqual([]);
      expect(row?.summary).toBeTruthy();
      // It never started, so until a call claims it, it is neither work nor planned in its phase.
      expect(published[0]?.phases?.[1]).toMatchObject({ work: { items: 0 }, planned: 1 });
    }
    // The detail says it was skipped, apart from a planned agent that can still run.
    const detail = (id: string) => detailOf(id, workflow({ planned: [skipped, plan(2)] }));
    expect(detail("agent-r1-p1")).not.toBe(detail("agent-r1-p2"));
    // Its claiming call keeps the row id, as skipped work too.
    const claimed = items(
      workflow({
        agents: [
          agent({
            runId: "agent-r1-p1",
            label: "verify:1",
            phase: "Verify",
            state: "skipped",
            endedAt: 8,
            reason: "skipped by the user before it started",
          }),
        ],
        planned: [plan(2)],
      }),
    );
    expect(byId(claimed).get("agent-r1-p1")).toMatchObject({
      status: "cancelled",
      skipped: true,
      endedAt: 8,
    });
    expect(claimed[0]?.phases?.[1]).toMatchObject({
      work: { items: 1, finished: 1, stopped: 0, skipped: 1 },
      planned: 1,
    });
  });

  it("shows the newest log line as the workflow's narrator summary", () => {
    expect(items(workflow({ lastLog: "Reviewing 4 call sites" }))[0]?.summary).toBe(
      "Reviewing 4 call sites",
    );
    expect(items(workflow())[0]?.summary).toBeUndefined();
  });

  it("revises only the items a change touches", () => {
    const before = byId(items(workflow({ planned: [plan(1)], agents: [agent()] })));
    const after = byId(
      items(
        workflow({
          planned: [plan(1)],
          agents: [agent()],
          lastLog: "Found 4 call sites",
          logs: [{ at: 5, level: "info", message: "Found 4 call sites" }],
        }),
      ),
    );
    expect(after.get("workflow:wf-a-1")?.revision).not.toBe(
      before.get("workflow:wf-a-1")?.revision,
    );
    for (const id of ["agent-r1-p1", "agent-r1-1"])
      expect(after.get(id)?.revision).toBe(before.get(id)?.revision);
  });

  it("explains a planned agent in the detail pane until its call claims it", () => {
    const detail = (run: WorkflowRunView) => detailOf("agent-r1-p1", run);
    const live = workflow({ planned: [plan(1, { profile: "reviewer" })] });
    // Its row places it in its phase with its profile; the detail says whether it can still run.
    expect(byId(items(live)).get("agent-r1-p1")).toMatchObject({
      phase: "Verify",
      profile: "reviewer",
    });
    expect(detail(live)).toBeDefined();
    const ended = detail(
      workflow({ state: "completed", endedAt: 9, planned: [plan(1, { profile: "reviewer" })] }),
    );
    expect(ended).toBeDefined();
    expect(ended).not.toBe(detail(live));
    expect(detailOf("workflow:wf-a-1", workflow({ planned: [plan(1)] }))).toContain("verify:1");
  });

  effectTest("routes a planned row's skip to the workflow service by its run id", function* () {
    const { transport, workflows, actWorkflow, dispose } = registeredWorkflows();
    workflows.publish([workflow({ planned: [plan(1)] })]);
    const shown = byId(hostItems(transport)).get("agent-r1-p1")!;
    expect(shown.planned).toBe(true);
    const signal = new AbortController().signal;
    const invoke = transport.capability()!.invoke!;
    yield* step(() => invoke(shown.id, "skip", shown.revision, signal));
    expect(actWorkflow.mock.calls).toEqual([["skip", "agent-r1-p1", signal]]);
    // Once its call claims it, the planned row's revision is gone, so a skip offered on it is
    // refused instead of reaching the service.
    workflows.publish([
      workflow({ agents: [agent({ runId: "agent-r1-p1", label: "verify:1", phase: "Verify" })] }),
    ]);
    expect(byId(hostItems(transport)).get(shown.id)?.revision).not.toBe(shown.revision);
    yield* step(() => expect(invoke(shown.id, "skip", shown.revision, signal)).rejects.toThrow());
    // And a skipped one offers no skip at all.
    workflows.publish([workflow({ planned: [plan(1, { skippedAt: 3 })] })]);
    const skipped = byId(hostItems(transport)).get("agent-r1-p1")!;
    yield* step(() =>
      expect(invoke(skipped.id, "skip", skipped.revision, signal)).rejects.toThrow(),
    );
    expect(actWorkflow).toHaveBeenCalledTimes(1);
    dispose();
  });

  describe("calls that settled without a subagent run", () => {
    const couldNotStart = agent({
      state: "failed",
      reason: "couldn't start: no eligible route\nsecond line of the error",
      endedAt: 5,
    });
    const skipped = agent({
      callId: 2,
      runId: "agent-r1-2",
      label: "checker",
      state: "skipped",
      reason: "skipped by the user",
      endedAt: 6,
    });
    const failedMember = agent({
      callId: 3,
      runId: "agent-r1-3",
      label: "reader",
      state: "failed",
      reason: "Run failed.",
      startedAt: 3,
      endedAt: 7,
    });
    const memberRun = view({
      ...owned("agent-r1-3"),
      state: "failed",
      endedAt: 7,
      error: "Backend exited with code 1\nstack line",
    });

    it("keeps a terminal row with its reason, and its phase reports the failure", () => {
      for (const state of ["running", "completed"] as const) {
        const published = itemsOf(
          [memberRun],
          workflow({
            state,
            ...(state === "completed" && { endedAt: 9 }),
            agents: [skipped, couldNotStart, failedMember],
          }),
        );
        expect(isSnapshot(published)).toBe(true);
        const found = byId(published);
        const parent = WORKFLOW_PARENT;
        expect(found.get("agent-r1-1")).toMatchObject({ status: "failed", parent, phase: "Find" });
        expect(found.get("agent-r1-1")?.summary).toContain("no eligible route");
        expect(found.get("agent-r1-1")?.summary).not.toContain("second line");
        expect(found.get("agent-r1-1")?.actions ?? []).toEqual([]);
        expect(found.get("agent-r1-2")).toMatchObject({
          status: "cancelled",
          skipped: true,
          parent,
        });
        expect(found.get("agent-r1-2")?.summary).toContain("skipped by the user");
        // Failures come first, so a cap or the host's history retention drops them last.
        const order = published.map((item) => item.id);
        expect(order.indexOf("agent-r1-1")).toBeLessThan(order.indexOf("agent-r1-2"));
        // A member that failed after starting keeps its own run's row, with a short reason.
        expect(published.filter((item) => item.id === "agent-r1-3")).toHaveLength(1);
        expect(found.get("agent-r1-3")).toMatchObject({ status: "failed" });
        expect(found.get("agent-r1-3")?.summary).toContain("Run failed.");
        // Every failed call counts, started or not, so the phase stays failed without rows.
        expect(published[0]?.phases?.[0]).toMatchObject({
          title: "Find",
          work: { items: 3, finished: 3, stopped: 0, failed: 2, skipped: 1 },
        });
      }
    });

    it("drops a call's reason once its run works again after the workflow ended", () => {
      const finished = workflow({ state: "completed", endedAt: 9, agents: [failedMember] });
      const resumed = (state: SubagentRunView["state"], endedAt?: number) =>
        byId(itemsOf([view({ ...memberRun, state, error: undefined, endedAt })], finished)).get(
          "agent-r1-3",
        )?.summary;
      expect(resumed("running") ?? "").not.toContain("Run failed.");
      expect(resumed("completed", 40) ?? "").not.toContain("Run failed.");
      expect(resumed("failed", 7)).toContain("Run failed.");
    });

    it("says why the call returned null, in full in the detail when its row clips it", () => {
      const detail = (id: string) => detailOf(id, workflow({ agents: [couldNotStart, skipped] }));
      expect(detail("agent-r1-1")).toContain("second line of the error");
      expect(
        byId(items(workflow({ agents: [couldNotStart, skipped] }))).get("agent-r1-2"),
      ).toMatchObject({
        summary: "skipped by the user",
      });
      expect(detail("agent-r1-2")).toBeDefined();
    });

    it("bounds settled rows per workflow, keeping failures and then the newest", () => {
      const settled = Array.from({ length: 40 }, (_, index) =>
        agent({
          callId: index + 1,
          runId: `agent-r1-${index + 1}`,
          state: index % 4 === 0 ? "failed" : "skipped",
          reason: index % 4 === 0 ? "couldn't start: pool paused" : "skipped by the user",
          endedAt: 100 + index,
        }),
      );
      const published = items(workflow({ agents: settled }));
      const rows = published.filter((item) => item.kind === "agent");
      expect(rows.length).toBeLessThan(settled.length);
      const failed = settled
        .filter((entry) => entry.state === "failed")
        .map((entry) => entry.runId);
      expect(rows.filter((item) => item.status === "failed").map((item) => item.id)).toEqual(
        failed.toReversed(),
      );
      // The oldest skipped calls are the ones dropped.
      const shown = new Set(rows.map((item) => item.id));
      const skippedShown = settled.filter(
        (entry) => entry.state === "skipped" && shown.has(entry.runId),
      );
      const newestSkipped = settled
        .filter((entry) => entry.state === "skipped")
        .slice(-skippedShown.length);
      expect(skippedShown).toEqual(newestSkipped);
      expect(published[0]?.phases?.[0]?.work).toEqual({
        items: 40,
        finished: 40,
        stopped: 0,
        failed: 10,
        skipped: 30,
      });
      const many = items(
        ...Array.from({ length: 40 }, (_, run) =>
          workflow({
            id: `wf-a-${run}`,
            state: "completed",
            endedAt: 10 + run,
            agents: settled.map((entry) => ({ ...entry, runId: `${entry.runId}-${run}` })),
          }),
        ),
      );
      expect(isSnapshot(many)).toBe(true);
    });

    it("shows a member whose run completed but whose call failed as failed", () => {
      const contract = agent({
        callId: 4,
        runId: "agent-r1-4",
        label: "parser",
        state: "failed",
        reason: "The structured result wasn't valid JSON.",
        startedAt: 3,
        endedAt: 8,
      });
      const completed = view({ ...owned("agent-r1-4"), state: "completed", endedAt: 8 });
      const published = itemsOf([completed], workflow({ agents: [contract] }));
      // The row agrees with its phase, and the widget keeps it while the workflow runs.
      const row = byId(published).get("agent-r1-4");
      expect(row).toMatchObject({ status: "failed" });
      expect(row?.summary).toContain("wasn't valid JSON");
      expect(published[0]?.phases?.[0]?.work).toMatchObject({ failed: 1 });
    });

    it("gives a running workflow's plan its slots before finished workflows' history", () => {
      const history = Array.from({ length: 8 }, (_, index) =>
        agent({
          callId: index + 1,
          runId: `agent-r0-${index + 1}`,
          state: "stopped",
          reason: "the workflow stopped",
          endedAt: 5 + index,
        }),
      );
      const published = workflowActivityItems({
        runs: [
          workflow({ id: "wf-a-0", state: "stopped", endedAt: 20, agents: history }),
          workflow({ planned: [plan(1), plan(2)] }),
        ],
        visibleRunIds: new Set(),
        providerId: "pi-subagents",
        budget: 4,
      });
      expect(published.map((item) => item.id)).toEqual([
        "workflow:wf-a-1",
        "workflow:wf-a-0",
        "agent-r1-p1",
        "agent-r1-p2",
      ]);
    });
  });

  describe("actions between coalesced publishes", () => {
    effectTest(
      "acts on the row Activity last showed while later changes are held back",
      function* () {
        const { transport, workflows, actWorkflow, dispose } = registeredWorkflows();
        const scope = yield* Scope.make();
        const runs = yield* makeWorkflowRuns(workflows).pipe(Scope.provide(scope));
        yield* runs.mutate(() => [workflow({ agents: [agent()], lastLog: "line 1" })]);
        const shown = byId(hostItems(transport));
        const row = shown.get("workflow:wf-a-1")!;
        const placeholder = shown.get("agent-r1-1")!;
        // The log line changes the workflow's row, but its publish is still held back.
        yield* runs.recordEvent("wf-a-1", { type: "log", message: "line 2" });
        expect(byId(hostItems(transport)).get(row.id)?.revision).toBe(row.revision);
        const signal = new AbortController().signal;
        const capability = transport.capability()!;
        const detail = yield* step(() => capability.getDetail!(row.id, row.revision, signal));
        expect(detail).toContain("Review the diff by dimension");
        yield* step(() => capability.invoke!(placeholder.id, "skip", placeholder.revision, signal));
        yield* step(() => capability.invoke!(row.id, "stop", row.revision, signal));
        expect(actWorkflow.mock.calls).toEqual([
          ["skip", "agent-r1-1", signal],
          ["stop", "wf-a-1", signal],
        ]);
        yield* Scope.close(scope, Exit.void);
        dispose();
      },
    );

    effectTest("refuses a revision from before the last publish", function* () {
      const { transport, workflows, actWorkflow, dispose } = registeredWorkflows();
      workflows.publish([workflow({ lastLog: "line 1" })]);
      const stale = byId(hostItems(transport)).get("workflow:wf-a-1")!;
      workflows.publish([workflow({ lastLog: "line 2" })]);
      expect(byId(hostItems(transport)).get(stale.id)?.revision).not.toBe(stale.revision);
      const signal = new AbortController().signal;
      const capability = transport.capability()!;
      yield* step(() =>
        expect(capability.invoke!(stale.id, "stop", stale.revision, signal)).rejects.toThrow(),
      );
      yield* step(() =>
        expect(capability.getDetail!(stale.id, stale.revision, signal)).rejects.toThrow(),
      );
      expect(actWorkflow).not.toHaveBeenCalled();
      dispose();
    });
  });

  it("opens an agent's detail with why its call failed and what it found, technical facts last", () => {
    const member = view({
      ...owned("agent-r1-3", "Verify"),
      name: "verifier",
      state: "completed",
      endedAt: 61_000,
      profile: "reviewer",
      task: "Verify the finding in src/auth.ts",
      finalText: "The finding holds: tokens are reused.",
      sessionEvents: [
        { type: "tool", toolCallId: "t1", toolName: "read", state: "completed", startedAt: 2 },
      ],
      usage: { input: 9_000, output: 3_000, cacheRead: 0, cacheWrite: 0, totalTokens: 12_000 },
      toolUses: 4,
    });
    const workflows = snapshot(
      workflow({
        agents: [
          agent({
            runId: "agent-r1-3",
            label: "verifier",
            phase: "Verify",
            state: "failed",
            reason: "The structured result wasn't valid JSON.",
            startedAt: 1,
            endedAt: 61_000,
          }),
        ],
      }),
    );
    const detail =
      subagentActivityDetail({ revision: 1, runs: [member] }, "agent-r1-3", workflows, 90_000) ??
      "";
    // Activity shows its state, profile, workflow, phase and summary beside the detail.
    for (const fact of [
      "The finding holds",
      "Verify the finding in src/auth.ts",
      formatTokens(12_000),
      "agent-r1-3",
      "/project",
    ])
      expect(detail).toContain(fact);
    // The row draws the failed state itself, so its summary is the reason alone.
    const row = byId(itemsOf([member], ...workflows.runs));
    expect(row.get("agent-r1-3")).toMatchObject({
      status: "failed",
      summary: "The structured result wasn't valid JSON.",
    });
    // What the agent found comes before the technical facts.
    expect(detail.indexOf("The finding holds")).toBeLessThan(detail.indexOf("agent-r1-3"));
    expect(detail.indexOf("The finding holds")).toBeLessThan(detail.indexOf("/project"));
  });

  it("lists a workflow's failed agents first in its detail, beside its script and journal", () => {
    const run = workflow({
      scriptPath: "/runs/wf-a-1/script.js",
      journalPath: "/runs/wf-a-1/journal.jsonl",
      agents: [
        agent({ label: "finder", state: "completed", startedAt: 2, endedAt: 9 }),
        agent({
          callId: 2,
          runId: "agent-r1-2",
          label: "checker",
          phase: "Verify",
          state: "failed",
          reason: "couldn't start: no eligible route",
          endedAt: 10,
        }),
      ],
    });
    const detail = detailOf("workflow:wf-a-1", run);
    expect(detail).toContain("/runs/wf-a-1/script.js");
    expect(detail).toContain("/runs/wf-a-1/journal.jsonl");
    expect(detail).toContain("no eligible route");
    const agents = detail?.slice(detail.indexOf("checker")) ?? "";
    expect(agents).toContain("finder");
  });
});
