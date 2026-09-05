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
  backgroundTaskActivityDetail,
  backgroundTaskActivityItems,
  registerBackgroundTaskActivity,
} from "../src/boundary/host-activity.ts";
import { makeProjectionBridge } from "../src/boundary/host-ui.ts";
import type { BackgroundTaskView } from "../src/task/model.ts";

const task: BackgroundTaskView = {
  id: "task",
  command: "work",
  cwd: "/project",
  state: "running",
  startedAt: 1,
  logCursor: 1,
  droppedLogBytes: 0,
  logs: [{ cursor: 1, stream: "stdout", text: "private output", timestamp: 1, bytes: 14 }],
};

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

describe("background task activity provider", () => {
  it("publishes root-only metadata without logs", () => {
    const items = backgroundTaskActivityItems({ tasks: [task] });
    expect(items[0]?.parent).toBeUndefined();
    expect(JSON.stringify(items)).not.toContain("private output");
    expect(items[0]?.status).toBe("running");
  });

  it("redacts credentials before publishing summaries or selected details", () => {
    const secret = "sk-abcdefgh12345678";
    const projection = {
      tasks: [
        {
          ...task,
          command: `API_KEY=${secret} command`,
          logs: [{ ...task.logs[0]!, text: `Bearer ${secret}` }],
        },
      ],
    };
    expect(JSON.stringify(backgroundTaskActivityItems(projection))).not.toContain(secret);
    expect(backgroundTaskActivityDetail(projection, "task")).not.toContain(secret);
    expect(backgroundTaskActivityDetail(projection, "task")).toContain("[REDACTED]");
  });

  it("materializes bounded logs for only the selected task", () => {
    const projection = {
      tasks: [
        task,
        { ...task, id: "other", logs: [{ ...task.logs[0]!, text: "other private output" }] },
      ],
    };
    expect(backgroundTaskActivityDetail(projection, "task")).toContain("private output");
    expect(backgroundTaskActivityDetail(projection, "task")).not.toContain("other private output");
    expect(backgroundTaskActivityDetail(projection, "missing")).toBeUndefined();
    const huge = { ...task, logs: [{ ...task.logs[0]!, text: "x".repeat(30_000) }] };
    expect(backgroundTaskActivityDetail({ tasks: [huge] }, "task")!.length).toBeLessThanOrEqual(
      16_002,
    );
  });

  it.effect(
    "checks current revision and session before authoritative stop and revokes on disposal",
    () =>
      Effect.gen(function* () {
        const transport = host();
        const bridge = makeProjectionBridge();
        bridge.publish({ tasks: [task] });
        let current = true;
        const stop = vi.fn(() => Promise.resolve());
        const dispose = registerBackgroundTaskActivity({
          events: transport.events,
          sessionId: "session",
          bridge,
          isCurrent: () => current,
          stop,
        });
        transport.events.emit(ACTIVITY_HOST, {
          version: 1,
          sessionId: "session",
          hostToken: transport.hostToken,
          available: true,
        });
        const invoke = transport.capability()?.invoke;
        const getDetail = transport.capability()?.getDetail;
        const signal = yield* Effect.abortSignal;
        const revision = backgroundTaskActivityItems(bridge.get())[0]!.revision;
        yield* Effect.promise(() =>
          expect(getDetail?.("task", revision, signal)).resolves.toContain("private output"),
        );
        const cancelled = new AbortController();
        const pending = invoke!("task", "stop", revision, cancelled.signal);
        cancelled.abort();
        yield* Effect.promise(() => expect(pending).rejects.toThrow());
        yield* Effect.promise(() =>
          expect(getDetail?.("task", revision, cancelled.signal)).rejects.toThrow(),
        );
        yield* Effect.promise(() => invoke!("task", "stop", revision, signal));
        expect(stop).toHaveBeenCalledWith("task", signal);
        bridge.publish({ tasks: [{ ...task, state: "exited" }] });
        yield* Effect.promise(() =>
          expect(invoke?.("task", "stop", revision, signal)).rejects.toThrow(),
        );
        bridge.publish({ tasks: [task] });
        current = false;
        yield* Effect.promise(() =>
          expect(invoke?.("task", "stop", revision, signal)).rejects.toThrow(),
        );
        current = true;
        dispose();
        yield* Effect.promise(() =>
          expect(invoke?.("task", "stop", revision, signal)).rejects.toThrow(),
        );
        yield* Effect.promise(() =>
          expect(getDetail?.("task", revision, signal)).rejects.toThrow(),
        );
        expect(stop).toHaveBeenCalledTimes(1);
        expect(transport.get()?.operation).toBe("revoke");
      }),
  );
});
