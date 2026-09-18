import { describe, expect, it } from "vitest";
import { compactIssueSeverity, summaryCompactIssues, type CompactIssues } from "pi-code-previews";
import {
  CompactAttentionSchema,
  CompactReceiptSchema,
  makeCompactEvidence,
  recoverCompactNotices,
  type CompactReceipt,
} from "../src/tools/compact-evidence.ts";
import { decodeOption } from "../src/tools/format.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { opaqueHostFixture } from "./support/host.ts";

const issues: CompactIssues = {
  coverage: "complete",
  entries: [
    {
      operation: "mcp:tools.call",
      code: "remote-failure",
      severity: "error",
      cause: "Element detached.",
      recovery: [{ code: "no-replay", text: "Do not replay to recover output." }],
    },
  ],
};

describe("bounded v2 issue evidence", () => {
  it("does not convert cancellation diagnostics into an independent error", () => {
    const collector = makeCompactEvidence(() => undefined);
    collector.close();
    const summary = codeModeCompactSummary({
      phase: "settled",
      args: {},
      context: opaqueHostFixture({ isError: true }),
      result: {
        content: [{ type: "text", text: "Execution cancelled" }],
        details: {
          toolCalls: [],
          cancelled: true,
          counts: { total: 0, running: 0, queued: 0, failed: 0, cancelled: 0, succeeded: 0 },
          compactAttention: collector.snapshot(),
        },
      },
    });
    expect(summary?.outcome).toBe("cancelled");
    expect(summary && compactIssueSeverity(summaryCompactIssues(summary))).toBe("warning");
    expect(summary?.issues?.entries.some((issue) => issue.severity === "error")).toBe(false);
  });
  it("attributes identical concurrent failures and independent delivery loss without changing outcomes", () => {
    const receipts = new Map<number, CompactReceipt>();
    const collector = makeCompactEvidence((id, value) => receipts.set(id, value));
    for (const id of [1, 2]) {
      collector.admit("mcp.request");
      collector.start(id, id);
    }
    for (const id of [2, 1])
      collector.observe(id, () => ({ subject: "MCP", outcome: "error", issues }));
    collector.deliveryFailure(1);
    const aggregate = collector.snapshot();
    expect(aggregate.version).toBe(2);
    if (aggregate.version !== 2) throw new Error("Expected v2");
    expect(aggregate.issues.entries.map((issue) => issue.operation)).toEqual([
      "call-2/mcp:tools.call",
      "call-1/mcp:tools.call",
      "call-1/delivery",
    ]);
    expect(receipts.get(1)?.outcome).toBe("error");
    expect(receipts.get(1)?.deliveryFailed).toBe(true);
    const combined = summaryCompactIssues({
      subject: "batch",
      issues: aggregate.issues,
      children: {
        total: 2,
        entries: [...receipts.values()].map((receipt) => ({
          label: "mcp",
          status: "error",
          ...(receipt.version === 2 && { issues: receipt.issues }),
        })),
      },
    });
    expect(combined.entries).toHaveLength(3);
    expect(compactIssueSeverity(combined)).toBe("error");
    expect(JSON.stringify(issues)).not.toContain("call-");
    expect(Object.isFrozen(aggregate.issues.entries[0]?.recovery)).toBe(true);
  });

  it("keeps omitted attention bounded and refuses oversized causes without persisting raw output", () => {
    const collector = makeCompactEvidence(() => undefined);
    for (let id = 0; id < 40; id++) {
      collector.admit("mcp.request");
      collector.start(id, id);
      collector.observe(id, () => ({ subject: "MCP", outcome: "error", issues }));
      collector.end(id);
    }
    const aggregate = collector.snapshot();
    expect(aggregate).toMatchObject({ version: 2, observed: 40, errors: 40, incomplete: true });
    if (aggregate.version !== 2) throw new Error("Expected v2");
    expect(aggregate.issues.entries).toHaveLength(32);
    expect(aggregate.issues.coverage).toBe("unknown");
    expect(decodeOption(CompactAttentionSchema, aggregate)).toBeDefined();
    collector.admit("mcp.request");
    collector.start(41, 41);
    collector.observe(41, () => ({
      subject: "MCP",
      outcome: "error",
      issues: { ...issues, entries: [{ ...issues.entries[0]!, cause: "PRIVATE".repeat(200) }] },
    }));
    expect(JSON.stringify(collector.snapshot())).not.toContain("PRIVATE");
  });

  it("decodes explicit v1 history but rejects malformed v2 and salvages bounded recovery", () => {
    const legacy = {
      version: 1,
      subject: "old",
      outcome: "success",
      notices: [],
      deliveryFailed: false,
    };
    expect(decodeOption(CompactReceiptSchema, legacy)).toBeDefined();
    expect(decodeOption(CompactReceiptSchema, { ...legacy, version: 2 })).toBeUndefined();
    expect(decodeOption(CompactReceiptSchema, { ...legacy, version: 3, issues })).toBeUndefined();
    const broken = { ...legacy, version: 2, outcome: "hostile", issues };
    expect(decodeOption(CompactReceiptSchema, broken)).toBeUndefined();
    expect(recoverCompactNotices(broken).map((notice) => notice.text)).toContain(
      "Do not replay to recover output.",
    );
  });
});
