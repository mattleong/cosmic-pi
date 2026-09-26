import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import type { McpCodeModeOutput } from "pi-mcp/code-mode";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderCompactChildren } from "pi-code-previews";
import { COMPLETE_LEDGER, deliveryIssues, ledgerDetails, summarize } from "./support/compact.ts";
import { executeHarness } from "./support/execute.ts";
import { mcpProvider } from "./support/providers.ts";

describe("interpreter delivery evidence", () => {
  it.effect(
    "records protocol-valid output rejected at the interpreter depth boundary without changing operation outcome",
    () =>
      Effect.gen(function* () {
        let data: McpCodeModeOutput["data"] = null;
        for (let depth = 0; depth < 40; depth++) data = { child: data };
        const events = mcpProvider(() =>
          Promise.resolve({
            action: "status",
            outcome: "completed",
            isError: false,
            data,
            notices: [],
          }),
        );
        const completed = yield* Effect.promise(() =>
          executeHarness({ events, config: { maxCumulativeChildOutputBytes: 1000000 } }).run(
            'let message=""; try { await tools.mcp.request({action:"status"}); } catch(e) { message=e.message; } return message;',
          ),
        );
        expect(completed.content[0]).toMatchObject({
          text: expect.stringContaining("Invalid output"),
        });
        expect(completed.content[0]).toMatchObject({
          text: expect.stringContaining("Do not replay completed or uncertain operations"),
        });
        const receipt = completed.details!.toolCalls[0]!.compact!;
        expect(receipt).toMatchObject({ outcome: "success", deliveryFailed: true });
        expect(deliveryIssues(receipt.issues)).toHaveLength(1);
        expect(completed.details!.compactAttention).toEqual(COMPLETE_LEDGER);
        expect(summarize(completed.details!)?.children?.entries[0]).toMatchObject({
          label: "mcp",
          status: "error",
        });
      }),
  );

  it("keeps one delivery explanation on each retained call", () => {
    const { calls, details } = ledgerDetails(
      Array.from({ length: 36 }, () => ({
        tool: "pi.read",
        summary: { subject: "same file", outcome: "success" as const },
      })),
      { status: "error", deliveryFailures: 2 },
    );
    for (const call of calls) expect(deliveryIssues(call.compact?.issues)).toHaveLength(1);
    // Delivery loss never changes the operation outcome the ledger counts.
    expect(details.compactAttention).toEqual(COMPLETE_LEDGER);
    const summary = summarize(details)!;
    expect(summary.outcome).toBe("warning");
    expect(summary.issues).toEqual([]);
    expect(summary.children?.total).toBe(36);
    expect(summary.children?.entries).toHaveLength(details.toolCalls.length);
    expect(summary.children?.entries.every((child) => child.status === "error")).toBe(true);
    const expanded = renderCompactChildren(summary.children, plainTheme, 200, {
      layout: "flat",
      all: true,
    }).join("\n");
    for (const child of summary.children!.entries) {
      const detail = deliveryIssues(child.issues)[0]!.detail!;
      expect(expanded.split(detail)).toHaveLength(2);
    }
  });

  it("keeps the delivery issue when the receipt is already at its issue bound", () => {
    const issues = Array.from({ length: 16 }, (_, id) => ({
      severity: "info" as const,
      code: "page",
      message: `Existing page ${id}`,
    }));
    const { calls } = ledgerDetails(
      [{ tool: "pi.read", summary: { subject: "file", outcome: "success", issues } }],
      { status: "error", deliveryFailures: 1 },
    );
    const receipt = calls[0]!.compact!;
    expect(receipt.deliveryFailed).toBe(true);
    expect(receipt.issues).toHaveLength(16);
    expect(deliveryIssues(receipt.issues)).toHaveLength(1);
  });
});
