import { describe, expect, it, vi } from "vitest";
import {
  makeGuardedToolUpdatePublisher,
  type HostToolUpdateScheduler,
} from "../src/boundary/host-tool-update.ts";
import type { CodeModeToolDetails } from "../src/tools/format.ts";

const update = (text: string) => ({
  content: [{ type: "text" as const, text }],
  details: { toolCalls: [] } satisfies CodeModeToolDetails,
});

describe("guarded host tool updates", () => {
  it("coalesces a frame and flushes its latest snapshot once at settlement", () => {
    let now = 0;
    const callbacks: Array<() => void> = [];
    const cancellations: Array<ReturnType<typeof vi.fn>> = [];
    const schedule: HostToolUpdateScheduler = (_delay, callback) => {
      const cancel = vi.fn();
      callbacks.push(callback);
      cancellations.push(cancel);
      return cancel;
    };
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) =>
        delivered.push(partial.content[0]?.type === "text" ? partial.content[0].text : ""),
      () => true,
      { schedule, now: () => now },
    );

    publisher.publish(update("leading"));
    now = 1;
    publisher.publish(update("older"));
    publisher.publish(update("latest"));
    expect(callbacks).toHaveLength(1);

    publisher.settle();
    publisher.settle();
    callbacks[0]?.();
    publisher.publish(update("late"));

    expect(delivered).toEqual(["leading", "latest"]);
    expect(cancellations[0]).toHaveBeenCalledOnce();
  });

  it("does not retain a cancellation handle when a scheduler fires synchronously", () => {
    let now = 0;
    const cancel = vi.fn();
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) =>
        delivered.push(partial.content[0]?.type === "text" ? partial.content[0].text : ""),
      () => true,
      {
        now: () => now,
        schedule: (_delay, callback) => {
          callback();
          return cancel;
        },
      },
    );

    publisher.publish(update("leading"));
    now = 1;
    publisher.publish(update("scheduled"));
    publisher.settle();

    expect(delivered).toEqual(["leading", "scheduled"]);
    expect(cancel).not.toHaveBeenCalled();
  });

  it("contains hostile update callbacks and scheduler failures", () => {
    const publisher = makeGuardedToolUpdatePublisher(
      () => {
        throw new Error("host update failed");
      },
      () => true,
      {
        now: () => 0,
        schedule: () => {
          throw new Error("scheduler failed");
        },
      },
    );

    expect(() => {
      publisher.publish(update("leading"));
      publisher.publish(update("fallback"));
      publisher.settle();
    }).not.toThrow();
  });
});
