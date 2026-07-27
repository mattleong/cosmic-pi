import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { makeProjectionBridge } from "../src/boundary/host-ui.ts";
import type { BackgroundTerminalProjection } from "../src/job/model.ts";

const running: BackgroundTerminalProjection = {
  jobs: [
    {
      id: "term-1",
      command: "server",
      cwd: "/project",
      state: "running",
      startedAt: 0,
      logCursor: 0,
      droppedLogBytes: 0,
      logs: [],
    },
  ],
};

const context = (setStatus: ReturnType<typeof vi.fn>) =>
  ({ mode: "tui", ui: { setStatus } }) as unknown as ExtensionContext;

describe("background terminal host projection", () => {
  it("rebinds footer publication after session replacement", () => {
    const oldStatus = vi.fn();
    const nextStatus = vi.fn();
    const bridge = makeProjectionBridge();
    bridge.setContext(context(oldStatus));
    bridge.publish(running);
    bridge.clear();
    bridge.publish(running);
    bridge.setContext(context(nextStatus));
    expect(oldStatus).toHaveBeenCalledWith("pi-background-terminals", undefined);
    expect(nextStatus).toHaveBeenLastCalledWith(
      "pi-background-terminals",
      "1 background job active",
    );
  });

  it("keeps notifying remaining listeners when one subscriber throws", () => {
    const bridge = makeProjectionBridge();
    const before = vi.fn();
    const after = vi.fn();
    bridge.subscribe(before);
    bridge.subscribe(() => {
      throw new Error("subscriber failed");
    });
    bridge.subscribe(after);

    expect(() => bridge.publish(running)).not.toThrow();
    expect(before).toHaveBeenCalledTimes(1);
    expect(after).toHaveBeenCalledTimes(1);

    expect(() => bridge.clear()).not.toThrow();
    expect(before).toHaveBeenCalledTimes(2);
    expect(after).toHaveBeenCalledTimes(2);
  });
});
