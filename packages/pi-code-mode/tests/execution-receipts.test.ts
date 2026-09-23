import { describe, expect, it } from "@effect/vitest";
import { makeExecutionReceipts } from "../src/tools/execution-receipts.ts";

describe("operation receipts", () => {
  it("keeps host loss across row eviction and refuses late changes after closure", () => {
    const receipts = makeExecutionReceipts();
    receipts.recordOutputLoss();
    receipts.recordOutputLoss();
    for (let id = 0; id < 300; id++) {
      receipts.admit(id, "pi.write");
      receipts.delivery(id, true);
    }
    receipts.close();
    expect(receipts.hasOutputLoss()).toBe(true);
    const clean = makeExecutionReceipts();
    clean.close();
    clean.recordOutputLoss();
    expect(clean.hasOutputLoss()).toBe(false);
  });
  it("counts hidden parallel calls exactly without conflating completion and delivery", () => {
    const receipts = makeExecutionReceipts();
    for (let id = 0; id < 1000; id++) receipts.admit(id, "pi.write");
    for (let id = 0; id < 1000; id++) {
      receipts.start(id, "pi.write");
      receipts.observe(id, "unknown");
      if (id < 998) receipts.observe(id, "completed");
      receipts.delivery(id, id % 2 === 0);
    }
    const snapshot = receipts.close();
    expect(snapshot).toMatchObject({
      total: 1000,
      completed: 998,
      unknown: 2,
      notSent: 0,
      omitted: 744,
    });
    expect(snapshot.calls).toHaveLength(256);
    expect(snapshot.calls.at(-1)).toMatchObject({
      id: 999,
      certainty: "unknown",
      delivery: "not-delivered",
    });
    receipts.observe(999, "completed");
    receipts.admit(1000, "pi.write");
    expect(receipts.close()).toEqual(snapshot);
  });
  it("keeps IDs distinct and refuses malformed recovery IDs", () => {
    const receipts = makeExecutionReceipts();
    for (const id of [1, 2]) {
      receipts.admit(id, "mcp.request");
      receipts.start(id, "mcp.request");
    }
    receipts.observe(1, "completed", "safe-result", true);
    receipts.observe(2, "unknown", "token=secret\nother");
    const snapshot = receipts.close();
    expect(snapshot.calls[0]).toMatchObject({
      id: 1,
      certainty: "completed",
      recoveryId: "safe-result",
      isError: true,
    });
    expect(snapshot.calls[1]).not.toHaveProperty("recoveryId");
    expect(JSON.stringify(snapshot)).not.toContain("secret");
  });
});
