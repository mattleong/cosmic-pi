import { describe, expect, it } from "vitest";
import type { McpGatewayReply } from "../../src/tools/model.ts";
import { mcpCompactSummary } from "../../src/ui/compact-summary.ts";
import { decodeMcpCardDetails } from "../../src/ui/tool-render-details.ts";

type Input = Parameters<typeof mcpCompactSummary>[0];
const reply = (data: McpGatewayReply["data"] = {}, fields: Partial<McpGatewayReply> = {}) => ({
  action: "tools.list",
  outcome: "completed",
  isError: false,
  data,
  notices: [],
  ...fields,
});
function summarize<Details>(
  details: Details,
  phase: Input["phase"] = "settled",
  isError = false,
  args: Input["args"] = { action: "tools.list", server: "catalog" },
) {
  return mcpCompactSummary({
    phase,
    args,
    result: { content: [], details },
    context: {
      args,
      state: {},
      toolCallId: "test",
      cwd: "/project",
      invalidate: () => undefined,
      lastComponent: undefined,
      argsComplete: true,
      executionStarted: phase !== "pending",
      expanded: false,
      isPartial: phase === "running",
      isError,
      showImages: true,
    },
  });
}

describe("MCP compact summaries", () => {
  it("keeps pending and remote progress observational, without premature outcomes", () => {
    for (const phase of ["pending", "running"] as const) {
      const summary = summarize(reply({}, { outcome: "unknown" }), phase);
      expect(summary?.subject).toContain("catalog");
      expect(summary?.outcome).toBeUndefined();
      expect(summary?.notices).toBeUndefined();
    }
  });
  it("identifies tool searches by their bounded query without invoking getters", () => {
    for (const server of [undefined, "catalog"]) {
      const args = {
        action: "tools.search",
        query: "Find project files",
        ...(server && { server }),
      };
      const summary = summarize(reply(), "pending", false, args);
      expect(summary?.subject).toContain(args.query);
      if (server) expect(summary?.subject).toContain(server);
    }
    const args = Object.defineProperty({ action: "tools.search", server: "catalog" }, "query", {
      get() {
        throw new Error("must not read query getter");
      },
    });
    expect(summarize(reply(), "pending", false, args)?.subject).toBe("catalog");
    expect(
      summarize(reply(), "pending", false, { action: "tools.search", query: "x".repeat(1025) })
        ?.subject,
    ).toBe("");
  });

  it("uses domain counts and retains pagination and discovery limitations", () => {
    const summary = summarize(
      reply({
        result: {
          page: { items: [{ name: "one" }], total: 3, nextCursor: "next" },
          undiscovered: ["other"],
        },
      }),
    );
    expect(summary?.outcome).toBe("warning");
    expect(summary?.counters?.join(" ")).toMatch(/1 of 3/);
    expect(summary?.action).toBe("tools.list");
    expect(summary?.subject).toBe("catalog");
    expect(summary?.counters).toHaveLength(1);
    expect(summary?.counters?.join(" ")).toContain("more available");
    expect(
      summary?.notices?.find((notice) => notice.text.startsWith("Discovery is incomplete"))
        ?.expandedInResult,
    ).toBeUndefined();
    expect(summary?.notices?.some((notice) => notice.kind === "recovery")).toBe(true);
  });
  it("omits routine retained IDs without changing result access", () => {
    const details = reply({ result: { tools: [] } }, { resultId: "retained-1" });
    const before = structuredClone(details);
    const summary = summarize(details);
    expect(JSON.stringify(summary)).not.toContain("retained-1");
    expect(summary?.notices).toEqual([]);
    expect(summary?.outcome).toBe("success");
    expect(details).toEqual(before);
    expect(decodeMcpCardDetails({ details }).recoveryHint).toBe("/mcp result retained-1");
  });
  it("does not treat display limits as output loss", () => {
    const details = reply(
      { result: { content: Array.from({ length: 129 }, () => ({ type: "text", text: "x" })) } },
      { resultId: "retained-1" },
    );
    const before = structuredClone(details);
    expect(decodeMcpCardDetails({ details }).displayCuts.length).toBeGreaterThan(0);
    expect(summarize(details)?.outcome).toBe("success");
    expect(summarize(details)?.notices).toEqual([]);
    expect(details).toEqual(before);
  });
  it.each([{ truncated: true }, { omitted: true }])(
    "keeps actual output loss visible without repeating retained IDs: %j",
    (data) => {
      const details = reply(data, { resultId: "retained-1" });
      const summary = summarize(details);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.notices?.some((notice) => notice.kind === "warning")).toBe(true);
      expect(JSON.stringify(summary)).not.toContain("retained-1");
      expect(decodeMcpCardDetails({ details }).resultId).toBe("retained-1");
    },
  );
  it("keeps routine stale-cache notices in details, not collapsed attention", () => {
    const stale = "MCP catalog cached metadata is not fresh; invocation requires current metadata.";
    for (const action of ["tools.list", "tools.search"]) {
      const details = reply({}, { action, notices: [stale] });
      expect(summarize(details)?.outcome).toBe("success");
      expect(summarize(details)?.notices).toEqual([]);
      expect(decodeMcpCardDetails({ details }).notices).toContain(stale);
    }
    for (const details of [
      reply(
        {},
        {
          notices: [
            "MCP catalog metadata refresh failed; previous metadata is a stale inspection-only view.",
          ],
        },
      ),
      reply({}, { action: "tools.call", notices: [stale] }),
      reply({}, { notices: [`${stale} Approval required.`] }),
    ]) {
      expect(summarize(details)?.outcome).toBe("warning");
      expect(summarize(details)?.notices?.length).toBeGreaterThan(0);
    }
  });
  it("keeps valid discovery pagination in one bounded detail", () => {
    const details = reply(
      { result: { page: { items: [], total: 1, nextCursor: "next" } } },
      { resultId: "retained-1" },
    );
    const before = structuredClone(details);
    const summary = summarize(details);
    expect(summary?.notices).toEqual([]);
    expect(summary?.counters).toHaveLength(1);
    expect(summary?.counters?.join(" ")).toMatch(/0 of 1.*more available/);
    expect(JSON.stringify(summary)).not.toContain("retained-1");
    expect(summary?.outcome).toBe("success");
    expect(details).toEqual(before);
  });
  it("does not mistake a final page for missing output", () => {
    // total describes the whole catalog, not the remaining page.
    const summary = summarize(
      reply({ result: { page: { items: [{ name: "last" }], total: 3 } } }),
      "settled",
      false,
      { action: "tools.list", server: "catalog", cursor: "last-page" },
    );
    expect(summary?.outcome).toBe("success");
    expect(summary?.notices).toEqual([]);
  });
  it("does not repeat the retained ID when it already identifies the requested read", () => {
    const summary = summarize(
      reply(
        { origin: { action: "tools.list", outcome: "completed", isError: false } },
        { action: "result.read", resultId: "retained-1" },
      ),
      "settled",
      false,
      { action: "result.read", id: "retained-1" },
    );
    expect(summary?.subject).toContain("retained-1");
    expect(summary?.metadata?.join(" ") ?? "").not.toContain("retained-1");
    expect(summary?.notices).toEqual([]);
  });
  it("preserves remote notices even when they appear routine", () => {
    const summary = summarize(reply({}, { resultId: "retained-1", notices: ["Remote notice"] }));
    expect(summary?.notices).toContainEqual({
      kind: "warning",
      text: "Remote notice",
      expandedInResult: true,
    });
    expect(JSON.stringify(summary)).not.toContain("retained-1");
  });
  it("requires explicit success and never clears a Pi error", () => {
    expect(summarize(reply())?.outcome).toBe("success");
    for (const details of [
      undefined,
      {},
      { outcome: "completed" },
      reply({}, { isError: true }),
      reply({}, { outcome: "unknown" }),
      reply({}, { outcome: "not-sent" }),
    ]) {
      expect(summarize(details)).toBeUndefined();
    }
    expect(summarize(reply(), "settled", true)).toBeUndefined();
  });
  it("leaves rich failures, unknown execution and cleanup recovery to the original renderer", () => {
    for (const data of [
      { kind: "cleanup" },
      { kind: "auth-required" },
      { kind: "output-limit" },
      { kind: "cancelled", message: "Approval required before retry" },
    ]) {
      const details = reply(data, {
        outcome: "unknown",
        isError: true,
        notices: ["Do not replay; inspect current state before recovery."],
      });
      expect(summarize(details)).toBeUndefined();
      expect(decodeMcpCardDetails({ details }).warnings.length).toBeGreaterThan(0);
    }
  });
  it("does not turn successful retained reads into successful original operations", () => {
    for (const origin of [
      { outcome: "unknown", isError: false },
      { outcome: "completed", isError: true },
      { outcome: "completed", outputValidation: "failed" },
      { outcome: "completed" },
      {},
    ]) {
      expect(summarize(reply({ origin }, { action: "result.read" }))).toBeUndefined();
    }
  });
  it("summarizes retained reads only with explicit original success", () => {
    expect(
      summarize(
        reply(
          { origin: { action: "tools.call", outcome: "completed", isError: false } },
          { action: "result.read" },
        ),
      )?.outcome,
    ).toBe("success");
  });
  it("preserves safety warnings while leaving retained-output access in details", () => {
    const details = reply(
      {
        truncated: true,
        origin: {
          outcome: "completed",
          isError: false,
          outputValidation: "unavailable",
        },
      },
      { resultId: "retained-1", notices: ["User approval required before a later operation."] },
    );
    const summary = summarize(details);
    const card = decodeMcpCardDetails({ details });
    expect(summary?.outcome).toBe("warning");
    const notices = summary?.notices?.map((notice) => notice.text);
    for (const text of [...card.warnings, ...card.notices]) expect(notices).toContain(text);
    expect(card.resultId).toBe("retained-1");
    expect(notices).not.toContain(card.recoveryHint);
    expect(summary?.failure).toBeUndefined();
  });
  it("does not invoke hostile historical getters", () => {
    const details = Object.defineProperty({}, "outcome", {
      get() {
        throw new Error("getter");
      },
    });
    expect(summarize(details)).toBeUndefined();
  });
});
