// Host-callback thenables are deliberately exercised as native Promises at this Pi boundary.
// @effect-diagnostics effect/asyncFunction:off
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  CODE_MODE_PROGRESS_FRAME_INTERVAL_MS,
  makeGuardedToolUpdatePublisher,
  type HostToolUpdateScheduler,
} from "../src/boundary/host-tool-update.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";

const update = (text: string): AgentToolResult<CodeModeToolDetails> => ({
  content: [{ type: "text", text }],
  details: { toolCalls: [] },
});

interface ScheduledTask {
  readonly delayMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

const schedulerHarness = () => {
  const tasks: ScheduledTask[] = [];
  const schedule: HostToolUpdateScheduler = (delayMs, callback) => {
    const task = { delayMs, callback, cancelled: false };
    tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  };
  const run = (index: number): void => {
    const task = tasks[index];
    if (task !== undefined && !task.cancelled) task.callback();
  };
  return { tasks, schedule, run };
};

const textOf = (result: AgentToolResult<CodeModeToolDetails>): string =>
  result.content
    .filter((block) => block.type === "text")
    .map((block) => block.text)
    .join("\n");

describe("guarded Code Mode progress publisher", () => {
  it("delivers the leading snapshot immediately and coalesces to the latest frame snapshot", () => {
    let now = 100;
    const scheduled = schedulerHarness();
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) => delivered.push(textOf(partial)),
      () => true,
      { now: () => now, schedule: scheduled.schedule },
    );

    publisher.publish(update("starting"));
    publisher.publish(update("queued"));
    publisher.publish(update("running"));

    expect(delivered).toEqual(["starting"]);
    expect(scheduled.tasks).toHaveLength(1);
    expect(scheduled.tasks[0]?.delayMs).toBe(CODE_MODE_PROGRESS_FRAME_INTERVAL_MS);

    now += CODE_MODE_PROGRESS_FRAME_INTERVAL_MS;
    scheduled.run(0);
    expect(delivered).toEqual(["starting", "running"]);
  });

  it("lets a semantic leading edge join Pi's next frame and supersede pending status churn", () => {
    const scheduled = schedulerHarness();
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) => delivered.push(textOf(partial)),
      () => true,
      { now: () => 0, schedule: scheduled.schedule },
    );

    publisher.publish(update("starting"));
    publisher.publish(update("stale status"));
    publisher.publishNow(update("first row running"));

    expect(delivered).toEqual(["starting", "first row running"]);
    expect(scheduled.tasks[0]?.cancelled).toBe(true);
    scheduled.run(0);
    expect(delivered).toEqual(["starting", "first row running"]);
  });

  it("flushes the latest pending snapshot on settlement and cancels its frame timer", () => {
    let now = 0;
    const scheduled = schedulerHarness();
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) => delivered.push(textOf(partial)),
      () => true,
      { now: () => now, schedule: scheduled.schedule },
    );

    publisher.publish(update("starting"));
    publisher.publish(update("completed"));
    publisher.settle();
    publisher.settle();
    publisher.publish(update("too late"));

    expect(delivered).toEqual(["starting", "completed"]);
    expect(scheduled.tasks[0]?.cancelled).toBe(true);
    now += CODE_MODE_PROGRESS_FRAME_INTERVAL_MS;
    scheduled.run(0);
    expect(delivered).toEqual(["starting", "completed"]);
  });

  it("delivers a new snapshot immediately after a complete frame has elapsed", () => {
    let now = 0;
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) => delivered.push(textOf(partial)),
      () => true,
      { now: () => now, schedule: schedulerHarness().schedule },
    );

    publisher.publish(update("starting"));
    now = CODE_MODE_PROGRESS_FRAME_INTERVAL_MS;
    publisher.publish(update("running"));

    expect(delivered).toEqual(["starting", "running"]);
  });

  it("contains hostile callbacks and stops when the owning session is no longer current", async () => {
    let current = true;
    const callback = vi.fn(() => Promise.reject(new Error("hostile rejection")) as never);
    const publisher = makeGuardedToolUpdatePublisher(callback, () => current, {
      now: () => 0,
      schedule: schedulerHarness().schedule,
    });

    publisher.publish(update("starting"));
    current = false;
    publisher.publish(update("stale"));
    publisher.settle();

    expect(callback).toHaveBeenCalledTimes(1);
    await Promise.resolve();
  });

  it("falls back to immediate delivery when frame scheduling fails", () => {
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) => delivered.push(textOf(partial)),
      () => true,
      {
        now: () => 0,
        schedule: () => {
          throw new Error("scheduler unavailable");
        },
      },
    );

    publisher.publish(update("starting"));
    publisher.publish(update("running"));
    expect(delivered).toEqual(["starting", "running"]);
  });
});
