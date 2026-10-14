import * as Match from "effect/Match";
import { describe, expect, it } from "@effect/vitest";
import { effectTest, step } from "./support/effect-test.ts";
import { assert, vi } from "vitest";
import { ACTIVITY_HOST } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import { deferredPromise } from "pi-cosmic-core/testing";
import { captureSubagentControlExpectation, type SubagentRunView } from "../src/run/model.ts";
import { registerSubagentActivity } from "../src/boundary/host-activity.ts";
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

const runActionIds = (patch: Partial<SubagentRunView>) =>
  subagentActivityItems({ revision: 1, runs: [view(patch)] })[0]!.actions!.map(
    (action) => action.id,
  );

describe("subagent activity provider", () => {
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

  it("preserves the fleet action matrix without enabling claims or unresolved steering", () => {
    expect(runActionIds({ state: "completed" })).toEqual(
      expect.arrayContaining(["resume", "rename"]),
    );
    expect(runActionIds({ state: "waiting_for_parent", question })).toContain("reply");
    expect(runActionIds({ state: "waiting_for_parent" })).not.toContain("reply");
    expect(runActionIds({ state: "stopping" })).toContain("stop");
    for (const steeringDelivery of ["pending", "unresolved"] as const) {
      const offered = runActionIds({ state: "running", steeringDelivery });
      expect(offered).not.toContain("message");
      expect(offered).not.toContain("interrupt");
      expect(offered).toContain("stop");
    }
    expect(runActionIds({ state: "paused", writeAdmissionPaused: true })).not.toContain("resume");
    expect(runActionIds({ state: "running", capabilities: [] })).toEqual(["stop"]);
  });

  for (const action of ["message", "reply", "rename", "resume"] as const) {
    effectTest(
      `applies ${action} after input despite unrelated progress, with captured user text`,
      function* () {
        const selected = view({
          id: "selected",
          state: Match.value(action).pipe(
            Match.when("reply", () => "waiting_for_parent" as const),
            Match.when("resume", () => "paused" as const),
            Match.orElse(() => "running" as const),
          ),
          ...(action === "reply" && { question }),
        });
        const { bridge, pending, admitted, act, dispose, invoke } = promptedProvider([
          selected,
          view({ id: "other" }),
        ]);
        const signal = new AbortController().signal;
        const call = invoke(action, signal);
        yield* step(() => admitted.promise);
        bridge.publish({
          revision: 2,
          runs: [{ ...selected, progress: "Progress" }, view({ id: "other", state: "completed" })],
        });
        pending.resolve(action === "resume" ? "" : " user text ");
        yield* step(() => call);
        expect(act).toHaveBeenCalledWith(
          "selected",
          action,
          signal,
          action === "resume" ? undefined : "user text",
          captureSubagentControlExpectation(selected),
        );
        dispose();
      },
    );
  }

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
              ...(changed === "policy" && { writeAdmissionPaused: true }),
            },
          ],
        });
      pending.resolve("reply text");
      yield* step(() => expect(call).rejects.toThrow());
      expect(act).not.toHaveBeenCalled();
      dispose();
    });
  }

  it("projects the selected profile independently of the run name or hierarchy", () => {
    const items = subagentActivityItems({
      revision: 1,
      runs: [
        view({ id: "owner", name: "Implementation", profile: "worker" }),
        view({ id: "child", name: "Review", profile: "scout", parentRunId: "owner", depth: 2 }),
        view({ id: "legacy", name: "Scout", profile: undefined }),
      ],
    });
    expect(items.map((item) => item.profile)).toEqual(["worker", "scout", undefined]);
    expect(items.map((item) => item.title)).toEqual(["Implementation", "Review", "Scout"]);
  });
  it("publishes the selected host and model route with effort and fast mode", () => {
    const items = subagentActivityItems({
      revision: 1,
      runs: [
        view({
          host: "local",
          runtime: "pi",
          model: "provider/model",
          effort: "high",
          openaiFastMode: true,
        }),
      ],
    });
    expect(items[0]?.route).toContain("local/pi");
    expect(items[0]?.route).toContain("provider/model:high");
  });
  it("keeps active descendants below completed ancestors without inventing missing parents", () => {
    const items = subagentActivityItems({
      revision: 4,
      runs: [
        view({ id: "child", parentRunId: "parent", depth: 2 }),
        view({ id: "parent", parentRunId: "root", state: "completed" }),
        view({ id: "old", state: "completed" }),
        view({ id: "outside", parentRunId: "hidden", depth: 3 }),
      ],
    });
    expect(items.map((item) => item.id)).toEqual(["parent", "child", "old"]);
    expect(items[1]?.parent).toEqual({ providerId: "pi-subagents", itemId: "parent" });
    expect(items[0]?.status).toBe("done");
    expect(items[0]?.actions?.map((action) => action.id)).not.toContain("stop");
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
    expect(subagentActivityDetail(projection, "run")).not.toContain(secret);
    expect(subagentActivityDetail(projection, "run")).toContain("[REDACTED]");
    expect(
      subagentActivityItems({ revision: 3, runs: [{ ...run, state: "failed" }] })[0]?.status,
    ).toBe("failed");
  });

  it("distinguishes claim peers, containment, review and recovery without enabling unsafe actions", () => {
    const privateQuestion = { requestId: "q", message: "private parent question" };
    const runs = [
      view({ id: "question", state: "waiting_for_parent", question: privateQuestion }),
      view({ id: "missing", state: "waiting_for_parent" }),
      view({ id: "paused", state: "paused", capabilities: ["resume"] }),
      view({ id: "peer", state: "running", writeAdmissionPaused: true }),
      view({
        id: "offender",
        state: "paused",
        writeAdmissionPaused: true,
        writeViolationOffender: true,
        capabilities: ["resume"],
      }),
      view({
        id: "containment",
        state: "waiting_for_parent",
        question: privateQuestion,
        writeAdmissionPaused: true,
        writeViolationOffender: true,
      }),
      view({
        id: "terminal",
        state: "failed",
        writeAdmissionPaused: true,
        writeViolationOffender: true,
        capabilities: ["resume"],
      }),
      view({ id: "admission-paused", state: "paused", writeAdmissionPaused: true }),
      view({ id: "stopping", state: "stopping" }),
    ];
    const items = subagentActivityItems({ revision: 1, runs });
    expect(
      items.map(({ status, inputTarget, blockedReason }) => [status, inputTarget, blockedReason]),
    ).toEqual([
      ["needs-input", "parent", undefined],
      ["blocked", undefined, "parent-review"],
      ["blocked", undefined, "parent-review"],
      ["blocked", undefined, "file-access"],
      ["blocked", undefined, "file-access-review"],
      ["blocked", undefined, "write-containment"],
      ["blocked", undefined, "file-access-review"],
      ["blocked", undefined, "file-access"],
      ["stopping", undefined, undefined],
    ]);
    expect(
      items
        .filter((item) => item.actions?.some((action) => action.id === "resume"))
        .map((item) => item.id),
    ).toEqual(["paused"]);
    expect(JSON.stringify(items)).not.toContain(privateQuestion.message);
    const recovered = subagentActivityItems({
      revision: 2,
      runs: runs.map((run) =>
        Object.assign({}, run, {
          state: "running" as const,
          question: undefined,
          writeAdmissionPaused: false,
          writeViolationOffender: false,
        }),
      ),
    });
    expect(
      recovered.every(
        (item) =>
          item.status === "running" &&
          item.inputTarget === undefined &&
          item.blockedReason === undefined,
      ),
    ).toBe(true);
  });

  it("publishes launch leases as metadata before rows exist and releases overlapping requests independently", () => {
    const transport = fakeActivityHost();
    const bridge = subagentProjectionBridge();
    const dispose = registerSubagentActivity({
      events: transport.events,
      sessionId: "session",
      bridge,
      isCurrent: () => true,
      act: () => Promise.resolve(),
    });
    const presentation = bridge.bindToolPresentation();
    const first = presentation.beginStart(2);
    expect(transport.get()?.starting).toBe(2);
    expect(transport.get()?.items).toEqual([]);
    const second = presentation.beginStart(1);
    expect(transport.get()?.starting).toBe(3);
    bridge.publish({ revision: 1, runs: [view({ id: "run", state: "starting" })] });
    expect(transport.get()?.starting).toBe(3);
    expect(transport.get()?.items).toEqual([expect.objectContaining({ id: "run" })]);
    first();
    first();
    expect(transport.get()?.starting).toBe(1);
    second();
    expect(transport.get()?.starting).toBe(0);
    const oldRelease = presentation.beginStart(2);
    bridge.clear();
    const fresh = bridge.bindToolPresentation();
    const release = fresh.beginStart(1);
    oldRelease();
    presentation.beginStart(5)();
    expect(transport.get()?.starting).toBe(1);
    release();
    dispose();
  });

  it("marks exact await targets without adding rows or implicitly marking descendants", () => {
    const bridge = subagentProjectionBridge();
    bridge.publish({
      revision: 1,
      runs: [
        view({ id: "run" }),
        view({ id: "child", parentRunId: "run", depth: 2 }),
        view({ id: "other" }),
      ],
    });
    const presentation = bridge.bindToolPresentation();
    const stopStart = presentation.beginStart(2);
    const stopAwait = presentation.beginAwait(["run"], "all_finished");
    const overlap = presentation.beginAwait(["run", "child"], "all_finished");
    const items = () => subagentActivityItems(bridge.get(), bridge.getActivityPresentation());
    expect(items()).toHaveLength(3);
    stopStart();
    expect(items().map((item) => item.id)).toEqual(["run", "child", "other"]);
    expect(
      items()
        .filter((item) => item.awaited)
        .map((item) => item.id),
    ).toEqual(["run", "child"]);
    const revisions = () => items().map((item) => item.revision);
    const [run, child, other] = revisions();
    assert.isDefined(child);
    overlap();
    expect(
      items()
        .filter((item) => item.awaited)
        .map((item) => item.id),
    ).toEqual(["run"]);
    expect(revisions()).toEqual([run, expect.not.stringMatching(`^${child}$`), other]);
    stopAwait();
    expect(items().some((item) => item.awaited)).toBe(false);
    expect(items()).toHaveLength(3);
    bridge.clear();
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
});
