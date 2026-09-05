import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import {
  ACTIVITY_DISCOVER,
  ACTIVITY_EVENT,
  ACTIVITY_HOST,
  type ActivityEnvelope,
  type ActivityEvents,
} from "pi-cosmic-ui/activity";
import {
  registerSubagentActivity,
  subagentActivityItems,
  subagentActivityDetail,
} from "../src/boundary/host-activity.ts";
import { makeSubagentProjectionBridge } from "../src/boundary/host-ui.ts";
import { view } from "./tools/fixtures/tool-harness.ts";

function host() {
  const hostToken = {};
  const listeners = new Map<string, Set<Parameters<ActivityEvents["on"]>[1]>>();
  let envelope: ActivityEnvelope | undefined;
  let capability: ActivityEnvelope | undefined;
  const events: ActivityEvents = {
    on: (name, handler) => {
      const handlers = listeners.get(name) ?? new Set();
      handlers.add(handler);
      listeners.set(name, handlers);
      return () => {
        handlers.delete(handler);
      };
    },
    emit: (name, value) => {
      for (const handler of listeners.get(name) ?? []) handler(value);
    },
  };
  events.on(ACTIVITY_DISCOVER, () =>
    events.emit(ACTIVITY_HOST, { version: 1, sessionId: "session", hostToken, available: true }),
  );
  events.on(ACTIVITY_EVENT, (value) => {
    // SAFETY: The fixture captures only envelopes emitted by the owned protocol adapter.
    envelope = value as ActivityEnvelope;
    if (envelope.operation === "register") {
      capability = envelope;
      envelope.acknowledge?.(true);
    }
  });
  return { events, hostToken, get: () => envelope, capability: () => capability };
}

describe("subagent activity provider", () => {
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
    expect(items[0]?.actions).toEqual([]);
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

  it("keeps blocking states visible without turning parent orchestration into user questions", () => {
    const items = subagentActivityItems({
      revision: 1,
      runs: [
        view({
          id: "waiting",
          state: "waiting_for_parent",
          question: { requestId: "q", message: "parent only", createdAt: 1 },
        }),
        view({ id: "paused", state: "paused", writeAdmissionPaused: true }),
        view({ id: "stopping", state: "stopping" }),
      ],
    });
    expect(items.map((item) => item.kind)).toEqual(["agent", "agent", "agent"]);
    expect(
      items.filter((item) => item.status === "needs-input" || item.status === "blocked"),
    ).toHaveLength(2);
    expect(
      items.find((item) => item.id === "paused")?.actions?.some((action) => action.id === "resume"),
    ).toBe(false);
    expect(JSON.stringify(items)).not.toContain("parent only");
  });

  it("publishes launch leases as metadata before rows exist and releases overlapping requests independently", () => {
    const transport = host();
    const bridge = makeSubagentProjectionBridge();
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
    const bridge = makeSubagentProjectionBridge();
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
    const revision = items()[0]!.revision;
    overlap();
    expect(
      items()
        .filter((item) => item.awaited)
        .map((item) => item.id),
    ).toEqual(["run"]);
    expect(items()[0]!.revision).not.toBe(revision);
    stopAwait();
    expect(items().some((item) => item.awaited)).toBe(false);
    expect(items()).toHaveLength(3);
    bridge.clear();
  });

  it.effect("revokes stale actions on projection changes, token replacement, and disposal", () =>
    Effect.gen(function* () {
      const transport = host();
      const bridge = makeSubagentProjectionBridge();
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
      // publish follows register, so capture the capability through a fresh discovery handshake.
      transport.events.emit(ACTIVITY_HOST, {
        version: 1,
        sessionId: "session",
        hostToken: transport.hostToken,
        available: true,
      });
      const revision = subagentActivityItems(bridge.get(), bridge.getActivityPresentation())[0]!
        .revision;
      const invoke = transport.capability()?.invoke;
      const getDetail = transport.capability()?.getDetail;
      const signal = yield* Effect.abortSignal;
      expect(invoke).toBeDefined();
      yield* Effect.promise(() =>
        expect(getDetail?.("run", revision, signal)).resolves.toContain("running"),
      );
      const cancelled = new AbortController();
      const pending = invoke!("run", "stop", revision, cancelled.signal);
      cancelled.abort();
      yield* Effect.promise(() => expect(pending).rejects.toThrow());
      yield* Effect.promise(() =>
        expect(getDetail?.("run", revision, cancelled.signal)).rejects.toThrow(),
      );
      yield* Effect.promise(() => invoke!("run", "stop", revision, signal));
      expect(act).toHaveBeenCalledWith("run", "stop", signal);
      bridge.publish({ revision: 2, runs: [view({ id: "run", state: "completed" })] });
      expect(transport.get()?.items).toEqual(
        expect.arrayContaining([expect.objectContaining({ id: "run", status: "done" })]),
      );
      yield* Effect.promise(() =>
        expect(invoke?.("run", "stop", revision, signal)).rejects.toThrow(),
      );
      bridge.publish({ revision: 1, runs: [view({ id: "run" })] });
      current = false;
      yield* Effect.promise(() =>
        expect(invoke?.("run", "stop", revision, signal)).rejects.toThrow(),
      );
      current = true;
      dispose();
      yield* Effect.promise(() =>
        expect(invoke?.("run", "stop", revision, signal)).rejects.toThrow(),
      );
      yield* Effect.promise(() => expect(getDetail?.("run", revision, signal)).rejects.toThrow());
      expect(act).toHaveBeenCalledTimes(1);
      expect(transport.get()?.operation).toBe("revoke");
      expect(bridge.bindToolPresentation().isLiveHierarchyAvailable()).toBe(false);
    }),
  );
});
