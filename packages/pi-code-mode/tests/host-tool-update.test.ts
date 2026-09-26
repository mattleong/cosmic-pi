import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
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

const textOf = (partial: AgentToolResult<CodeModeToolDetails>): string => {
  const content = partial.content[0];
  return content?.type === "text" ? content.text : "";
};

describe("guarded host tool updates", () => {
  it("delivers leading, semantic, and latest trailing snapshots in order", () => {
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
      (partial) => delivered.push(textOf(partial)),
      () => true,
      { schedule, now: () => now },
    );

    publisher.publish(update("leading"));
    now = 1;
    publisher.publish(update("stale pending"));
    publisher.publishNow(update("semantic"));
    publisher.publish(update("older trailing"));
    publisher.publish(update("latest trailing"));
    publisher.settle();
    publisher.settle();

    for (const callback of callbacks) callback();
    publisher.publish(update("after settle"));
    publisher.publishNow(update("after settle now"));

    expect(delivered).toEqual(["leading", "semantic", "latest trailing"]);
    expect(cancellations).toHaveLength(2);
    expect(cancellations.every((cancel) => cancel.mock.calls.length === 1)).toBe(true);
  });

  it.each([
    [
      "a synchronous throw",
      () => {
        throw new Error("host update failed");
      },
    ],
    [
      "a rejecting thenable",
      () =>
        new Proxy(
          {},
          {
            // Report `then` so thenable detection reaches the hostile implementation.
            has: (_target, key) => key === "then",
            get: (_target, key) =>
              key === "then"
                ? (_resolve: () => void, reject: (error: Error) => void) =>
                    reject(new Error("host rejection"))
                : undefined,
          },
        ),
    ],
    [
      "a throwing then getter",
      () =>
        new Proxy(
          {},
          {
            has: (_target, key) => key === "then",
            get: (_target, key) => {
              if (key === "then") throw new Error("then getter escaped");
            },
          },
        ),
    ],
  ])("contains %s from onUpdate", (_name, onUpdate) => {
    const publisher = makeGuardedToolUpdatePublisher(onUpdate, () => true);
    expect(() => {
      publisher.publish(update("leading"));
      publisher.publishNow(update("semantic"));
      publisher.settle();
    }).not.toThrow();
  });

  it("falls back to immediate delivery when scheduling throws", () => {
    const delivered: string[] = [];
    const publisher = makeGuardedToolUpdatePublisher(
      (partial) => delivered.push(textOf(partial)),
      () => true,
      {
        now: () => 0,
        schedule: () => {
          throw new Error("scheduler failed");
        },
      },
    );

    publisher.publish(update("leading"));
    publisher.publish(update("fallback"));
    publisher.settle();
    expect(delivered).toEqual(["leading", "fallback"]);
  });
});
