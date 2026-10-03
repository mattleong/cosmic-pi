import { describe, expect, it } from "@effect/vitest";
import * as Schema from "effect/Schema";
import { ActivitySnapshotSchema, type ActivityItem } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { vi } from "vitest";
import {
  makeWorkflowActivitySource,
  registerSubagentActivity,
  subagentActivityDetail,
  subagentActivityItems,
  type WorkflowActivitySnapshot,
} from "../../src/boundary/host-activity.ts";
import { makeSubagentProjectionBridge } from "../../src/boundary/host-ui.ts";
import type { SubagentProjection, SubagentRunView } from "../../src/run/model.ts";
import type { WorkflowAgentView, WorkflowRunView } from "../../src/workflow/model.ts";
import { effectTest, step } from "../support/effect-test.ts";
import { view } from "../tools/fixtures/tool-harness.ts";

const agent = (patch: Partial<WorkflowAgentView> = {}): WorkflowAgentView => ({
  callId: 1,
  runId: "agent-r1-1",
  label: "finder",
  phase: "Find",
  state: "queued",
  queuedAt: 2,
  ...patch,
});

const workflow = (patch: Partial<WorkflowRunView> = {}): WorkflowRunView => ({
  id: "wf-a-1",
  name: "review",
  description: "Review the diff by dimension",
  source: { kind: "inline" },
  sha256: "digest",
  phases: [{ title: "Find" }, { title: "Verify" }],
  currentPhase: "Find",
  state: "running",
  startedAt: 1,
  agents: [],
  reused: 0,
  logs: [],
  outputTokens: 0,
  args: { scope: "src" },
  ...patch,
});

const snapshot = (...runs: ReadonlyArray<WorkflowRunView>): WorkflowActivitySnapshot => ({
  runs,
});

const owned = (id: string, phase = "Find") =>
  view({ id, task: id, workflow: { workflowId: "wf-a-1", name: "review", phase } });

const byId = (items: ReadonlyArray<ActivityItem>) =>
  new Map(items.map((item) => [item.id, item] as const));

const isSnapshot = Schema.is(ActivitySnapshotSchema);

describe("workflow activity", () => {
  it("nests owned runs under their phase and shows queued agents with a skip action", () => {
    const projection: SubagentProjection = { revision: 3, runs: [owned("agent-r1-1")] };
    const items = subagentActivityItems(
      projection,
      undefined,
      snapshot(
        workflow({
          agents: [
            agent({ state: "running" }),
            agent({ callId: 2, runId: "agent-r1-2", label: "verifier", phase: "Verify" }),
          ],
        }),
      ),
    );
    expect(isSnapshot(items)).toBe(true);
    const found = byId(items);
    expect(found.get("workflow:wf-a-1")).toMatchObject({
      kind: "workflow",
      status: "running",
      phases: [{ title: "Find" }, { title: "Verify" }],
      phase: "Find",
      actions: [expect.objectContaining({ id: "stop" })],
    });
    const parent = { providerId: "pi-subagents", itemId: "workflow:wf-a-1" };
    expect(found.get("agent-r1-1")).toMatchObject({ kind: "agent", parent, phase: "Find" });
    expect(found.get("agent-r1-2")).toMatchObject({
      kind: "agent",
      status: "pending",
      parent,
      phase: "Verify",
      actions: [{ id: "skip", label: "Skip" }],
    });
    expect(found.get("agent-r1-2")?.startedAt).toBeUndefined();
  });

  it("asks before skipping a queued agent, since its agent() call then resolves to null", () => {
    const [, placeholder] = subagentActivityItems(
      { revision: 1, runs: [] },
      undefined,
      snapshot(workflow({ agents: [agent()] })),
    );
    expect(placeholder?.actions).toEqual([
      expect.objectContaining({ id: "skip", handoff: false, confirmation: expect.any(String) }),
    ]);
  });

  it("offers resume on a completed member only once its workflow no longer owns it", () => {
    const completed = view({ ...owned("agent-r1-1"), state: "completed", endedAt: 4 });
    const paused = view({ ...owned("agent-r1-2"), state: "paused" });
    const resumable = (workflows: WorkflowActivitySnapshot) =>
      subagentActivityItems({ revision: 1, runs: [completed, paused] }, undefined, workflows)
        .filter((item) => item.actions?.some((action) => action.id === "resume"))
        .map((item) => item.id);
    // A running or stopping workflow still receives the completed member's result.
    expect(resumable(snapshot(workflow()))).toEqual(["agent-r1-2"]);
    expect(resumable(snapshot(workflow({ state: "stopping" })))).toEqual(["agent-r1-2"]);
    // Once the workflow ends, or leaves the snapshot, its members are the root's.
    expect(resumable(snapshot(workflow({ state: "completed", endedAt: 9 })))).toEqual([
      "agent-r1-1",
      "agent-r1-2",
    ]);
    expect(resumable(snapshot())).toEqual(["agent-r1-1", "agent-r1-2"]);
  });

  it("publishes a former member working again after its workflow ended as a root run", () => {
    const finished = snapshot(workflow({ state: "completed", endedAt: 9 }));
    const placement = (state: SubagentRunView["state"], workflows: WorkflowActivitySnapshot) => {
      const item = subagentActivityItems(
        { revision: 1, runs: [view({ ...owned("agent-r1-1"), state })] },
        undefined,
        workflows,
      ).find((candidate) => candidate.id === "agent-r1-1");
      return { parent: item?.parent?.itemId, phase: item?.phase };
    };
    const member = { parent: "workflow:wf-a-1", phase: "Find" };
    const root = { parent: undefined, phase: undefined };
    expect(placement("running", snapshot(workflow()))).toEqual(member);
    // Finished members stay under their finished workflow as history.
    expect(placement("completed", finished)).toEqual(member);
    expect(placement("completed", snapshot())).toEqual(member);
    // A resumed former member is the root's; it no longer reopens the workflow.
    for (const state of ["running", "waiting_for_parent", "paused", "stopping"] as const) {
      expect(placement(state, finished)).toEqual(root);
      expect(placement(state, snapshot())).toEqual(root);
    }
  });

  effectTest("refuses resume on a completed member until its workflow ends", function* () {
    const transport = fakeActivityHost();
    const bridge = makeSubagentProjectionBridge();
    const workflows = makeWorkflowActivitySource();
    bridge.publish({
      revision: 1,
      runs: [view({ ...owned("agent-r1-1"), state: "completed", endedAt: 4 })],
    });
    const input = vi.fn(() => Promise.resolve("continue"));
    const act = vi.fn(() => Promise.resolve());
    const dispose = registerSubagentActivity({
      events: transport.events,
      sessionId: "session",
      bridge,
      workflows,
      isCurrent: () => true,
      input,
      act,
    });
    const member = () =>
      subagentActivityItems(bridge.get(), bridge.getActivityPresentation(), workflows.get()).find(
        (item) => item.id === "agent-r1-1",
      )!;
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
    const items = subagentActivityItems(
      { revision: 1, runs: [owned("agent-r1-1")] },
      undefined,
      snapshot(workflow({ agents: [agent()] })),
    );
    expect(items.filter((item) => item.id === "agent-r1-1")).toHaveLength(1);
    expect(items.find((item) => item.id === "agent-r1-1")?.status).not.toBe("pending");
  });

  it("bounds queued rows per workflow and the whole snapshot", () => {
    const queued = Array.from({ length: 100 }, (_, index) =>
      agent({ callId: index + 1, runId: `agent-r1-${index + 1}` }),
    );
    const one = subagentActivityItems(
      { revision: 1, runs: [] },
      undefined,
      snapshot(workflow({ agents: queued })),
    );
    expect(one.filter((item) => item.status === "pending")).toHaveLength(64);
    const many = subagentActivityItems(
      { revision: 1, runs: [] },
      undefined,
      snapshot(
        ...Array.from({ length: 12 }, (_, index) =>
          workflow({
            id: `wf-a-${index}`,
            agents: queued.map((entry) => ({ ...entry, runId: `${entry.runId}-${index}` })),
          }),
        ),
      ),
    );
    expect(many.length).toBeLessThanOrEqual(512);
    expect(isSnapshot(many)).toBe(true);
    expect(many.filter((item) => item.kind === "workflow")).toHaveLength(12);
  });

  it("offers no stop on finished workflows and keeps phases valid for runtime additions", () => {
    const longPrefix = `▸ ${"n".repeat(80)} · ${"p".repeat(150)}`;
    const items = subagentActivityItems(
      { revision: 1, runs: [] },
      undefined,
      snapshot(
        workflow({
          state: "completed",
          endedAt: 9,
          phases: [{ title: "Find" }, { title: longPrefix.slice(0, 160) }],
          currentPhase: longPrefix.slice(0, 160),
        }),
      ),
    );
    expect(isSnapshot(items)).toBe(true);
    expect(items[0]).toMatchObject({ status: "done", actions: [] });
  });

  it("hands off actions that open input and keeps stop, interrupt and skip in place", () => {
    const question = { requestId: "q", message: "Question", createdAt: 1 };
    const offered = [
      view({ id: "running" }),
      view({ id: "paused", state: "paused" }),
      view({ id: "asking", state: "waiting_for_parent", question }),
      view({ id: "reported", state: "reported", closeOnReport: false }),
    ];
    const items = subagentActivityItems(
      { revision: 1, runs: offered },
      undefined,
      snapshot(workflow({ agents: [agent()] })),
    );
    const actions = items.flatMap((item) => item.actions ?? []);
    const handoff = (id: string) =>
      new Set(actions.filter((action) => action.id === id).map((action) => action.handoff));
    for (const input of ["message", "rename", "resume", "reply"])
      expect(handoff(input)).toEqual(new Set([true]));
    expect(items.find((item) => item.kind === "workflow")?.actions).toEqual([
      expect.objectContaining({ id: "stop", handoff: false }),
    ]);
    for (const inPlace of ["stop", "interrupt", "skip"])
      expect(handoff(inPlace)).toEqual(new Set([false]));
  });

  it("counts every agent per phase, including ones whose rows are gone", () => {
    const items = subagentActivityItems(
      { revision: 1, runs: [] },
      undefined,
      snapshot(
        workflow({
          currentPhase: "Verify",
          agents: [
            agent({ state: "completed" }),
            agent({ callId: 2, runId: "agent-r1-2", state: "skipped" }),
            agent({ callId: 3, runId: "agent-r1-3", phase: "Verify", state: "running" }),
          ],
        }),
      ),
    );
    expect(items[0]?.phases).toEqual([
      { title: "Find", work: { items: 2, finished: 2, stopped: 1 } },
      { title: "Verify", work: { items: 1, finished: 0, stopped: 0 } },
    ]);
  });

  it("counts results reused on resume as finished work in their phase", () => {
    const resumed = (state: WorkflowRunView["state"]) =>
      subagentActivityItems(
        { revision: 1, runs: [] },
        undefined,
        snapshot(
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
        ),
      )[0]?.phases;
    // Every Find call was reused, so Find is finished work rather than an empty, passed phase.
    expect(resumed("running")).toEqual([
      { title: "Find", work: { items: 20, finished: 20, stopped: 0 } },
      { title: "Verify", work: { items: 2, finished: 1, stopped: 0 } },
    ]);
    expect(resumed("completed")).toEqual([
      { title: "Find", work: { items: 20, finished: 20, stopped: 0 } },
      { title: "Verify", work: { items: 2, finished: 2, stopped: 0 } },
    ]);
  });

  it("keeps a finished member under its workflow after the workflow leaves the snapshot", () => {
    const [item] = subagentActivityItems(
      { revision: 1, runs: [view({ ...owned("agent-r1-1", "Verify"), state: "completed" })] },
      undefined,
      snapshot(),
    );
    expect(item).toMatchObject({
      parent: { providerId: "pi-subagents", itemId: "workflow:wf-a-1" },
      phase: "Verify",
    });
  });

  effectTest("confirms workflow stop and skip after unrelated publications", function* () {
    const transport = fakeActivityHost();
    const bridge = makeSubagentProjectionBridge();
    const workflows = makeWorkflowActivitySource();
    const member = owned("agent-r1-1");
    bridge.publish({ revision: 1, runs: [member] });
    const actWorkflow = vi.fn(() => Promise.resolve());
    const dispose = registerSubagentActivity({
      events: transport.events,
      sessionId: "session",
      bridge,
      workflows,
      actWorkflow,
      isCurrent: () => true,
      act: () => Promise.reject(new Error("Unexpected subagent action")),
    });
    const running = workflow({
      agents: [
        agent({ state: "running" }),
        agent({ callId: 2, runId: "agent-r1-2", phase: "Verify" }),
      ],
    });
    workflows.publish([running]);
    const shown = byId(
      subagentActivityItems(bridge.get(), bridge.getActivityPresentation(), workflows.get()),
    );
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

  it("describes a workflow and a queued agent in the detail pane", () => {
    const workflows = snapshot(
      workflow({
        agents: [agent()],
        logs: [{ at: 3, level: "warning", message: "agent finder was skipped" }],
      }),
    );
    const detail = subagentActivityDetail({ revision: 1, runs: [] }, "workflow:wf-a-1", workflows);
    expect(detail).toContain("Review the diff by dimension");
    expect(detail).toContain("agent finder was skipped");
    expect(detail).toContain('"scope":"src"');
    expect(subagentActivityDetail({ revision: 1, runs: [] }, "agent-r1-1", workflows)).toContain(
      "finder",
    );
  });

  effectTest("routes skip and workflow stop to the workflow service", function* () {
    const transport = fakeActivityHost();
    const bridge = makeSubagentProjectionBridge();
    const workflows = makeWorkflowActivitySource();
    bridge.publish({ revision: 1, runs: [] });
    const actWorkflow = vi.fn(() => Promise.resolve());
    const dispose = registerSubagentActivity({
      events: transport.events,
      sessionId: "session",
      bridge,
      workflows,
      actWorkflow,
      isCurrent: () => true,
      act: () => Promise.reject(new Error("Unexpected subagent action")),
    });
    workflows.publish([workflow({ agents: [agent()] })]);
    const items = subagentActivityItems(
      bridge.get(),
      bridge.getActivityPresentation(),
      workflows.get(),
    );
    const published = transport.get()?.items;
    expect(Array.isArray(published) && published.length).toBe(2);
    const signal = new AbortController().signal;
    const invoke = transport.capability()!.invoke!;
    const placeholder = items.find((item) => item.id === "agent-r1-1")!;
    yield* step(() => invoke(placeholder.id, "skip", placeholder.revision, signal));
    const run = items.find((item) => item.kind === "workflow")!;
    yield* step(() => invoke(run.id, "stop", run.revision, signal));
    expect(actWorkflow.mock.calls).toEqual([
      ["skip", "agent-r1-1", signal],
      ["stop", "wf-a-1", signal],
    ]);
    dispose();
  });
});
