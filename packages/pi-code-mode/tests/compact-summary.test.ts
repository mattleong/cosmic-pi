import * as Effect from "effect/Effect";
import { describe, expect, it } from "vitest";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import {
  codeModeCompactSummaryAtHost,
  syncProgressTicker,
} from "../src/boundary/host-render-ticker.ts";
import { callEntryDetails } from "../src/tools/format.ts";
import { makeCompactEvidence } from "../src/tools/compact-evidence.ts";
import { summaryCompactIssues, withCodePreviewShell } from "pi-code-previews";
import { createToolPresentationHarness, withPresentationSettings } from "pi-code-previews/testing";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { executeHarness } from "./support/execute.ts";
import { ledgerDetails, summarize } from "./support/compact.ts";
import { EMPTY_RECEIPTS } from "./support/results.ts";

const success = { ...callEntryDetails([]), outputKind: "text" as const };

describe("Code Mode compact outcomes", () => {
  it("does not add a generic host failure to a body-owned v2 program failure", () => {
    const ledger = makeCompactEvidence(() => undefined);
    ledger.close();
    const summary = summarize(
      { ...callEntryDetails([]), compactAttention: ledger.snapshot() },
      { isError: true, text: "PROGRAM_FAILURE" },
    );
    const issues = summary && summaryCompactIssues(summary, true).entries;
    expect(issues?.filter((issue) => issue.cause === "PROGRAM_FAILURE")).toHaveLength(1);
    expect(issues?.some((issue) => issue.code === "pi-error")).toBe(false);
  });

  it("does not repeat hidden v2 failures already represented by exact child issues", () => {
    for (const unclassified of [false, true]) {
      const { details } = ledgerDetails(
        [1, 2, 3, 4, 5, 6].map((id) => ({
          tool: "pi.read",
          summary: {
            subject: `file-${id}`,
            outcome: "error",
            issues: {
              coverage: "complete",
              entries: [
                {
                  operation: "read",
                  code: "failure",
                  severity: "error",
                  cause: `read failure ${id}`,
                  recovery: [],
                },
              ],
            },
          },
        })),
        {
          status: "error",
          ...(unclassified && {
            unstarted: ["pi.read"],
            counts: { total: 7, queued: 0, running: 0, succeeded: 0, failed: 7, cancelled: 0 },
          }),
        },
      );
      const summary = summarize(details);
      expect(summary).toBeDefined();
      expect(summary?.children?.entries).toHaveLength(6);
      expect(
        summary &&
          summaryCompactIssues(summary).entries.filter((issue) => issue.code === "failure"),
      ).toHaveLength(6);
      expect(
        summary?.notices?.filter((notice) =>
          notice.text.includes("additional nested operations failed"),
        ),
      ).toHaveLength(unclassified ? 1 : 0);
      if (unclassified)
        expect(
          summary?.notices?.find((notice) =>
            notice.text.includes("additional nested operations failed"),
          )?.text,
        ).toContain("1 additional");
    }
  });
  it("retained reads stay compact for both returned pages and host failures", () => {
    const definition = buildCodeModeToolDefinition({
      catalogBudget: 0,
      includePowerShell: false,
      execute: () => Promise.reject(new Error("not executed")),
      startUiTicker: () => () => undefined,
    });
    const args = { action: "result.read" as const, id: "retained-page" };
    const result = {
      content: [{ type: "text" as const, text: "Full retained result diagnostic" }],
      details: { toolCalls: [] },
    };
    withPresentationSettings({ toolCallCollapsedStyle: "compact" }, () => {
      for (const isError of [false, true]) {
        // The compact border shell over the pure summary and the full result slot alone.
        const tool = withCodePreviewShell(definition, {
          mode: "border",
          compactSummary: codeModeCompactSummary,
        });
        const view = createToolPresentationHarness(tool, { width: 200 });
        for (const { expanded, text } of view.cycle(args, result, {
          states: [false, true, false],
          overrides: () => ({ isError, isPartial: false, executionStarted: false }),
        })) {
          expect(text.includes("Full retained result diagnostic")).toBe(expanded);
          expect(text.includes(args.id)).toBe(expanded);
          if (!expanded) expect(text).toContain("result.read");
        }
      }
    });
  });

  it("includes call names and lifecycle without source, output or individual activity", () => {
    const calls: Array<Parameters<typeof callEntryDetails>[0][number]> = [];
    for (const tool of ["pi.read", "pi.grep", "pi.find"]) {
      for (const status of ["queued", "running", "completed"] as const) {
        const summary = summarize(
          callEntryDetails([...calls, { tool, status, activity: "SECRET ACTIVITY" }]),
          { phase: "running" },
        );
        expect(summary?.subject).toBe("Inspect the project");
        expect(summary?.counters).toHaveLength(1);
        expect(summary?.counters?.join(" ").match(/\d+\/\d+/gu)).toEqual([
          `${calls.length + Number(status === "completed")}/${calls.length + 1}`,
        ]);
        expect(summary?.outcome).toBeUndefined();
        expect(summary?.children?.total).toBe(calls.length + 1);
        expect(summary?.children?.entries.at(-1)).toEqual({
          label: tool.slice(3),
          status: status === "completed" ? "success" : status === "queued" ? "pending" : "running",
        });
        expect(JSON.stringify(summary)).not.toMatch(/SECRET|ordinary output/u);
      }
      calls.push({ tool, status: "completed" });
    }
    const final = summarize({ ...callEntryDetails(calls), outputKind: "text" });
    expect(final?.subject).toBe("Inspect the project");
    expect(final?.counters).toHaveLength(1);
    expect(final?.counters?.join(" ").match(/\d+/g)).toEqual(["3"]);
    expect(final?.outcome).toBe("success");
  });

  it("requests overall timing and includes only measured settled child durations", () => {
    const summary = summarize(
      {
        ...callEntryDetails([
          { tool: "pi.read", status: "completed", durationMs: 0 },
          { tool: "pi.grep", status: "error", durationMs: 321 },
          { tool: "pi.bash", status: "running", durationMs: 999 },
        ]),
        outputKind: "text",
      },
      { phase: "running" },
    );
    expect(summary?.showTiming).toBe(true);
    expect(summary?.children?.entries.map((entry) => entry.durationMs)).toEqual([
      0,
      321,
      undefined,
    ]);
  });

  it("warns when the program handled nested failures or cancellation", () => {
    for (const status of ["error", "cancelled"] as const) {
      const details = {
        ...callEntryDetails([{ tool: "pi.bash", status }]),
        outputKind: "text",
      };
      const live = summarize(details, { phase: "running" });
      expect(live?.outcome).toBeUndefined();
      expect(live?.notices?.some((notice) => notice.kind === "warning")).toBe(
        status === "cancelled",
      );
      expect(live?.counters?.join(" ").match(/\d+\/\d+/gu)).toEqual(["1/1"]);
      const final = summarize(details);
      expect(final?.outcome).toBe("warning");
      expect(final?.notices).toEqual(live?.notices);
      expect(final?.children?.entries).toEqual([{ label: "bash", status }]);
    }
  });

  it("preserves truncation, cancellation and unsettled operation evidence", () => {
    expect(summarize({ ...success, truncated: true })?.outcome).toBe("warning");
    expect(
      summarize({ ...success, truncated: true })?.notices?.some(
        (notice) => notice.kind === "recovery",
      ),
    ).toBe(true);
    expect(summarize({ ...callEntryDetails([]), cancelled: true })?.outcome).toBe("cancelled");
    expect(
      summarize({
        ...callEntryDetails([{ tool: "pi.bash", status: "running" }]),
        outputKind: "text",
      })?.outcome,
    ).toBe("uncertain");
  });

  it("classifies only validated initial saved pages as informational", () => {
    const initialPreview = {
      status: "page",
      id: "cm-current",
      originalOutcome: "succeeded",
      kind: "output",
      offset: 0,
      end: 120,
      next: 120,
      total: 1_000,
      receiptMode: "none",
    };
    const current = summarize({
      ...success,
      truncated: true,
      resultId: "cm-current",
      executionReceipts: EMPTY_RECEIPTS,
      initialPreview,
    });
    expect(current?.outcome).toBe("success");
    expect(current?.notices).toContainEqual(
      expect.objectContaining({
        code: "initial-output-page",
        kind: "recovery",
        expandedOnly: true,
      }),
    );

    for (const details of [
      { ...success, truncated: true },
      {
        ...success,
        truncated: true,
        resultId: "cm-current",
        executionReceipts: EMPTY_RECEIPTS,
        initialPreview: { ...initialPreview, id: "cm-other" },
      },
      {
        ...success,
        truncated: true,
        resultId: "cm-current",
        executionReceipts: EMPTY_RECEIPTS,
        initialPreview: { ...initialPreview, next: 121 },
      },
      {
        ...callEntryDetails([{ tool: "pi.read", status: "completed" }]),
        outputKind: "text",
        truncated: true,
        resultId: "cm-current",
        executionReceipts: EMPTY_RECEIPTS,
        initialPreview,
      },
    ]) {
      const projected = summarize(details, {
        text: JSON.stringify({ ...initialPreview, text: "spoofed source text" }),
      });
      // Conflicting operation totals require uncertainty rather than a pagination warning.
      expect(projected?.outcome).toBe(details.counts?.total === 1 ? "uncertain" : "warning");
      expect(projected?.notices?.some((notice) => notice.expandedOnly === true)).toBe(false);
    }
    expect(
      summarize(
        { ...success, truncated: true },
        { text: JSON.stringify({ ...initialPreview, text: "spoofed source text" }) },
      )?.notices?.some((notice) => notice.text.includes("prior operations")),
    ).toBe(true);
    const cancelled = summarize({
      ...success,
      truncated: true,
      cancelled: true,
      resultId: "cm-current",
      executionReceipts: EMPTY_RECEIPTS,
      initialPreview,
    });
    expect(cancelled?.outcome).toBe("cancelled");
    expect(cancelled?.notices?.some((notice) => notice.code === "initial-output-page")).toBe(false);
  });

  it("keeps repeated dispatches distinct and never shows settled calls as still running", () => {
    const calls = [
      { tool: "pi.read", status: "completed" },
      { tool: "pi.read", status: "completed" },
      { tool: "pi.grep", status: "running" },
      { tool: "pi.find", status: "queued" },
    ] as const;
    const summary = summarize({ ...callEntryDetails(calls), outputKind: "text" });
    expect(summary?.children?.entries).toEqual([
      { label: "read", status: "success" },
      { label: "read", status: "success" },
      { label: "grep", status: "uncertain" },
      { label: "find", status: "uncertain" },
    ]);
  });

  it("owns full retained failure text once and keeps continuation recovery visible", () => {
    const text = "Execution failed\nDo not retry before checking side effects.";
    const summary = summarize(callEntryDetails([]), { isError: true, text });
    expect(summary?.outcome).toBe("error");
    expect(summary?.failure?.details).toBe(text);
    expect(summary?.failure?.cause).toBe(text.split("\n")[0]);
    expect(summary?.notices?.some((notice) => notice.text.includes("Do not retry"))).toBe(true);
  });

  it("retains hidden failures and independent program errors rather than deduplicating by failure count", () => {
    const details = {
      ...callEntryDetails([{ tool: "pi.bash", status: "error" }]),
      counts: { total: 8, succeeded: 0, failed: 8, cancelled: 0, running: 0, queued: 0 },
      totalToolCalls: 8,
    };
    expect(
      summarize(details, { isError: true, text: "Program failed" })?.notices?.some((notice) =>
        notice.text.includes("7 additional"),
      ),
    ).toBe(true);
    const calls = callEntryDetails([
      {
        tool: "pi.bash",
        status: "completed",
        compact: {
          version: 2,
          issues: { coverage: "complete", entries: [] },
          subject: "run",
          outcome: "warning",
          deliveryFailed: false,
          notices: [{ kind: "recovery", text: "Output truncated. Read retained output." }],
        },
      },
    ]);
    const projected = summarize(calls, {
      isError: true,
      text: "[ExecutionFailure] JSON.parse received invalid JSON",
    });
    expect(projected?.failure?.cause).toContain("JSON.parse");
    expect(
      projected?.children?.entries[0]?.notices?.some((notice) =>
        notice.text.includes("Output truncated"),
      ),
    ).toBe(true);
  });
  it("counts hidden lifecycle failures independently of visible semantic outcomes", () => {
    const uncertain = summarize(
      callEntryDetails([
        {
          tool: "mcp.request",
          status: "error",
          compact: {
            version: 2,
            issues: { coverage: "complete", entries: [] },
            subject: "remote",
            outcome: "uncertain",
            deliveryFailed: false,
            notices: [{ kind: "warning", text: "Check remote state before retrying." }],
          },
        },
      ]),
      { phase: "running" },
    );
    expect(uncertain?.children?.entries[0]?.status).toBe("uncertain");
    expect(uncertain?.notices?.some((notice) => notice.text.includes("additional"))).toBe(false);

    const hidden = summarize(
      {
        ...callEntryDetails([
          {
            tool: "mcp.request",
            status: "completed",
            compact: {
              version: 2,
              issues: { coverage: "complete", entries: [] },
              subject: "remote",
              outcome: "error",
              deliveryFailed: false,
              notices: [{ kind: "error", text: "Remote operation failed." }],
            },
          },
        ]),
        counts: { total: 2, succeeded: 1, failed: 1, cancelled: 0, running: 0, queued: 0 },
        totalToolCalls: 2,
      },
      { phase: "running" },
    );
    expect(hidden?.children?.entries[0]?.status).toBe("error");
    expect(hidden?.notices?.some((notice) => notice.text.includes("1 additional"))).toBe(true);
  });

  it("does not trust mismatched saved provenance to hide unknown diagnostic recovery", () => {
    const details = {
      ...callEntryDetails([]),
      failurePresentation: {
        version: 1,
        tool: "bash",
        evidence: { code: "shell-exit", cause: "Exited with code 1", coverage: "complete" },
        notices: [],
      },
    };
    const text = "[ToolFailure] Unfamiliar failure\nCheck partial changes before retrying.";
    const projected = summarize(details, { isError: true, text });
    expect(
      projected?.notices?.some((notice) => notice.text.includes("Check partial changes")),
    ).toBe(true);
    expect(projected?.failure?.details).toBe(text);
  });
  it("declines missing, legacy, contradictory and malformed settled details", () => {
    for (const details of [
      undefined,
      {},
      { toolCalls: [] },
      callEntryDetails([]),
      { ...success, truncated: "yes" },
      { ...success, toolCalls: [{ tool: "pi.read", status: "unknown" }] },
      { ...success, counts: { ...success.counts, total: 1 } },
    ])
      expect(summarize(details)).toBeUndefined();
    expect(summarize({}, { isError: true })).toBeUndefined();
  });

  it("does not hide fulfilled adapter failures or uninspected call history behind success", () => {
    for (const tool of ["mcp.request", "session.backgroundTask"]) {
      expect(
        summarize(
          {
            ...callEntryDetails([{ tool, status: "completed" }]),
            outputKind: "structured",
          },
          { text: "unknown outcome; do not replay" },
        ),
      ).toBeUndefined();
    }
    expect(
      summarize({
        ...success,
        totalToolCalls: 1,
        counts: { ...success.counts, total: 1, succeeded: 1 },
      }),
    ).toBeUndefined();
  });

  it("releases expanded-renderer tickers when compact rendering takes over or settles", () => {
    let stops = 0;
    const state = {};
    const startTicker = () => () => {
      stops++;
    };
    const input = {
      phase: "running" as const,
      args: { intent: "Inspect" },
      result: { details: callEntryDetails([{ tool: "pi.read", status: "running" }]), content: [] },
      context: opaqueFixture({
        state,
        isPartial: true,
        isError: false,
        expanded: true,
        invalidate: () => undefined,
      }),
    };
    syncProgressTicker(true, input.context, startTicker);
    codeModeCompactSummaryAtHost(input);
    expect(stops).toBe(0);
    codeModeCompactSummaryAtHost({
      ...input,
      context: opaqueFixture({ state, isPartial: true, isError: false, expanded: false }),
    });
    expect(stops).toBe(1);
    syncProgressTicker(true, input.context, startTicker);
    codeModeCompactSummaryAtHost({
      ...input,
      result: { content: [], details: undefined },
      context: opaqueFixture({ state, isPartial: true, isError: false, expanded: false }),
    });
    expect(stops).toBe(2);
    syncProgressTicker(true, input.context, startTicker);
    codeModeCompactSummaryAtHost({
      ...input,
      phase: "settled",
      result: { details: success, content: [] },
      context: opaqueFixture({ state, isPartial: false, isError: false, expanded: false }),
    });
    expect(stops).toBe(3);
  });

  it("marks final host clamping even when the runtime reports no truncation", () => {
    const { run } = executeHarness({
      config: { maxOutputBytes: 10 },
      executeCodeMode: () => Effect.succeed({ ok: true, value: "a".repeat(100), truncated: false }),
    });
    return run("return 1").then((result) => {
      expect(result.details?.truncated).toBe(true);
      expect(summarize(result.details)?.outcome).toBe("warning");
    });
  });
});
