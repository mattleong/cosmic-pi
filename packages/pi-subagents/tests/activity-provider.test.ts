import { assert, describe, expect, it } from "@effect/vitest";
import { effectTest, step } from "./support/effect-test.ts";
import { vi } from "vitest";
import { ACTIVITY_HOST } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { deferredPromise } from "pi-cosmic-core/testing";
import { captureSubagentControlExpectation, type SubagentRunView } from "../src/run/model.ts";
import * as Effect from "effect/Effect";
import {
  registerSubagentActivity,
  runSubagentActivityAction,
} from "../src/boundary/host-activity.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";
import { subagentActivityDetail, subagentActivityItems } from "../src/ui/run-activity.ts";
import { subagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { finishToolSessionEvent, startToolSessionEvent } from "../src/run/session-events.ts";
import { view } from "./fixtures/run-view.ts";
import { normalizeRpcEvent } from "../src/backend/local-pi-events.ts";
import { awaitDetails, startDetails } from "../src/tools/details.ts";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";

const question = { requestId: "q", message: "Question" };
const envelope = (text: string) => [{ type: "text", text }];
interface ChildToolResult {
  readonly content: ReadonlyArray<{ readonly type: string; readonly text: string }>;
  readonly details?: object;
}

/** A child's finished tool call, normalized by the backend as it would arrive over RPC. */
const childToolEvent = (
  events: SubagentRunView["sessionEvents"],
  toolCallId: string,
  toolName: string,
  result: ChildToolResult,
): SubagentRunView["sessionEvents"] => {
  const event = Effect.runSync(
    normalizeRpcEvent(
      { type: "tool_execution_end", toolCallId, toolName, result, isError: false },
      1,
    ),
  );
  assert(event?.type === "tool_finished");
  return finishToolSessionEvent(events, { ...event, endedAt: 3 });
};

const promptedProvider = (runs: ReadonlyArray<SubagentRunView>, isCurrent = () => true) => {
  const transport = fakeActivityHost();
  const bridge = subagentProjectionBridge();
  bridge.publish({ revision: 1, runs });
  const pending = deferredPromise<string | undefined>();
  const admitted = deferredPromise();
  const act = vi.fn(() => Promise.resolve());
  const dispose = registerSubagentActivity({
    events: transport.events,
    sessionId: "session",
    bridge,
    isCurrent,
    input: () => {
      admitted.resolve();
      return pending.promise;
    },
    act,
  });
  const item = Option.getOrUndefined(
    Arr.findFirst(
      subagentActivityItems(bridge.get(), bridge.getActivityPresentation()),
      (candidate) => candidate.id === "selected",
    ),
  )!;
  // Discovered callbacks are foreign, so their results settle as untrusted values.
  const invoke = (action: string, signal: AbortSignal) =>
    Promise.resolve<unknown>(
      transport.capability()!.invoke!(item.id, action, item.revision, signal),
    );
  return { transport, bridge, pending, admitted, act, dispose, invoke };
};

describe("subagent activity provider", () => {
  effectTest(
    "offers stop verification for terminal recoverable cleanup without changing completed work",
    function* () {
      const run = view({
        id: "selected",
        state: "completed",
        finalText: "Accepted work report sentinel",
        cleanup: {
          disposition: "quarantined",
          recovery: "stop",
          diagnostic: {
            phase: "process-group",
            code: "group_live",
            message: "Cleanup detail sentinel",
          },
        },
        writerCleanupQuarantined: true,
      });
      const { bridge, transport, act, dispose, invoke } = promptedProvider([run]);
      const item = subagentActivityItems(bridge.get())[0]!;
      expect(item.status).toBe("blocked");
      assert(item.actions !== undefined);
      expect(Arr.map(item.actions, (action) => action.id)).toContain("stop");
      const detail = JSON.stringify(subagentActivityDetail(bridge.get(), run.id));
      expect(detail).toContain("Cleanup detail sentinel");
      expect(detail).toContain("Accepted work report sentinel");
      const signal = new AbortController().signal;
      yield* step(() => invoke("stop", signal));
      expect(act).toHaveBeenCalledWith(
        run.id,
        { action: "stop" },
        signal,
        captureSubagentControlExpectation(run),
      );
      const manual = {
        ...run,
        cleanup: { disposition: "quarantined" as const, recovery: "manual" as const },
      };
      bridge.publish({ revision: 2, runs: [manual] });
      const manualActions = subagentActivityItems(bridge.get())[0]!.actions;
      assert(manualActions !== undefined);
      expect(Arr.map(manualActions, (action) => action.id)).not.toContain("stop");
      yield* step(() =>
        expect(
          transport.capability()!.invoke!(run.id, "stop", item.revision, signal),
        ).rejects.toThrow(),
      );
      const confirmed = {
        ...run,
        cleanup: { disposition: "confirmed" as const },
        writerCleanupQuarantined: false,
      };
      bridge.publish({ revision: 3, runs: [confirmed] });
      const done = subagentActivityItems(bridge.get())[0]!;
      expect(done.status).toBe("done");
      assert(done.actions !== undefined);
      expect(Arr.map(done.actions, (action) => action.id)).not.toContain("stop");
      dispose();
    },
  );

  effectTest("revokes an action capability when only its assignment epoch changes", function* () {
    const selected = view({ id: "selected", assignmentEpoch: 1 });
    const { bridge, transport, act, dispose, invoke } = promptedProvider([selected]);
    const signal = new AbortController().signal;
    const resumed = { ...selected, assignmentEpoch: 2 };
    bridge.publish({ revision: 2, runs: [resumed] });
    yield* step(() => expect(invoke("stop", signal)).rejects.toBeInstanceOf(Error));
    expect(act).not.toHaveBeenCalled();
    const item = subagentActivityItems(bridge.get(), bridge.getActivityPresentation())[0]!;
    yield* step(() =>
      Promise.resolve<unknown>(
        transport.capability()!.invoke!(item.id, "stop", item.revision, signal),
      ),
    );
    expect(act).toHaveBeenCalledWith(
      "selected",
      { action: "stop" },
      signal,
      captureSubagentControlExpectation(resumed),
    );
    dispose();
  });

  for (const changed of [
    "assignment",
    "epoch",
    "question",
    "session",
    "cancel",
    "dispose",
    "host-withdrawal",
    "host-restored",
    "host-replaced",
  ] as const) {
    effectTest(`rejects a prompted action after ${changed} changes`, function* () {
      const selected = view({ id: "selected", state: "waiting_for_parent", question });
      let current = true;
      const { transport, bridge, pending, admitted, act, dispose, invoke } = promptedProvider(
        [selected],
        () => current,
      );
      const controller = new AbortController();
      const call = invoke("reply", controller.signal);
      yield* step(() => admitted.promise);
      if (changed === "session") current = false;
      else if (changed === "cancel") controller.abort();
      else if (changed === "dispose") dispose();
      else if (Fn.pipe(changed, Str.startsWith("host-"))) {
        transport.events.emit(ACTIVITY_HOST, {
          version: 1,
          sessionId: "session",
          hostToken: transport.hostToken,
          available: false,
        });
        if (changed !== "host-withdrawal")
          transport.events.emit(ACTIVITY_HOST, {
            version: 1,
            sessionId: "session",
            hostToken: changed === "host-replaced" ? {} : transport.hostToken,
            available: true,
          });
      } else
        bridge.publish({
          revision: 2,
          runs: [
            {
              ...selected,
              ...(changed === "assignment" && { reportGeneration: selected.reportGeneration + 1 }),
              ...(changed === "epoch" && { assignmentEpoch: selected.assignmentEpoch + 1 }),
              ...(changed === "question" && {
                question: { requestId: "q-new", message: "Another question" },
              }),
            },
          ],
        });
      pending.resolve("reply text");
      yield* step(() => expect(call).rejects.toThrow());
      expect(act).not.toHaveBeenCalled();
      dispose();
    });
  }

  it("shows a waiting run as awaiting its parent and a paused run as held, not blocked", () => {
    const items = subagentActivityItems({
      revision: 1,
      runs: [
        view({ id: "asking", state: "waiting_for_parent", question }),
        view({ id: "waiting", state: "waiting_for_parent" }),
        view({ id: "paused", state: "paused" }),
      ],
    });
    const status = (id: string) =>
      Option.getOrUndefined(Arr.findFirst(items, (item) => item.id === id));
    expect(status("asking")).toMatchObject({ status: "needs-input", inputTarget: "parent" });
    expect(status("waiting")).toMatchObject({ status: "needs-input", inputTarget: "parent" });
    expect(status("paused")?.status).toBe("paused");
  });

  it("shows a report once, as Markdown, and keeps run identity behind the technical disclosure", () => {
    const report = "Found `itemCount` in **cart.ts**";
    const run = view({
      id: "run",
      state: "completed",
      finalText: report,
      cwd: "/private/workspace",
      sessionEvents: [
        { type: "tool", toolCallId: "t", toolName: "bash", state: "completed", startedAt: 1 },
        { type: "assistant", text: report, createdAt: 2 },
      ],
    });
    const detail = subagentActivityDetail({ revision: 1, runs: [run] }, "run");
    const bodies = Arr.map(detail?.sections ?? [], (section) => section.body);
    expect(Arr.filter(bodies, Str.includes("itemCount"))).toHaveLength(1);
    expect(detail?.sections).toContainEqual(expect.objectContaining({ format: "markdown" }));
    expect(Arr.join(bodies, "\n")).not.toContain("/private/workspace");
    expect(JSON.stringify(detail?.technical)).toContain("/private/workspace");
  });

  it("describes what a running agent is doing and keeps tool output indented as printed", () => {
    const started = startToolSessionEvent([], {
      toolCallId: "t",
      toolName: "bash",
      args: { command: "sleep 25" },
      startedAt: 1,
    });
    const running = view({
      id: "run",
      state: "running",
      currentTool: "bash",
      sessionEvents: started,
    });
    expect(subagentActivityItems({ revision: 1, runs: [running] })[0]?.summary).toBe(
      "running bash · sleep 25",
    );
    const finished = finishToolSessionEvent(started, {
      toolCallId: "t",
      toolName: "bash",
      isError: false,
      endedAt: 2,
      outputPreview: "\n     1\tfirst\n     2\tsecond  \n\n",
    });
    expect(finished[0]).toMatchObject({ outputPreview: "     1\tfirst\n     2\tsecond" });
  });

  it("keeps the first output line's indentation from the child's event to Activity", () => {
    const started = startToolSessionEvent([], {
      toolCallId: "t",
      toolName: "read",
      args: { path: "src/thing.ts" },
      startedAt: 1,
    });
    const finished = childToolEvent(started, "t", "read", {
      content: [{ type: "text", text: "\n    1  import thing;\n    2  export thing;\n" }],
    });
    const run = view({ id: "run", state: "running", sessionEvents: finished });
    const body = Arr.join(
      Arr.map(
        subagentActivityDetail({ revision: 1, runs: [run] }, "run")?.sections ?? [],
        (section) => section.body,
      ),
      "\n",
    );
    expect(body).toContain("      1  import thing;\n      2  export thing;");
  });

  it("phrases agent tools from their details and keeps envelopes, IDs, and report files technical", () => {
    const reportPath = "/home/me/.pi/agent/subagents/reports/session/agent-child-1.md";
    const child = view({
      id: "agent-child",
      name: "Read tests",
      profile: "scout",
      parentRunId: "agent-parent",
      state: "completed",
      reportGeneration: 1,
      finalText: "Tests in **cart**: `subtotal`",
      reportArchive: { path: reportPath, chars: 30, lines: 1, complete: true },
    });
    const launched = childToolEvent(
      startToolSessionEvent([], {
        toolCallId: "s",
        toolName: "agent_start",
        args: { agents: [{ name: "Read tests", task: "List tests" }] },
        startedAt: 1,
      }),
      "s",
      "agent_start",
      {
        content: envelope(`${child.id} Read tests · scout · openai-codex/gpt-6-luna:high`),
        details: startDetails({
          startEntries: [
            {
              index: 0,
              name: "Read tests",
              profile: "scout",
              status: "started",
              routeStatus: "selected",
              model: "openai-codex/gpt-6-luna",
              effort: "high",
              openaiFastMode: false,
              runId: child.id,
            },
          ],
        }),
      },
    );
    const waiting = startToolSessionEvent(launched, {
      toolCallId: "a",
      toolName: "agent_await",
      args: { runIds: [child.id] },
      startedAt: 2,
    });
    const parent = view({
      id: "agent-parent",
      name: "Review cart",
      state: "running",
      sessionEvents: waiting,
    });
    const live = { revision: 1, runs: [parent, { ...child, state: "running" as const }] };
    expect(subagentActivityItems(live)[0]?.summary).toContain("Read tests");
    expect(subagentActivityItems(live)[0]?.summary).not.toContain("agent_await");

    const settled = childToolEvent(waiting, "a", "agent_await", {
      content: envelope(`${child.id} Read tests · finished\nRead the full report: ${reportPath}`),
      details: awaitDetails({ runs: [child], awaitUntil: "all_finished" }),
    });
    const projection = { revision: 2, runs: [{ ...parent, sessionEvents: settled }, child] };
    const detail = subagentActivityDetail(projection, "agent-parent");
    const shown = Arr.join(
      Arr.map(detail?.sections ?? [], (section) => section.body),
      "\n",
    );
    expect(shown).toContain("Read tests");
    expect(shown).not.toContain(child.id);
    expect(shown).not.toContain(reportPath);
    expect(shown).not.toContain("openai-codex");
    const markdown = Arr.filter(detail?.sections ?? [], (section) => section.format === "markdown");
    expect(Arr.some(markdown, (section) => Str.includes("**cart**")(section.body))).toBe(true);
    const technical = JSON.stringify(detail?.technical);
    expect(technical).toContain(child.id);
    expect(technical).toContain(reportPath);
    expect(technical).toContain("openai-codex/gpt-6-luna");
  });

  it("says a running agent is thinking between tool calls", () => {
    const finished = childToolEvent(
      startToolSessionEvent([], {
        toolCallId: "t",
        toolName: "bash",
        args: { command: "ls" },
        startedAt: 1,
      }),
      "t",
      "bash",
      { content: [{ type: "text", text: "a" }] },
    );
    const run = view({ id: "run", state: "running", sessionEvents: finished });
    expect(subagentActivityItems({ revision: 1, runs: [run] })[0]?.summary).toBeTruthy();
  });

  it("keeps terminal transitions discoverable and redacts producer payloads", () => {
    const secret = "sk-abcdefgh12345678";
    const run = view({
      id: "run",
      name: `token=${secret}`,
      task: `api_key=${secret}`,
      finalText: `Bearer ${secret}`,
      state: "completed",
    });
    const projection = { revision: 2, runs: [run] };
    expect(subagentActivityItems(projection)[0]?.status).toBe("done");
    expect(JSON.stringify(subagentActivityItems(projection))).not.toContain(secret);
    const detail = JSON.stringify(subagentActivityDetail(projection, "run"));
    expect(detail).not.toContain(secret);
    expect(detail).toContain("[REDACTED]");
    expect(
      subagentActivityItems({ revision: 3, runs: [{ ...run, state: "failed" }] })[0]?.status,
    ).toBe("failed");
  });

  effectTest(
    "revokes stale actions on projection changes, token replacement, and disposal",
    function* () {
      const transport = fakeActivityHost();
      const bridge = subagentProjectionBridge();
      bridge.publish({ revision: 1, runs: [view({ id: "run" })] });
      let current = true;
      const act = vi.fn(() => Promise.resolve());
      const dispose = registerSubagentActivity({
        events: transport.events,
        sessionId: "session",
        bridge,
        isCurrent: () => current,
        act,
      });
      transport.events.emit(ACTIVITY_HOST, {
        version: 1,
        sessionId: "session",
        hostToken: transport.hostToken,
        available: true,
      });
      const revision = subagentActivityItems(bridge.get(), bridge.getActivityPresentation())[0]!
        .revision;
      const capability = transport.capability()!;
      const invoke = (id: string, action: string, itemRevision: string, signal: AbortSignal) =>
        Promise.resolve<unknown>(capability.invoke!(id, action, itemRevision, signal));
      const getDetail = (id: string, itemRevision: string, signal: AbortSignal) =>
        Promise.resolve<unknown>(capability.getDetail!(id, itemRevision, signal));
      const signal = new AbortController().signal;
      const refused = () =>
        step(() => expect(invoke("run", "stop", revision, signal)).rejects.toThrow());
      yield* step(() =>
        getDetail("run", revision, signal).then((detail) =>
          expect(JSON.stringify(detail)).toContain("Review auth"),
        ),
      );
      const cancelled = new AbortController();
      const pending = invoke("run", "stop", revision, cancelled.signal);
      cancelled.abort();
      yield* step(() => expect(pending).rejects.toThrow());
      yield* step(() => expect(getDetail("run", revision, cancelled.signal)).rejects.toThrow());
      yield* step(() => invoke("run", "stop", revision, signal));
      expect(act).toHaveBeenCalledWith(
        "run",
        { action: "stop" },
        signal,
        captureSubagentControlExpectation(view({ id: "run" })),
      );
      bridge.publish({ revision: 2, runs: [view({ id: "run", state: "completed" })] });
      expect(transport.get()?.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "run", status: "done" })]),
      );
      yield* refused();
      bridge.publish({ revision: 1, runs: [view({ id: "run" })] });
      current = false;
      yield* refused();
      current = true;
      dispose();
      yield* refused();
      yield* step(() => expect(getDetail("run", revision, signal)).rejects.toThrow());
      expect(act).toHaveBeenCalledTimes(1);
      expect(transport.get()?.operation).toBe("revoke");
      expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    },
  );

  effectTest("sends reply and message actions through the shared send path", function* () {
    const selected = view({ id: "selected", state: "waiting_for_parent", question });
    const expected = captureSubagentControlExpectation(selected);
    const send = vi.fn((id: string) =>
      Effect.succeed({
        messageId: "message-1",
        to: id,
        name: id,
        disposition: "answered" as const,
      }),
    );
    const service = subagentServiceDouble({ send });
    const act = (id: string, action: "reply" | "message", input: string) =>
      runSubagentActivityAction(service, id, { action, input }, expected).pipe(Effect.orDie);
    yield* act("selected", "reply", "Yes");
    yield* act("selected", "message", "Go");
    expect(send.mock.calls).toEqual([
      ["selected", "Yes", expected],
      ["selected", "Go", expected],
    ]);
  });
});
