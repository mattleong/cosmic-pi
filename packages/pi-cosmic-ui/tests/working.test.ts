import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as MutableRef from "effect/MutableRef";
import { describe, expect, it } from "vitest";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { createWorkingRow } from "../src/working/row.ts";

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
  const row = createWorkingRow({
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
    expect(h.delivered.slice(-2)).toEqual(["Waiting for you", undefined]);
    expect(h.tickers.size).toBe(0);
    expect(h.row.isPrompting()).toBe(false);
  });
});
