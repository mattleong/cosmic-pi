import { compactIssueSeverity, compactStatus } from "pi-code-previews";
import { renderContextFixture } from "pi-code-previews/testing";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type { McpGatewayReply } from "../../src/tools/model.ts";
import { mcpCompactSummary } from "../../src/ui/compact-summary.ts";
import { decodeMcpCardDetails } from "../../src/ui/tool-render-details.ts";
import { projectReply } from "../fixtures/results.ts";

it.effect("classifies normalized discovery by operation, not remote lookalike fields", () =>
  Effect.gen(function* () {
    const payload = {
      content: [{ type: "text", text: "remote-body" }],
      tools: [{ name: "fake" }],
      resources: [{}],
      prompts: [{}],
      page: { items: [{}], total: 4, nextCursor: "remote-cursor" },
      undiscovered: ["remote-server"],
      truncated: true,
    };
    for (const action of [
      "tools.call",
      "resources.read",
      "prompts.get",
      "tools.list",
      "tools.search",
    ]) {
      const execution = yield* projectReply(action, payload);
      for (const retained of [false, true]) {
        const details = retained ? { ...execution.reply, action: "result.read" } : execution.reply;
        const card = decodeMcpCardDetails({ details, content: [] });
        const discovery = action === "tools.list" || action === "tools.search";
        expect(card.page !== undefined).toBe(discovery);
        expect(
          card.presentation.issues.some((issue) => issue.code === "discovery-incomplete"),
        ).toBe(discovery);
        expect(card.presentation.truncated).toBe(false);
        if (!discovery)
          expect(card.counts.join(" ")).not.toMatch(/tools|resources|prompts|entries/);
        expect(card.preview).toContain("remote-server");
        expect(card.preview).toContain("remote-cursor");
      }
    }
  }),
);

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
    context: renderContextFixture({
      args,
      executionStarted: phase !== "pending",
      isPartial: phase === "running",
      isError,
    }),
  });
}
const codes = (summary: ReturnType<typeof summarize>) =>
  summary?.issues?.map((issue) => issue.code) ?? [];
const issueDetails = (summary: ReturnType<typeof summarize>) =>
  summary?.issues?.map((issue) => issue.detail ?? "").join("\n") ?? "";

describe("MCP compact summaries", () => {
  it.each(["status", "connect", "disconnect"])(
    "preserves gateway-owned server counts for %s and its retained origin",
    (action) => {
      for (const retained of [false, true]) {
        const details = reply(
          {
            origin: { action, outcome: "completed", isError: false },
            result: { servers: ["first", "second"] },
          },
          { action: retained ? "result.read" : action },
        );
        const card = decodeMcpCardDetails({ details, content: [] });
        expect(card.counts).toHaveLength(1);
        expect(card.counts[0]).toContain("2");
      }
    },
  );
  it("projects a remote cause as one error issue with the rest of its text in detail", () => {
    const details = reply(
      {
        result: {
          content: [
            { type: "text", text: "Element detached.\nInspect the document before retrying." },
          ],
        },
      },
      { action: "tools.call", isError: true },
    );
    const before = structuredClone(details);
    const summary = summarize(details, "settled", true, {
      action: "tools.call",
      server: "browser",
      tool: "click",
    });
    expect(summary?.outcome).toBe("error");
    expect(summary?.issues).toHaveLength(1);
    expect(summary?.issues?.[0]).toMatchObject({
      code: "remote-failure",
      severity: "error",
      message: "Element detached.",
    });
    expect(summary?.issues?.[0]?.detail).toContain("Inspect the document before retrying.");
    expect(details).toEqual(before);
    // Oversized parts keep the error and disclose the missing evidence.
    const oversized = summarize(
      reply(
        { result: { content: [{ type: "text", text: "x".repeat(513) }] } },
        { action: "tools.call", isError: true },
      ),
      "settled",
      true,
    );
    expect(oversized?.outcome).toBe("error");
    expect(codes(oversized)).toEqual(expect.arrayContaining(["failure", "evidence-incomplete"]));
    const noticed = summarize(
      { ...details, notices: ["Additional recovery is required."] },
      "settled",
      true,
    );
    expect(codes(noticed)).toEqual(["remote-failure", "unclassified-notices"]);
    expect(details).toEqual(before);
  });
  it("keeps pending and remote progress observational, without premature outcomes", () => {
    for (const phase of ["pending", "running"] as const) {
      const summary = summarize(reply({}, { outcome: "unknown" }), phase);
      expect(summary?.subject).toContain("catalog");
      expect(summary?.outcome).toBeUndefined();
      expect(summary?.issues).toBeUndefined();
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
    expect(codes(summary)).toContain("discovery-incomplete");
    expect(compactIssueSeverity(summary?.issues)).toBe("warning");
  });
  it("omits routine retained IDs without changing result access", () => {
    const details = reply({ result: { tools: [] } }, { resultId: "retained-1" });
    const before = structuredClone(details);
    const summary = summarize(details);
    expect(JSON.stringify(summary)).not.toContain("retained-1");
    expect(summary?.issues).toEqual([]);
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
    expect(summarize(details)?.issues).toEqual([]);
    expect(details).toEqual(before);
  });
  it.each([{ truncated: true }, { omitted: true }])(
    "keeps actual output loss and essential recovery visible: %j",
    (data) => {
      const details = reply(data, { resultId: "retained-1" });
      const summary = summarize(details);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.issues?.find((issue) => issue.code === "output-truncated")?.severity).toBe(
        "warning",
      );
      // The retained ID is agent recovery: expanded detail only, never a message.
      expect(issueDetails(summary)).toContain("retained-1");
      expect(summary?.issues?.some((issue) => issue.message.includes("retained-1"))).toBe(false);
      expect(decodeMcpCardDetails({ details }).resultId).toBe("retained-1");
    },
  );
  it("keeps routine stale-cache notices as expanded information, not collapsed attention", () => {
    const stale = "MCP catalog cached metadata is not fresh; invocation requires current metadata.";
    for (const action of ["tools.list", "tools.search"]) {
      const details = reply({}, { action, notices: [stale] });
      const summary = summarize(details);
      expect(summary?.outcome).toBe("success");
      expect(compactIssueSeverity(summary?.issues)).toBeUndefined();
      expect(summary?.issues).toContainEqual(
        expect.objectContaining({ severity: "info", detail: stale }),
      );
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
      expect(compactIssueSeverity(summarize(details)?.issues)).toBe("warning");
    }
  });
  it("preserves optional catalog diagnostics expanded without marking tool inspection as failed", () => {
    const notices = ["resources", "templates"].map(
      (family) =>
        `MCP catalog ${family} catalog is unavailable because its listing method was not found.`,
    );
    for (const action of ["tools.search", "tools.describe"]) {
      const details = reply({}, { action, notices, resultId: "retained-1" });
      const before = structuredClone(details);
      const compact = summarize(details);
      expect(compact?.outcome).toBe("success");
      expect(compact?.issues?.every((issue) => issue.severity === "info")).toBe(true);
      expect(compact?.issues?.map((issue) => issue.detail)).toEqual(notices);
      expect(details).toEqual(before);
      expect(
        summarize(reply({}, { action, notices: [...notices, "Access must be reviewed."] }))
          ?.outcome,
      ).toBe("warning");
    }
    for (const action of ["resources.list", "resources.templates"])
      expect(summarize(reply({}, { action, notices }))?.outcome).toBe("warning");
  });
  it("keeps valid discovery pagination in one bounded detail", () => {
    const details = reply(
      { result: { page: { items: [], total: 1, nextCursor: "next" } } },
      { resultId: "retained-1" },
    );
    const before = structuredClone(details);
    const summary = summarize(details);
    expect(summary?.issues).toEqual([]);
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
    expect(summary?.issues).toEqual([]);
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
    expect(summary?.issues).toEqual([]);
  });
  it("redacts notices without exposing them", () => {
    const raw = `token=${"private".repeat(200)}`;
    const details = reply({}, { notices: [raw] });
    expect(decodeMcpCardDetails({ details }).notices.join(" ")).not.toContain("private");
    expect(JSON.stringify(summarize(details))).not.toContain("private");
  });
  it("preserves remote notices even when they appear routine", () => {
    const summary = summarize(reply({}, { resultId: "retained-1", notices: ["Remote notice"] }));
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues).toContainEqual(
      expect.objectContaining({
        code: "unclassified-notices",
        severity: "warning",
        detail: "Remote notice",
      }),
    );
    expect(JSON.stringify(summary)).not.toContain("retained-1");
  });
  it("requires explicit success and never clears an error", () => {
    expect(summarize(reply())?.outcome).toBe("success");
    const hostile = Object.defineProperty({}, "outcome", {
      get() {
        throw new Error("getter");
      },
    });
    for (const details of [undefined, {}, { outcome: "completed" }, hostile])
      expect(summarize(details)).toBeUndefined();
    // A Pi error never pairs with an envelope that claims success.
    expect(summarize(reply(), "settled", true)).toBeUndefined();
    for (const outcome of ["completed", "unknown", "not-sent"] as const) {
      const summary = summarize(reply({}, { outcome, isError: true }));
      expect(summary?.outcome).not.toBe("success");
      expect(compactStatus("settled", summary!)).toBe("error");
    }
    for (const [outcome, expected, code] of [
      ["unknown", "uncertain", "execution-unknown"],
      ["not-sent", "warning", "not-sent"],
    ] as const) {
      const summary = summarize(reply({}, { outcome }));
      expect(summary?.outcome).toBe(expected);
      expect(codes(summary)).toContain(code);
    }
  });
  it("projects fixed boundary causes with their recovery in detail", () => {
    const notice = "Do not replay; inspect current state before recovery.";
    for (const data of [
      { kind: "cleanup" },
      { kind: "auth-required" },
      { kind: "output-limit" },
      { kind: "cancelled", message: "Approval required before retry" },
    ]) {
      const details = reply(data, { outcome: "unknown", isError: true, notices: [notice] });
      const projected = summarize(details);
      expect(projected?.outcome).toBe("uncertain");
      expect(projected?.issues?.[0]).toMatchObject({ code: "boundary-failure", severity: "error" });
      expect(projected?.issues?.[0]?.detail).toContain(
        decodeMcpCardDetails({ details }).diagnostic?.explanation,
      );
      expect(
        projected?.issues?.find((issue) => issue.code === "unclassified-notices")?.detail,
      ).toBe(notice);
      expect(JSON.stringify(projected)).not.toContain("Approval required before retry");
      expect(projected?.issues?.some((issue) => issue.message.includes(notice))).toBe(false);
    }
  });
  it("shows successful retained-page reads separately from original outcomes", () => {
    for (const origin of [
      { action: "tools.call", outcome: "completed", isError: false },
      { action: "tools.call", outcome: "completed", isError: true },
      { action: "tools.call", outcome: "unknown", isError: false },
      { action: "tools.call", outcome: "completed", isError: false, outputValidation: "failed" },
    ]) {
      const projected = summarize(
        reply(
          { origin, offset: 0, next: 4, total: 8, text: "page" },
          { action: "result.read", resultId: "retained-1" },
        ),
        "settled",
        false,
        { action: "result.read", id: "retained-1" },
      );
      expect(projected?.counters?.join(" ")).toContain("0..4/8");
      expect(projected?.outcome === "success").toBe(
        !origin.isError && origin.outcome === "completed" && !("outputValidation" in origin),
      );
      expect(projected?.outcome).not.toBe("error");
    }
  });
  it("does not invent page ranges from malformed cursor metadata", () => {
    for (const data of [
      { offset: 2, next: 2, total: 8, text: "page" },
      { offset: 2, next: null, total: 8, text: "page" },
      { offset: 2, next: 6, total: 4, text: "page" },
      { offset: -1, next: 3, total: 8, text: "page" },
    ]) {
      const projected = summarize(
        reply(
          { ...data, origin: { action: "tools.call", outcome: "completed", isError: false } },
          { action: "result.read" },
        ),
        "settled",
        false,
        { action: "result.read", id: "retained-1" },
      );
      expect(
        decodeMcpCardDetails({ details: reply({ ...data }, { action: "result.read" }) })
          .retainedPage,
      ).toBeUndefined();
      expect(projected?.counters ?? []).toEqual([]);
    }
  });
  it("keeps fixed boundary causes free of raw remote messages", () => {
    const projected = summarize(
      reply(
        { kind: "invalid-input", reason: "gateway-request-invalid", message: "PRIVATE RAW BODY" },
        { action: "result.read", outcome: "not-sent", isError: true },
      ),
      "settled",
      true,
      { action: "result.read", id: "missing" },
    );
    expect(projected?.issues?.[0]?.code).toBe("boundary-failure");
    expect(JSON.stringify(projected)).not.toContain("PRIVATE RAW BODY");
    expect(projected?.outcome).toBe("error");
    // Without a typed boundary, the unrecognised text is the error's own first line.
    const unknown = summarize(
      reply({ kind: "not-a-known-kind", message: "Unrecognised failure" }, { isError: true }),
    );
    expect(unknown?.outcome).toBe("error");
    expect(unknown?.issues?.[0]).toMatchObject({
      severity: "error",
      message: "Unrecognised failure",
    });
    const cancelled = summarize(
      reply({ kind: "cancelled" }, { outcome: "not-sent", isError: true }),
      "settled",
      true,
    );
    expect(cancelled?.outcome).toBe("cancelled");
  });
  it.each([
    [{ outcome: "completed", isError: true }, "error"],
    [{ outcome: "completed", outputValidation: "failed" }, undefined],
    [{ outcome: "completed", isError: false, outputValidation: "invalid" }, undefined],
    [{ outcome: "completed" }, undefined],
    [{}, undefined],
    [{ outcome: "unknown", isError: false }, "uncertain"],
    [{ action: "tools.call", outcome: "completed", isError: false }, "success"],
  ])("summarizes a retained read of origin %j only as %s", (origin, outcome) => {
    const summary = summarize(reply({ origin }, { action: "result.read" }));
    if (outcome === undefined) expect(summary).toBeUndefined();
    else expect(summary?.outcome).toBe(outcome);
  });
  it("preserves safety warnings while leaving retained-output access in details", () => {
    const details = reply(
      {
        truncated: true,
        origin: {
          action: "tools.call",
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
    expect(codes(summary)).toEqual(
      expect.arrayContaining(["output-truncated", "validation-unavailable", "retained-output"]),
    );
    for (const notice of card.notices) expect(issueDetails(summary)).toContain(notice);
    expect(card.resultId).toBe("retained-1");
    expect(JSON.stringify(summary)).not.toContain(card.recoveryHint);
    expect(summary?.issues?.find((issue) => issue.code === "retained-output")?.severity).toBe(
      "info",
    );
  });
});
