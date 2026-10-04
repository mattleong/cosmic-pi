import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { ACTIVITY_HOST, ACTIVITY_LIMITS, ActivitySnapshotSchema } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
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

describe("background task activity provider", () => {
  it.effect("clears only finished producer records and cannot reuse a cleared action", () =>
    Effect.gen(function* () {
      const transport = fakeActivityHost();
      const bridge = makeProjectionBridge();
      bridge.publish({
        tasks: [task, { ...task, id: "finished", state: "exited", exitCode: 0, endedAt: 2 }],
      });
      const clear = vi.fn(() => {
        bridge.publish({ tasks: bridge.get().tasks.filter((entry) => entry.state === "running") });
        return Promise.resolve();
      });
      const stop = vi.fn(() => Promise.resolve());
      const dispose = registerBackgroundTaskActivity({
        events: transport.events,
        sessionId: "session",
        bridge,
        isCurrent: () => true,
        stop,
        clear,
      });
      const finished = backgroundTaskActivityItems(bridge.get()).find(
        (item) => item.id === "finished",
      )!;
      expect(finished.actions?.find((action) => action.id === "clear")?.confirmation).toBeTruthy();
      const invoke = transport.capability()!.invoke!;
      const signal = new AbortController().signal;
      yield* Effect.promise(() => invoke("finished", "clear", finished.revision, signal));
      expect(bridge.get().tasks).toEqual([task]);
      yield* Effect.promise(() =>
        expect(invoke("finished", "clear", finished.revision, signal)).rejects.toThrow(),
      );
      expect(clear).toHaveBeenCalledTimes(1);
      expect(stop).not.toHaveBeenCalled();
      dispose();
    }),
  );

  it("retains technical task evidence alongside the selected bounded log tail", () => {
    const detail = backgroundTaskActivityDetail(
      {
        tasks: [
          {
            ...task,
            pid: 17,
            state: "failed",
            exitCode: 2,
            signal: "SIGTERM",
            droppedLogBytes: 42,
          },
        ],
      },
      task.id,
    )!;
    for (const evidence of ["17", "SIGTERM", "42", "private output", task.cwd])
      expect(detail).toContain(evidence);
  });

  it("keeps every active task in a snapshot within the protocol limit", () => {
    // Retained finished tasks plus running ones can exceed one snapshot; listed oldest first.
    const finished = Array.from({ length: 540 }, (_, index) => ({
      ...task,
      id: `finished-${index}`,
      state: "exited" as const,
      exitCode: 0,
      startedAt: index,
      endedAt: index + 1,
    }));
    const running = Array.from({ length: 24 }, (_, index) => ({
      ...task,
      id: `running-${index}`,
      startedAt: index,
    }));
    const transport = fakeActivityHost();
    const bridge = makeProjectionBridge();
    bridge.publish({ tasks: [...finished, ...running] });
    const dispose = registerBackgroundTaskActivity({
      events: transport.events,
      sessionId: "session",
      bridge,
      isCurrent: () => true,
      stop: () => Promise.resolve(),
    });
    // The host rejects an oversized snapshot outright, which would hide every row.
    const published = Schema.decodeUnknownSync(ActivitySnapshotSchema)(transport.get()?.items);
    expect(published).toHaveLength(ACTIVITY_LIMITS.items);
    const ids = new Set(published.map((item) => item.id));
    for (const entry of running) expect(ids.has(entry.id)).toBe(true);
    const dropped = finished.filter((entry) => !ids.has(entry.id));
    expect(dropped.map((entry) => entry.id)).toEqual(
      finished.slice(0, dropped.length).map((entry) => entry.id),
    );
    dispose();
  });

  it("projects wait ownership without changing task status", () => {
    for (const awaited of [true, false]) {
      const items = backgroundTaskActivityItems({ tasks: [{ ...task, awaited }] });
      expect(items[0]?.awaited).toBe(awaited);
      expect(items[0]?.status).toBe("running");
    }
  });

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
        const transport = fakeActivityHost();
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
