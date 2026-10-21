import { describe, expect, it } from "@effect/vitest";
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
import { view } from "./fixtures/run-view.ts";

const question = { requestId: "q", message: "Question" };

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
  const item = subagentActivityItems(bridge.get(), bridge.getActivityPresentation()).find(
    (candidate) => candidate.id === "selected",
  )!;
  const invoke = (action: string, signal: AbortSignal) =>
    transport.capability()!.invoke!(item.id, action, item.revision, signal);
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
      expect(item.actions?.map((action) => action.id)).toContain("stop");
      const detail = subagentActivityDetail(bridge.get(), run.id)!;
      expect(detail).toContain("Cleanup detail sentinel");
      expect(detail).toContain("Accepted work report sentinel");
      const signal = new AbortController().signal;
      yield* step(() => invoke("stop", signal));
      expect(act).toHaveBeenCalledWith(
        run.id,
        "stop",
        signal,
        undefined,
        captureSubagentControlExpectation(run),
      );
      const manual = {
        ...run,
        cleanup: { disposition: "quarantined" as const, recovery: "manual" as const },
      };
      bridge.publish({ revision: 2, runs: [manual] });
      expect(
        subagentActivityItems(bridge.get())[0]!.actions?.map((action) => action.id),
      ).not.toContain("stop");
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
      expect(done.actions?.map((action) => action.id)).not.toContain("stop");
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
    yield* step(() => transport.capability()!.invoke!(item.id, "stop", item.revision, signal));
    expect(act).toHaveBeenCalledWith(
      "selected",
      "stop",
      signal,
      undefined,
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
    "policy",
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
      else if (changed.startsWith("host-")) {
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
              ...(changed === "policy" && {
                capabilities: selected.capabilities.filter(
                  (capability) => capability !== "parent-contact",
                ),
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
    expect(subagentActivityDetail(projection, "run")).not.toContain(secret);
    expect(subagentActivityDetail(projection, "run")).toContain("[REDACTED]");
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
      const invoke = transport.capability()!.invoke!;
      const getDetail = transport.capability()!.getDetail!;
      const signal = new AbortController().signal;
      const refused = () =>
        step(() => expect(invoke("run", "stop", revision, signal)).rejects.toThrow());
      yield* step(() =>
        expect(getDetail("run", revision, signal)).resolves.toContain("Review auth"),
      );
      const cancelled = new AbortController();
      const pending = invoke("run", "stop", revision, cancelled.signal);
      cancelled.abort();
      yield* step(() => expect(pending).rejects.toThrow());
      yield* step(() => expect(getDetail("run", revision, cancelled.signal)).rejects.toThrow());
      yield* step(() => invoke("run", "stop", revision, signal));
      expect(act).toHaveBeenCalledWith(
        "run",
        "stop",
        signal,
        undefined,
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
        disposition: id === "pending" ? ("guided" as const) : ("answered" as const),
        confirmed: id !== "pending",
      }),
    );
    const service = subagentServiceDouble({ send });
    const pendingNotices = vi.fn();
    const act = (id: string, action: "reply" | "message", input: string) =>
      runSubagentActivityAction(service, id, action, input, expected, pendingNotices).pipe(
        Effect.orDie,
      );
    yield* act("selected", "reply", "Yes");
    yield* act("selected", "message", "Go");
    expect(send.mock.calls).toEqual([
      ["selected", "Yes", expected],
      ["selected", "Go", expected],
    ]);
    expect(pendingNotices).not.toHaveBeenCalled();
    yield* act("pending", "message", "Go");
    expect(pendingNotices).toHaveBeenCalledTimes(1);
  });
});
