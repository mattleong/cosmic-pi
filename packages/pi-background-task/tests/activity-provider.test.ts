import { describe, expect, it } from "@effect/vitest";
import { vi } from "vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Str from "effect/String";
import { exitStatusMeaning } from "pi-code-previews";
import {
  ACTIVITY_HOST,
  ACTIVITY_LIMITS,
  ActivitySnapshotSchema,
  type ActivityDetail,
} from "pi-cosmic-ui/activity";
import { fakeActivityHost } from "pi-cosmic-ui/activity/testing";
import {
  backgroundTaskActivityDetail,
  backgroundTaskActivityItems,
  registerBackgroundTaskActivity,
} from "../src/boundary/host-activity.ts";
import { taskProjectionBridge } from "../src/boundary/host-ui.ts";
import type { BackgroundTaskView } from "../src/task/model.ts";
import { TerminalTextNormalizer } from "../src/task/terminal-text.ts";

const detailText = (detail: ActivityDetail | undefined): string =>
  detail === undefined
    ? ""
    : Arr.join(
        [
          ...Arr.flatMap(detail.sections, (section) => [section.title ?? "", section.body]),
          ...Arr.map(detail.technical ?? [], (field) => `${field.label}: ${field.value}`),
        ],
        "\n",
      );

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
    const ids = new Set(Arr.map(published, (item) => item.id));
    for (const entry of running) expect(ids.has(entry.id)).toBe(true);
    const dropped = Arr.filter(finished, (entry) => !ids.has(entry.id));
    expect(Arr.map(dropped, (entry) => entry.id)).toEqual(
      Arr.map(finished.slice(0, dropped.length), (entry) => entry.id),
    );
    dispose();
  });

  it("publishes root-only metadata with only the latest output line of live work", () => {
    const logs = [
      { ...task.logs[0]!, text: "private output\n" },
      { ...task.logs[0]!, cursor: 2, text: "  tick 18  \n\n" },
    ];
    const items = backgroundTaskActivityItems({ tasks: [{ ...task, logs }] });
    expect(items[0]?.parent).toBeUndefined();
    expect(JSON.stringify(items)).not.toContain("private output");
    expect(items[0]?.status).toBe("running");
    expect(items[0]?.summary).toBe("tick 18");
    const finished = backgroundTaskActivityItems({
      tasks: [{ ...task, logs, state: "exited", exitCode: 0, endedAt: 2 }],
    });
    expect(JSON.stringify(finished)).not.toContain("tick 18");
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
    const detail = detailText(backgroundTaskActivityDetail(projection, "task"));
    expect(detail).not.toContain(secret);
    expect(detail).toContain("server ready\nusing Bearer");
  });

  it("explains how a finished task ended, with its redacted failure cause", () => {
    const secret = "sk-abcdefgh12345678";
    const detail = (ending: Partial<BackgroundTaskView>) =>
      detailText(
        backgroundTaskActivityDetail(
          { tasks: [{ ...task, state: "failed", endedAt: 2, ...ending }] },
          "task",
        ),
      );
    const exited = detail({
      exitCode: 127,
      failureCause: `\u001b]0;evil-title\u0007FAIL auth.test.ts with ${secret}`,
    });
    expect(exited).toContain(exitStatusMeaning(127));
    expect(exited).toContain("FAIL auth.test.ts with");
    for (const hidden of [secret, "evil-title", "\u001b"]) expect(exited).not.toContain(hidden);
    expect(detail({ exitCode: null, signal: "SIGKILL" })).toContain(
      exitStatusMeaning(undefined, "SIGKILL"),
    );
  });

  it("leads a failure with its cause and keeps identity behind the technical disclosure", () => {
    const detail = backgroundTaskActivityDetail(
      {
        tasks: [
          {
            ...task,
            state: "failed",
            endedAt: 2,
            exitCode: 2,
            failureCause: "missing semicolon",
            pid: 4242,
          },
        ],
      },
      "task",
    );
    expect(detail?.sections[0]?.body).toContain("missing semicolon");
    const visible = Arr.join(
      Arr.map(detail?.sections ?? [], (section) => section.body),
      "\n",
    );
    expect(visible).not.toContain("4242");
    expect(JSON.stringify(detail?.technical)).toContain("4242");
  });

  it("shows captured output as plain text, without escape remnants, however it is trimmed", () => {
    const normalizer = new TerminalTextNormalizer();
    const raw = [
      "\u001b]0;evil-title\u0007\u001b]8;;https://x.example/\u001b\\link\u001b]8;;\u001b\\\n",
      `\u001b[31m${Fn.pipe("r", Str.repeat(11_991))}\u001b[0m\n`,
    ];
    const logs = Arr.map(raw, (text, index) => ({
      cursor: index + 1,
      stream: "stdout" as const,
      text: normalizer.write(text),
      timestamp: index + 1,
      bytes: 0,
    }));
    const detail = detailText(backgroundTaskActivityDetail({ tasks: [{ ...task, logs }] }, "task"));
    for (const remnant of ["evil-title", "]0;", "8;;", "x.example", "[31m", "[0m", "\u001b"])
      expect(detail).not.toContain(remnant);
    expect(detail).toContain(Fn.pipe("r", Str.repeat(100)));
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
        // Discovered callbacks are foreign, so their results settle as untrusted values.
        const capability = transport.capability()!;
        const invoke = (id: string, action: string, itemRevision: string, abort: AbortSignal) =>
          Promise.resolve<unknown>(capability.invoke!(id, action, itemRevision, abort));
        const getDetail = (id: string, itemRevision: string, abort: AbortSignal) =>
          Promise.resolve<unknown>(capability.getDetail!(id, itemRevision, abort));
        const signal = yield* Effect.abortSignal;
        const revision = backgroundTaskActivityItems(bridge.get())[0]!.revision;
        yield* Effect.promise(() =>
          getDetail("task", revision, signal).then((detail) =>
            expect(JSON.stringify(detail)).toContain("private output"),
          ),
        );
        const cancellation = yield* Scope.make();
        const cancelled = yield* Effect.abortSignal.pipe(Scope.provide(cancellation));
        const pending = invoke("task", "stop", revision, cancelled);
        yield* Scope.close(cancellation, Exit.void);
        yield* Effect.promise(() => expect(pending).rejects.toThrow());
        yield* Effect.promise(() =>
          expect(getDetail("task", revision, cancelled)).rejects.toThrow(),
        );
        yield* Effect.promise(() => invoke("task", "stop", revision, signal));
        expect(stop).toHaveBeenCalledWith("task", signal);
        bridge.publish({ tasks: [{ ...task, state: "exited" }] });
        yield* Effect.promise(() =>
          expect(invoke("task", "stop", revision, signal)).rejects.toThrow(),
        );
        bridge.publish({ tasks: [task] });
        current = false;
        yield* Effect.promise(() =>
          expect(invoke("task", "stop", revision, signal)).rejects.toThrow(),
        );
        current = true;
        dispose();
        yield* Effect.promise(() =>
          expect(invoke("task", "stop", revision, signal)).rejects.toThrow(),
        );
        yield* Effect.promise(() => expect(getDetail("task", revision, signal)).rejects.toThrow());
        expect(stop).toHaveBeenCalledTimes(1);
        expect(transport.get()?.operation).toBe("revoke");
      }),
  );
});
