import { createEventBus } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import { makeBackgroundTaskCodeModeHost } from "../src/boundary/host-code-mode.ts";
import {
  backgroundTaskCodeModeStartOutputFits,
  projectBackgroundTaskCodeModeOutput,
} from "../src/code-mode/output.ts";
import {
  BACKGROUND_TASK_CODE_MODE_QUERY,
  BACKGROUND_TASK_CODE_MODE_VERSION,
  normalizeBackgroundTaskCodeModeCapability,
  type BackgroundTaskCodeModeCapability,
} from "../src/code-mode/protocol.ts";
import type { BackgroundLogSlice } from "../src/task/model.ts";
import { BackgroundTaskService } from "../src/task/service.ts";
import { backgroundLogLines, type BackgroundTaskCommandResult } from "../src/tools/command.ts";

const snapshot = {
  id: "bg-1",
  command: "node server.js",
  cwd: "/project",
  state: "running" as const,
  pid: 42,
  startedAt: 1,
  logCursor: 0,
  droppedLogBytes: 0,
};

/** The published capability of a host whose runs read `slice` from a fake service. */
const logsCapability = (slice: BackgroundLogSlice): BackgroundTaskCodeModeCapability => {
  const unexpected = () => Effect.die("Unexpected task service call");
  const service = {
    start: unexpected,
    list: unexpected,
    status: unexpected,
    logs: () => Effect.succeed(slice),
    wait: unexpected,
    stop: unexpected,
    stopAll: unexpected,
    clear: unexpected(),
  };
  const events = createEventBus();
  makeBackgroundTaskCodeModeHost(events).activate({
    sessionId: "session-1",
    tokenCurrent: () => true,
    toolActive: () => true,
    sessionCwd: "/project",
    run: (effect) =>
      Effect.runPromise(
        effect.pipe(
          Effect.provideService(BackgroundTaskService, service),
          Effect.provide(Path.layer),
        ),
      ),
  });
  const found: BackgroundTaskCodeModeCapability[] = [];
  events.emit(BACKGROUND_TASK_CODE_MODE_QUERY, {
    version: BACKGROUND_TASK_CODE_MODE_VERSION,
    sessionId: "session-1",
    respond: <Candidate>(candidate: Candidate) => {
      const capability = normalizeBackgroundTaskCodeModeCapability(candidate);
      if (capability) found.push(capability);
    },
  });
  const [capability] = found;
  if (!capability) throw new Error("The Code Mode capability was not published.");
  return capability;
};

describe("Background Tasks Code Mode output projection", () => {
  it("round-trips command results", () => {
    const logs = {
      id: snapshot.id,
      nextCursor: 2,
      earliestAvailableCursor: 1,
      droppedBytes: 0,
      state: snapshot.state,
    };
    const details: BackgroundTaskCommandResult["details"][] = [
      ...(["start", "status", "stop"] as const).map((action) => ({ action, snapshot })),
      ...(["list", "stop_all"] as const).map((action) => ({ action, tasks: [snapshot] })),
      { action: "logs", logs },
      {
        action: "wait",
        wait: {
          id: snapshot.id,
          nextCursor: 2,
          earliestAvailableCursor: 1,
          droppedBytes: 0,
          outcome: "matched",
          snapshot,
          matchCursor: 2,
        },
      },
      { action: "clear", removed: 3 },
      {
        action: "status",
        snapshot: {
          ...snapshot,
          state: "failed",
          endedAt: 2,
          error: "Unable to spawn local process.",
        },
      },
    ];
    for (const item of details) {
      const result = { text: item.action, details: item };
      expect(projectBackgroundTaskCodeModeOutput(result, 4_096)).toEqual({
        _tag: "Accepted",
        output: { text: result.text, ...item },
      });
    }
  });

  it.effect("fits a cut logs result, envelope and escapes included, keeping the newest lines", () =>
    Effect.gen(function* () {
      // Quotes, backslashes, and newlines each take two bytes once encoded.
      const lines = Array.from({ length: 400 }, (_, index) => `say "\\${index + 1}"`);
      const text = `${lines.join("\n")}\n`;
      const logs = { id: "bg-1", nextCursor: 2, earliestAvailableCursor: 1, droppedBytes: 0 };
      const capability = logsCapability({
        ...logs,
        state: "running",
        events: [{ cursor: 1, stream: "stdout", text, timestamp: 1, bytes: text.length }],
      });
      for (const maxOutputBytes of [1_024, 4_096]) {
        const output = yield* Effect.promise((signal) =>
          capability.execute("call-1", { action: "logs", id: "bg-1" }, signal, maxOutputBytes),
        );
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown))(output);
        expect(Buffer.byteLength(encoded)).toBeLessThanOrEqual(maxOutputBytes);
        expect(output.action).toBe("logs");
        const kept = backgroundLogLines(output.text, logs);
        expect(kept.length).toBeGreaterThan(0);
        expect(kept).toEqual(lines.slice(-kept.length));
      }
    }),
  );

  it("refuses output exceeding the current allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "No background tasks.",
      details: { action: "list", tasks: [] },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 0)).toEqual({ _tag: "Refused" });
    expect(projectBackgroundTaskCodeModeOutput(result, 128)).toEqual({
      _tag: "Accepted",
      output: { action: "list", text: "No background tasks.", tasks: [] },
    });
  });

  it("measures only what it returns, never detail-only cause spans or applied waits", () => {
    const failed = { ...snapshot, state: "failed" as const, endedAt: 2, exitCode: 1 };
    const text = "bg-1 failed\n  cause: Error: boom";
    const causes = [{ id: failed.id, start: 21, end: 32 }];
    const waitMember = { id: failed.id, outcome: "completed" as const, snapshot: failed };
    const cases: ReadonlyArray<readonly [BackgroundTaskCommandResult, object]> = [
      [
        { text, details: { action: "status", snapshot: failed, causes } },
        { action: "status", text, snapshot: failed },
      ],
      [
        { text, details: { action: "list", tasks: [failed], causes } },
        { action: "list", text, tasks: [failed] },
      ],
      [
        {
          text,
          details: {
            action: "wait",
            wait: { ...waitMember, nextCursor: 1, earliestAvailableCursor: 1, droppedBytes: 0 },
            appliedWaitSeconds: 30,
            causes,
          },
        },
        {
          action: "wait",
          text,
          wait: { ...waitMember, nextCursor: 1, earliestAvailableCursor: 1, droppedBytes: 0 },
        },
      ],
    ];
    for (const [result, returned] of cases) {
      const exactBytes = Buffer.byteLength(JSON.stringify(returned));
      expect(projectBackgroundTaskCodeModeOutput(result, exactBytes)).toEqual({
        _tag: "Accepted",
        output: returned,
      });
      expect(projectBackgroundTaskCodeModeOutput(result, exactBytes - 1)).toEqual({
        _tag: "Refused",
      });
    }
  });

  it("bounds successful starts without reserving impossible process-exit error text", () => {
    const request = {
      command: "node server.js",
      cwd: "/project",
      name: "server",
    };
    expect(backgroundTaskCodeModeStartOutputFits(request, 0, 0)).toBe(false);
    expect(backgroundTaskCodeModeStartOutputFits(request, 4_096, 2_048)).toBe(true);
    expect(
      backgroundTaskCodeModeStartOutputFits(
        { ...request, cwd: "x".repeat(1_025) },
        1_000_000,
        1_000_000,
      ),
    ).toBe(false);
  });

  it("returns frozen detached snapshots without undeclared producer fields", () => {
    // The in-memory failure cause never enters the frozen Code Mode contract.
    const producerSnapshot = { ...snapshot, internalOnly: "remove me", failureCause: "FAIL x" };
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: { action: "list", tasks: [producerSnapshot] },
    };
    const projection = projectBackgroundTaskCodeModeOutput(result, 4_096);
    expect(projection._tag).toBe("Accepted");
    if (projection._tag !== "Accepted" || projection.output.action !== "list") return;
    expect(projection.output.tasks).toEqual([snapshot]);
    expect(projection.output.tasks[0]).not.toHaveProperty("internalOnly");
    expect(projection.output.tasks[0]).not.toHaveProperty("failureCause");
    expect(projection.output.tasks[0]).not.toBe(producerSnapshot);
    expect(Object.isFrozen(producerSnapshot)).toBe(false);
    expect(Object.isFrozen(projection.output.tasks[0])).toBe(true);
    expect(Object.isFrozen(projection.output.tasks)).toBe(true);
    expect(Object.isFrozen(projection.output)).toBe(true);
  });

  it("counts lone surrogates as JSON escapes against the allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "\ud800".repeat(1_000) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 4_000)).toEqual({ _tag: "Refused" });
  });

  it("refuses oversized snapshot fields even with a sufficient byte allowance", () => {
    const result: BackgroundTaskCommandResult = {
      text: "bg-1 running",
      details: {
        action: "status",
        snapshot: { ...snapshot, command: "x".repeat(2_049) },
      },
    };
    expect(projectBackgroundTaskCodeModeOutput(result, 1_000_000)).toEqual({ _tag: "Refused" });
  });
});
