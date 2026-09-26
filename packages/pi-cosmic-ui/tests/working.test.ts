import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { describe, expect, it } from "vitest";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { makeHostCallbackBoundary } from "../src/boundary/host-callback.ts";
import { makeWorkingRow } from "../src/working/row.ts";

/** A bound working row over a scriptable host context, a manual clock, and a manual ticker pool. */
function workingHarness() {
  let time = 0;
  let mode: "tui" | "rpc" = "tui";
  let failNext = false;
  const attempted: Array<string | undefined> = [];
  const delivered: Array<string | undefined> = [];
  const tickers = new Set<() => void>();
  const context = MutableRef.make<ExtensionContext>(
    extensionContextFixture({
      get mode() {
        return mode;
      },
      ui: {
        setWorkingMessage(message?: string) {
          attempted.push(message);
          if (failNext) {
            failNext = false;
            throw new Error("secret host failure");
          }
          delivered.push(message);
        },
      },
    }),
  );
  const row = makeWorkingRow({
    callbacks: makeHostCallbackBoundary(),
    now: () => time,
    every: (_intervalMs, tick) => {
      const subscription = () => tick();
      tickers.add(subscription);
      return () => void tickers.delete(subscription);
    },
  });
  row.activate(context);
  return {
    row,
    context,
    attempted,
    delivered,
    tickers,
    setMode: (next: "tui" | "rpc") => {
      mode = next;
    },
    failNextWrite: () => {
      failNext = true;
    },
    advance: (seconds: number) => {
      for (let second = 0; second < seconds; second += 1) {
        time += 1_000;
        for (const tick of tickers) tick();
      }
    },
  };
}

describe("working row", () => {
  it("contains a throwing host write and retries it on the next tick", () => {
    const h = workingHarness();
    h.failNextWrite();
    expect(() => h.row.agentStart()).not.toThrow();
    h.advance(1);
    h.failNextWrite();
    h.advance(2);

    expect(h.attempted).toEqual(["Working · 0s", "Working · 1s", "Working · 2s", "Working · 3s"]);
    expect(h.delivered).toEqual(["Working · 1s", "Working · 3s"]);
  });

  it("writes nothing and does not tick without a TUI working row", () => {
    const h = workingHarness();
    h.setMode("rpc");
    h.row.agentStart();
    h.advance(5);

    expect(h.attempted).toEqual([]);
    expect(h.tickers.size).toBe(0);
  });

  it("an unavailable tick freezes the clocks until a later write succeeds", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.advance(2);
    h.setMode("rpc");
    h.advance(1);
    expect(h.tickers.size).toBe(0);

    h.setMode("tui");
    h.advance(3);
    expect(h.delivered.at(-1)).toBe("Working · 2s");
    h.row.promptStart();
    h.row.promptEnd();
    expect(h.delivered.at(-1)).toBe("Working · 3s");
    h.advance(1);
    expect(h.delivered.at(-1)).toBe("Working · 4s");
  });

  it("keeps ticking after a successful resume that follows an unavailable prompt write", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.advance(1);
    h.setMode("rpc");
    h.row.promptStart();
    h.setMode("tui");
    h.advance(2);
    expect(h.delivered.at(-1)).toBe("Working · 1s");

    h.row.promptEnd();
    expect(h.delivered.at(-1)).toBe("Working · 1s");
    h.advance(1);
    expect(h.delivered.at(-1)).toBe("Working · 2s");
  });

  it("excludes an idempotent user-prompt span from elapsed work", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.advance(3);

    h.row.promptStart();
    h.row.promptStart();
    expect(h.delivered.at(-1)).toBe("Waiting for user");
    h.advance(8);
    expect(h.delivered.at(-1)).toBe("Waiting for user");

    h.row.promptEnd();
    h.row.promptEnd();
    expect(h.delivered.at(-1)).toBe("Working · 3s");
    h.advance(2);
    expect(h.delivered.at(-1)).toBe("Working · 5s");
  });

  it("drops output while waiting and excludes the wait from throughput", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.row.output(40);
    h.advance(2);
    expect(h.delivered.at(-1)).toBe("Working · 2s · ~5.0 tok/s");

    h.row.promptStart();
    h.row.output(400);
    h.advance(8);
    h.row.promptEnd();
    expect(h.delivered.at(-1)).toBe("Working · 2s · ~5.0 tok/s");

    h.row.output(40);
    h.advance(2);
    expect(h.delivered.at(-1)).toBe("Working · 4s · ~5.0 tok/s");
  });

  it("pauses only the output clock between messages", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.row.output(40);
    h.advance(1);
    h.row.pauseOutput();
    h.advance(3);
    expect(h.delivered.at(-1)).toBe("Working · 4s · ~10.0 tok/s");
  });

  it("keeps prompt timing active when transient host writes fail", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.advance(2);

    h.failNextWrite();
    h.row.promptStart();
    const writesAfterFailedWait = h.attempted.length;
    h.advance(8);
    expect(h.attempted.length).toBeGreaterThan(writesAfterFailedWait);
    expect(h.delivered.at(-1)).toBe("Waiting for user");

    h.failNextWrite();
    h.row.promptEnd();
    h.advance(1);
    expect(h.delivered.at(-1)).toBe("Working · 3s");
  });

  it("settlement and deactivation clear a running row and stop ticking", () => {
    const h = workingHarness();
    h.row.agentStart();
    h.advance(1);
    h.row.agentEnd();
    expect(h.delivered.slice(-2)).toEqual(["Working · 1s", undefined]);
    expect(h.tickers.size).toBe(0);

    h.row.agentStart();
    h.row.promptStart();
    h.row.deactivate();
    expect(h.delivered.slice(-2)).toEqual(["Waiting for user", undefined]);
    expect(h.tickers.size).toBe(0);
    expect(h.row.isPrompting()).toBe(false);
  });

  it("ignores runs while unbound and prompts outside a run", () => {
    const h = workingHarness();
    h.row.deactivate();
    h.row.agentStart();
    h.row.activate(h.context);
    h.row.promptStart();
    h.row.output(40);
    h.advance(2);

    expect(h.attempted).toEqual([]);
    expect(h.row.canPrompt()).toBe(false);
  });
});
