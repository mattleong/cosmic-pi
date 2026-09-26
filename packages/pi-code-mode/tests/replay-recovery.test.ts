import { describe, expect, it } from "vitest";
import { INCOMPLETE_ATTENTION } from "../src/tools/compact-evidence.ts";
import { callEntryDetails, MAX_PROGRESS_ENTRIES } from "../src/tools/format.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import { decodeCodeModeRenderDetails } from "../src/ui/tool-render-details.ts";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { renderResultText } from "./support/presentation.ts";

const notices = Array.from({ length: 32 }, (_, index) => ({
  kind: "recovery" as const,
  text: `Check retained operation ${index} before retrying.`,
}));
const recovery = "Check separately retained operation before retrying.";
const issues = { coverage: "complete", entries: [] };
const receipt = {
  version: 2,
  issues,
  subject: "safe",
  outcome: "success",
  deliveryFailed: false,
  notices: [{ kind: "recovery", text: recovery }],
};
const replay = <Compact>(compact?: Compact) => ({
  ...callEntryDetails([{ tool: "pi.read", status: "completed" }]),
  toolCalls: [
    { tool: "pi.read", status: "completed", compact: compact ?? { ...receipt, subject: 42 } },
  ],
  outputKind: "text",
  compactAttention: {
    version: 2,
    issues,
    admitted: 1,
    started: 1,
    observed: 1,
    unsupported: 0,
    errors: 0,
    warnings: 0,
    cancelled: 0,
    uncertain: 0,
    incomplete: true,
    notices,
  },
});
const summarize = <Details>(details: Details, expanded = false) =>
  codeModeCompactSummary({
    phase: "settled",
    args: {},
    result: { details, content: [{ type: "text", text: "output" }] },
    context: opaqueFixture({ expanded, isError: false }),
  });

describe("replayed receipt recovery", () => {
  it("preserves independent recovery beyond the aggregate cap without trusting malformed outcomes", () => {
    const details = decodeCodeModeRenderDetails(replay());
    expect(details.toolCalls[0]?.compact).toBeUndefined();
    expect(details.compactAttention?.notices).toHaveLength(32);
    expect(details.recoveredNotices).toEqual([{ kind: "recovery", text: recovery }]);
    for (const expanded of [false, true]) {
      const summary = summarize(replay(), expanded);
      expect(summary?.outcome).toBe("uncertain");
      expect(summary?.notices?.map((notice) => notice.text)).toEqual(
        expect.arrayContaining([recovery, INCOMPLETE_ATTENTION]),
      );
    }
  });

  it("recovers per-call notices when replayed aggregate notices also overflow", () => {
    const raw = replay();
    const details = {
      ...raw,
      compactAttention: {
        ...raw.compactAttention,
        notices: [...notices, { kind: "recovery", text: recovery }],
      },
    };
    const normalized = decodeCodeModeRenderDetails(details);
    expect(normalized.recoveredNotices).toEqual([...notices, { kind: "recovery", text: recovery }]);
    expect(normalized.compactAttention?.incomplete).toBe(true);
    expect(summarize(details)?.notices?.some((notice) => notice.text === recovery)).toBe(true);
  });

  it("salvages v1 receipt and ledger notices as incomplete, uncertain history", () => {
    const ledgerRecovery = "Check the recorded operation before retrying.";
    const { issues: _receiptIssues, ...v1Receipt } = { ...receipt, version: 1 };
    const { issues: _ledgerIssues, ...v1Ledger } = {
      ...replay().compactAttention,
      version: 1,
      incomplete: false,
      notices: [{ kind: "recovery", text: ledgerRecovery }],
    };
    const details = { ...replay(v1Receipt), compactAttention: v1Ledger };
    const normalized = decodeCodeModeRenderDetails(details);
    expect(normalized.toolCalls[0]?.compact).toBeUndefined();
    expect(normalized.compactAttention?.incomplete).toBe(true);
    expect(normalized.recoveredNotices?.map((notice) => notice.text)).toEqual([
      ledgerRecovery,
      recovery,
    ]);
    const summary = summarize(details);
    expect(summary?.outcome).toBe("uncertain");
    expect(summary?.children?.entries[0]?.status).toBe("returned");
    expect(summary?.notices?.map((notice) => notice.text)).toEqual(
      expect.arrayContaining([ledgerRecovery, recovery, INCOMPLETE_ATTENTION]),
    );
  });

  it("redacts legacy activity before bounding its display", () => {
    const details = decodeCodeModeRenderDetails({
      toolCalls: [
        {
          tool: "pi.bash",
          status: "completed",
          activity: `token=${"private".repeat(400)}`,
        },
      ],
    });
    expect(details.toolCalls[0]?.activity).not.toContain("private");
  });

  it("retains recovery in unknown history and renderer failure fallbacks", () => {
    const details = { ...replay(), outputKind: "unknown" };
    expect(summarize(details)).toBeUndefined();
    for (const expanded of [false, true]) {
      for (const fail of [false, true]) {
        const theme = fail
          ? opaqueFixture({
              fg: () => {
                throw new Error("theme unavailable");
              },
            })
          : plainTheme;
        const rendered = renderResultText(
          { details, content: [{ type: "text", text: "output" }] },
          { expanded, theme },
        );
        expect(rendered).toContain(recovery);
        expect(rendered).toContain(INCOMPLETE_ATTENTION);
      }
    }
  });

  it("recovers valid notices from invalid rows, sanitizes them, and respects both existing bounds", () => {
    const details = decodeCodeModeRenderDetails({
      toolCalls: Array.from({ length: MAX_PROGRESS_ENTRIES + 1 }, () => ({
        status: "unknown",
        compact: {
          ...receipt,
          notices: [
            { kind: "recovery", text: "Check token=secret-value before retrying.\u001b[31m" },
            ...notices,
          ],
        },
      })),
    });
    expect(details.toolCalls).toEqual([]);
    expect(details.compactAttention?.incomplete).toBe(true);
    expect(details.recoveredNotices).toHaveLength(MAX_PROGRESS_ENTRIES * 32);
    expect(JSON.stringify(details.recoveredNotices)).not.toMatch(/secret-value|\\u001b/);
  });

  it("keeps routine recovery expanded-only after malformed sibling recovery", () => {
    const details = replay({
      ...receipt,
      subject: null,
      notices: [{ kind: "recovery", text: recovery, expandedOnly: true }],
    });
    const summary = summarize(details);
    expect(summary?.notices?.find((notice) => notice.text === recovery)?.expandedOnly).toBe(true);
    for (const expanded of [false, true]) {
      const rendered = renderResultText({ details, content: [] }, { expanded });
      expect(rendered.includes(recovery)).toBe(expanded);
    }
  });
});
