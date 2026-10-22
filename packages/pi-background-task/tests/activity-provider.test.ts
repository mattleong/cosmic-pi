import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { ACTIVITY_HOST, ACTIVITY_LIMITS, ActivitySnapshotSchema } from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import {
  backgroundTaskActivityDetail,
  backgroundTaskActivityItems,
  registerBackgroundTaskActivity,
} from "../src/boundary/host-activity.ts";
import { taskProjectionBridge } from "../src/boundary/host-ui.ts";
import type { BackgroundTaskView } from "../src/task/model.ts";
import { TerminalTextNormalizer } from "../src/task/terminal-text.ts";

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
  it("keeps every active task in a snapshot within the protocol limit", () => {
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
    const bridge = taskProjectionBridge();
    bridge.publish({ tasks: [...finished, ...running] });
    const dispose = registerBackgroundTaskActivity({
      events: transport.events,
      sessionId: "session",
      bridge,
      isCurrent: () => true,
      stop: () => Promise.resolve(),
      clear: () => Promise.resolve(),
    });
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
          logs: [{ ...task.logs[0]!, text: `server ready\nusing Bearer ${secret}\n` }],
        },
      ],
    };
    expect(JSON.stringify(backgroundTaskActivityItems(projection))).not.toContain(secret);
    const detail = backgroundTaskActivityDetail(projection, "task") ?? "";
    expect(detail).not.toContain(secret);
    expect(detail).toContain("server ready\nusing Bearer");
  });

  it("shows captured output as plain text, without escape remnants, however it is trimmed", () => {
    const normalizer = new TerminalTextNormalizer();
    const raw = [
      "\u001b]0;evil-title\u0007\u001b]8;;https://x.example/\u001b\\link\u001b]8;;\u001b\\\n",
      `\u001b[31m${"r".repeat(11_991)}\u001b[0m\n`,
    ];
    const logs = raw.map((text, index) => ({
      cursor: index + 1,
      stream: "stdout" as const,
      text: normalizer.write(text),
      timestamp: index + 1,
      bytes: 0,
    }));
    const detail = backgroundTaskActivityDetail({ tasks: [{ ...task, logs }] }, "task") ?? "";
    for (const remnant of ["evil-title", "]0;", "8;;", "x.example", "[31m", "[0m", "\u001b"])
      expect(detail).not.toContain(remnant);
    expect(detail).toContain("r".repeat(100));
  });

  it.effect(
    "checks current revision and session before authoritative stop and revokes on disposal",
    () =>
      Effect.gen(function* () {
        const transport = fakeActivityHost();
        const bridge = taskProjectionBridge();
        bridge.publish({ tasks: [task] });
        let current = true;
        const stop = vi.fn(() => Promise.resolve());
        const dispose = registerBackgroundTaskActivity({
          events: transport.events,
          sessionId: "session",
          bridge,
          isCurrent: () => current,
          stop,
          clear: () => Promise.resolve(),
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
        const cancellation = yield* Scope.make();
        const cancelled = yield* Effect.abortSignal.pipe(Scope.provide(cancellation));
        const pending = invoke!("task", "stop", revision, cancelled);
        yield* Scope.close(cancellation, Exit.void);
        yield* Effect.promise(() => expect(pending).rejects.toThrow());
        yield* Effect.promise(() =>
          expect(getDetail?.("task", revision, cancelled)).rejects.toThrow(),
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
