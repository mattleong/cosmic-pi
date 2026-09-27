import * as Effect from "effect/Effect";
import { describe, expect, it } from "@effect/vitest";
import { resolveCompactSummary, withCodePreviewShell } from "pi-code-previews";
import {
  createToolPresentationHarness,
  issueMessageStyleProblems,
  withPresentationSettings,
} from "pi-code-previews/testing";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { INCOMPLETE_ATTENTION } from "../src/tools/compact-evidence.ts";
import { buildCodeModeToolDefinition } from "../src/tools/controller.ts";
import { codeModeCompactSummary } from "../src/ui/compact-summary.ts";
import {
  codeModeCompactSummaryAtHost,
  syncProgressTicker,
} from "../src/boundary/host-render-ticker.ts";
import { callEntryDetails, type CodeModeCallEntry } from "../src/tools/format.ts";
import { executeHarness } from "./support/execute.ts";
import { ledgerDetails, summarize, withLedger } from "./support/compact.ts";
import { EMPTY_RECEIPTS } from "./support/results.ts";
import { nestedToolDefinitionsFixture } from "./support/tools.ts";

const success = withLedger({ ...callEntryDetails([]), outputKind: "text" as const });
const calls = (entries: readonly CodeModeCallEntry[], ledger = {}) =>
  withLedger({ ...callEntryDetails(entries), outputKind: "text" as const }, ledger);
const receipt = (outcome: "success" | "warning" | "error" | "uncertain", patch = {}) => ({
  version: 3 as const,
  subject: "target",
  outcome,
  issues: [],
  deliveryFailed: false,
  ...patch,
});

describe("Code Mode program issues", () => {
  it.effect("classifies each runtime failure kind from the real runtime envelope", () =>
    Effect.gen(function* () {
      const definitions = nestedToolDefinitionsFixture({
        bash: { execute: () => Promise.reject(new Error("Command exited with code 1")) },
        read: {
          execute: () => Promise.resolve({ content: [{ type: "text", text: "x" }], details: {} }),
        },
      });
      // Each message names the specific fact a reader needs, in the shared issue style.
      for (const [code, config, facts] of [
        ["return (", {}, [/syntax/iu, /line 1\b/u]],
        ["const a = 1;\nconst b = ;", {}, [/syntax/iu, /line 2\b/u]],
        ["class A {}", {}, [/class declaration/u, /line 1\b/u]],
        ["const x = 1;\nnull.foo;", {}, [/'foo'/u, /null/u, /line 2\b/u]],
        ['throw new Error("boom");', {}, [/^boom$/u]],
        ["await tools.pi.nope({});", {}, [/no such tool/u]],
        ["await tools.pi.read({});", {}, [/"path"/u]],
        ["await tools.pi.read({path:'a', file:'b'});", {}, [/"file"/u]],
        ["return () => 1;", {}, [/plain data/u]],
        [
          "await tools.pi.read({path:'a'}); await tools.pi.read({path:'b'});",
          { maxToolCalls: 1 },
          [/\b1-call\b/u],
        ],
        ["while (true) {}", { timeoutMs: 100 }, [/100 ms/u, /line 1\b/u]],
        [
          "await Promise.allSettled([tools.pi.bash({command:'a'}), tools.pi.bash({command:'b'})]); await tools.pi.bash({command:'c'});",
          {},
          [/\bbash\b/u],
        ],
      ] as const) {
        const h = executeHarness({
          definitions,
          cwd: "/project",
          retainFailureDetails: true,
          config,
        });
        const text = yield* Effect.promise(() =>
          h.run(code).then(
            () => expect.unreachable(code),
            (error: Error) => error.message,
          ),
        );
        const summary = summarize(h.retention.consume("call"), { isError: true, text });
        expect(summary?.outcome, code).toBe("error");
        // Exactly one line explains the stop: the run's own, or the row of the call that caused it.
        const explained = [
          ...(summary?.issues ?? []),
          ...(summary?.children?.entries.flatMap((child) =>
            (child.issues ?? []).filter((issue) => issue.message.endsWith("stopped the program")),
          ) ?? []),
        ];
        expect(explained, code).toHaveLength(1);
        const issue = explained[0]!;
        expect(issue.severity, code).toBe("error");
        for (const fact of facts) expect(issue.message, code).toMatch(fact);
        expect(issueMessageStyleProblems(issue.message), `${code}: ${issue.message}`).toEqual([]);
        // Pi's error flag adds nothing once the producer has explained the failure.
        expect(resolveCompactSummary(summary, "settled", true, text)?.issues).toEqual(
          summary?.issues,
        );
      }
      // An unhandled failure of one visible call is explained on that call's row.
      const h = executeHarness({ definitions, cwd: "/project", retainFailureDetails: true });
      const text = yield* Effect.promise(() =>
        h.run("await tools.pi.bash({command:'npm test'});").then(
          () => expect.unreachable(),
          (error: Error) => error.message,
        ),
      );
      const summary = summarize(h.retention.consume("call"), { isError: true, text });
      expect(summary?.outcome).toBe("error");
      expect(summary?.issues).toEqual([]);
      const row = summary?.children?.entries[0]?.issues?.[0]?.message ?? "";
      expect(row).toMatch(/code 1.*stopped the program/u);
      expect(issueMessageStyleProblems(row)).toEqual([]);
    }),
  );

  it.effect("keeps the supported-syntax summary out of the message but in the agent text", () =>
    Effect.gen(function* () {
      const h = executeHarness({ cwd: "/project", retainFailureDetails: true });
      const text = yield* Effect.promise(() =>
        h.run("class A {}").then(
          () => expect.unreachable(),
          (error: Error) => error.message,
        ),
      );
      expect(text).toMatch(/\nSupported orchestration syntax: /u);
      expect(text).not.toMatch(/\(line 1, col 1\)/u);
      const summary = summarize(h.retention.consume("call"), { isError: true, text });
      expect(summary?.issues?.[0]?.message).not.toMatch(/Supported/u);
    }),
  );

  it("falls back to the first line of unrecognized failure text", () => {
    for (const [text, expected] of [
      ["Execution failed\nDo not retry before checking side effects.", "Execution failed"],
      ["\n  \n[Unknown] odd\u001b[2J failure\nmore", "[Unknown] odd"],
      // Without recorded failure evidence the text is never parsed, only tidied.
      ["[ToolFailure] Nested tool 'bash' failed: gone", "Nested tool 'bash' failed: gone"],
      ["", "The program failed"],
    ] as const) {
      const issues = summarize(success, { isError: true, text })?.issues;
      expect(issues).toHaveLength(1);
      expect(issues?.[0]?.message.startsWith(expected), text).toBe(true);
      expect(issues?.[0]?.message).not.toContain("\n");
      expect(issues?.[0]?.message).not.toContain("\u001b");
    }
  });

  it("marks cancellation, saved output and truncation as program issues", () => {
    const cancelled = summarize({ ...success, cancelled: true }, { isError: true, text: "x" });
    expect(cancelled?.outcome).toBe("cancelled");
    expect(cancelled?.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "cancelled" }),
    ]);
    const truncated = summarize({ ...success, truncated: true });
    expect(truncated?.outcome).toBe("warning");
    expect(truncated?.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "output-truncated" }),
    ]);
    expect(truncated?.issues?.[0]?.detail).toContain("prior operations");
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
    const saved = {
      ...success,
      truncated: true,
      resultId: "cm-current",
      executionReceipts: EMPTY_RECEIPTS,
      initialPreview,
    };
    const current = summarize(saved);
    expect(current?.outcome).toBe("success");
    expect(current?.issues).toEqual([
      expect.objectContaining({ severity: "info", code: "saved-output" }),
    ]);
    expect(current?.issues?.[0]?.detail).toContain('id="cm-current" offset=120');

    for (const details of [
      { ...success, truncated: true },
      { ...saved, initialPreview: { ...initialPreview, id: "cm-other" } },
      { ...saved, initialPreview: { ...initialPreview, next: 121 } },
      { ...saved, executionReceipts: { ...EMPTY_RECEIPTS, total: 1, completed: 1 } },
      {
        ...calls([{ tool: "pi.read", status: "completed" }]),
        truncated: true,
        resultId: "cm-current",
        executionReceipts: EMPTY_RECEIPTS,
        initialPreview,
      },
    ]) {
      // Model-visible page text never substitutes for producer page metadata.
      const projected = summarize(details, {
        text: JSON.stringify({ ...initialPreview, text: "spoofed source text" }),
      });
      expect(projected?.outcome).toBe("warning");
      expect(projected?.issues?.map((issue) => issue.code)).toEqual(["output-truncated"]);
    }
    const cancelled = summarize({ ...saved, cancelled: true });
    expect(cancelled?.outcome).toBe("cancelled");
    expect(cancelled?.issues?.some((issue) => issue.code === "saved-output")).toBe(false);
  });

  it("reports problems on calls that are no longer listed", () => {
    const listed = { tool: "pi.read", status: "completed" as const, compact: receipt("warning") };
    const summary = summarize(calls([listed], { warnings: 3 }));
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "unlisted-problems" }),
    ]);
    expect(summary?.issues?.[0]?.message).toMatch(/^2 earlier calls/u);
    expect(summarize(calls([listed], { warnings: 1 }))?.issues).toEqual([]);
  });

  it("reports an incomplete ledger once, unless unsettled calls already explain it", () => {
    const incomplete = summarize(
      calls([{ tool: "pi.read", status: "completed" }], { incomplete: true }),
    );
    expect(incomplete?.outcome).toBe("warning");
    expect(incomplete?.issues).toEqual([
      expect.objectContaining({ severity: "warning", code: "incomplete" }),
    ]);
    expect(incomplete?.issues?.[0]?.detail).toBe(INCOMPLETE_ATTENTION);
    const unsettled = summarize(
      calls([{ tool: "pi.read", status: "running" }], { incomplete: true }),
    );
    expect(unsettled?.outcome).toBe("uncertain");
    expect(unsettled?.issues).toEqual([]);
    expect(unsettled?.children?.entries[0]?.issues).toHaveLength(1);
    // Interrupted calls settle as cancelled; their rows already explain the missing receipts.
    const interrupted = summarize(
      withLedger(
        {
          ...callEntryDetails([
            { tool: "pi.read", status: "completed" },
            { tool: "pi.bash", status: "cancelled" },
          ]),
          outputKind: "text" as const,
        },
        { incomplete: true },
      ),
    );
    expect(interrupted?.issues?.some((issue) => issue.code === "incomplete")).toBe(false);
  });
});

describe("Code Mode issue style", () => {
  it("writes every program and call issue in the shared style", () => {
    const listed = { tool: "pi.read", status: "completed" as const, compact: receipt("warning") };
    const delivered = ledgerDetails(
      [{ tool: "pi.read", summary: { subject: "a.ts", outcome: "success" } }],
      { deliveryFailures: 1 },
    ).details;
    const summaries = [
      summarize({ ...success, cancelled: true }, { isError: true, text: "Execution cancelled." }),
      summarize({ ...success, truncated: true }),
      summarize(calls([listed], { warnings: 3 })),
      summarize(calls([{ tool: "pi.read", status: "completed" }], { incomplete: true })),
      summarize(calls([{ tool: "pi.read", status: "running" }], { incomplete: true })),
      summarize(calls([{ tool: "pi.read", status: "queued" }], { incomplete: true })),
      summarize(delivered),
    ];
    const messages = summaries.flatMap((summary) => [
      ...(summary?.issues ?? []),
      ...(summary?.children?.entries.flatMap((child) => child.issues ?? []) ?? []),
    ]);
    expect(messages.length).toBeGreaterThanOrEqual(summaries.length);
    for (const { message } of messages)
      expect(issueMessageStyleProblems(message), message).toEqual([]);
  });
});

describe("Code Mode compact outcomes", () => {
  it("derives the run outcome without letting nested calls make it an error", () => {
    for (const [name, details, outcome] of [
      ["clean run", calls([{ tool: "pi.read", status: "completed" }]), "success"],
      ["handled failure", calls([{ tool: "pi.bash", status: "error" }]), "warning"],
      ["cancelled call", calls([{ tool: "pi.bash", status: "cancelled" }]), "warning"],
      [
        "failed receipt",
        calls([{ tool: "pi.bash", status: "completed", compact: receipt("error") }], { errors: 1 }),
        "warning",
      ],
      [
        "warning receipt",
        calls([{ tool: "pi.read", status: "completed", compact: receipt("warning") }], {
          warnings: 1,
        }),
        "warning",
      ],
      [
        "row warning without ledger attention",
        calls([
          {
            tool: "pi.read",
            status: "completed",
            compact: receipt("success", {
              issues: [{ severity: "warning", code: "partial", message: "Partial" }],
            }),
          },
        ]),
        "warning",
      ],
      [
        "informational issue",
        calls([
          {
            tool: "pi.read",
            status: "completed",
            compact: receipt("success", {
              issues: [{ severity: "info", code: "page", message: "Showing lines 1-2" }],
            }),
          },
        ]),
        "success",
      ],
      ["settled uncertain receipt", calls([], { uncertain: 1 }), "warning"],
      ["evicted cancellation", calls([], { cancelled: 1 }), "warning"],
      ["still running at settlement", calls([{ tool: "pi.bash", status: "running" }]), "uncertain"],
      ["never started", calls([{ tool: "pi.bash", status: "queued" }]), "uncertain"],
    ] as const) {
      const summary = summarize(details);
      expect(summary?.outcome, name).toBe(outcome);
      expect(
        summary?.issues?.some((issue) => issue.severity === "error"),
        name,
      ).toBe(false);
    }
    const failed = summarize(calls([{ tool: "pi.bash", status: "error" }]), {
      isError: true,
      text: "[ExecutionFailure] Uncaught: boom",
    });
    expect(failed?.outcome).toBe("error");
  });

  it("keeps a warning whose call is no longer retained", () => {
    const { details } = ledgerDetails(
      Array.from({ length: 40 }, (_, id) => ({
        tool: "pi.read",
        summary: {
          subject: `file-${id}`,
          outcome: id === 0 ? ("warning" as const) : ("success" as const),
          ...(id === 0 && {
            issues: [{ severity: "warning" as const, code: "partial", message: "Partial read" }],
          }),
        },
      })),
    );
    const summary = summarize(details);
    expect(summary?.children?.total).toBe(40);
    expect(summary?.children?.entries.some((child) => child.subject === "file-0")).toBe(false);
    expect(summary?.outcome).toBe("warning");
  });

  it("maps call rows to receipts, delivery and lifecycle", () => {
    const entries: CodeModeCallEntry[] = [
      { tool: "pi.read", status: "completed" },
      { tool: "pi.read", status: "completed", compact: receipt("warning") },
      { tool: "mcp.request", status: "error", compact: receipt("uncertain") },
      {
        tool: "pi.write",
        status: "error",
        compact: receipt("success", { deliveryFailed: true }),
      },
      {
        tool: "mcp.request",
        status: "completed",
        compact: receipt("uncertain", { deliveryFailed: true }),
      },
      { tool: "session.backgroundTask", status: "completed", compact: receipt("success") },
      { tool: "session.backgroundTask", status: "completed" },
      { tool: "pi.bash", status: "cancelled" },
      { tool: "pi.grep", status: "running" },
      { tool: "pi.find", status: "queued" },
    ];
    const settled = summarize(calls(entries))!.children!.entries;
    expect(settled.map((child) => [child.label, child.status])).toEqual([
      ["read", "returned"],
      ["read", "warning"],
      ["mcp", "uncertain"],
      ["write", "error"],
      ["mcp", "uncertain"],
      ["background_task", "success"],
      ["session.backgroundTask", "returned"],
      ["bash", "cancelled"],
      ["grep", "uncertain"],
      ["find", "uncertain"],
    ]);
    expect(settled.slice(0, 8).every((child) => child.issues === undefined)).toBe(true);
    expect(settled[8]?.issues).toEqual([
      expect.objectContaining({ severity: "warning", message: "May still be running" }),
    ]);
    expect(settled[9]?.issues).toEqual([
      expect.objectContaining({ severity: "warning", message: "Did not start" }),
    ]);
    const live = summarize(calls(entries), { phase: "running" })!.children!.entries;
    expect(live.slice(8).map((child) => [child.status, child.issues])).toEqual([
      ["running", undefined],
      ["pending", undefined],
    ]);
  });

  it("includes call names and lifecycle without source, output or individual activity", () => {
    const history: CodeModeCallEntry[] = [];
    for (const tool of ["pi.read", "pi.grep", "pi.find"]) {
      for (const status of ["queued", "running", "completed"] as const) {
        const summary = summarize(
          calls([...history, { tool, status, activity: "SECRET ACTIVITY" }]),
          { phase: "running" },
        );
        expect(summary?.subject).toBe("Inspect the project");
        // The first counter is preferred; the second is its shorter narrow-row fallback.
        const progress = `${history.length + Number(status === "completed")}/${history.length + 1}`;
        expect(summary?.counters?.[0]?.startsWith(`${progress} call`)).toBe(true);
        expect(summary?.counters?.at(-1)).toBe(progress);
        expect(summary?.outcome).toBeUndefined();
        expect(summary?.children?.total).toBe(history.length + 1);
        expect(summary?.children?.entries.at(-1)).toEqual({
          label: tool.slice(3),
          status: status === "completed" ? "returned" : status === "queued" ? "pending" : "running",
        });
        expect(JSON.stringify(summary)).not.toMatch(/SECRET|ordinary output/u);
      }
      history.push({ tool, status: "completed" });
    }
    const final = summarize(calls(history));
    expect(final?.subject).toBe("Inspect the project");
    expect(final?.counters?.join(" ").match(/\d+/gu)).toEqual(["3"]);
    expect(final?.outcome).toBe("success");
    const mixed = summarize(
      calls([
        { tool: "pi.read", status: "completed" },
        { tool: "pi.bash", status: "error" },
        { tool: "pi.bash", status: "cancelled" },
      ]),
    );
    expect(mixed?.counters?.[0]).toMatch(/3 calls.*1 failed.*1 cancelled/u);
    // Narrow rows fall back to the problem counts alone.
    expect(mixed?.counters?.[1]).toMatch(/^1 failed.*1 cancelled$/u);
    expect(summarize(success)?.counters).toEqual([]);
  });

  it("requests overall timing and includes only measured settled child durations", () => {
    const summary = summarize(
      calls([
        { tool: "pi.read", status: "completed", durationMs: 0 },
        { tool: "pi.grep", status: "error", durationMs: 321 },
        { tool: "pi.bash", status: "running", durationMs: 999 },
        { tool: "pi.bash", status: "queued", durationMs: 999 },
      ]),
      { phase: "running" },
    );
    expect(summary?.showTiming).toBe(true);
    expect(summary?.children?.entries.map((entry) => entry.durationMs)).toEqual([
      0,
      321,
      undefined,
      undefined,
    ]);
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
      content: [{ type: "text" as const, text: "Full retained result diagnostic\nSECOND_LINE" }],
      details: { toolCalls: [] },
    };
    withPresentationSettings({ toolCallCollapsedStyle: "compact" }, () => {
      for (const isError of [false, true]) {
        const tool = withCodePreviewShell(definition, {
          mode: "border",
          compactSummary: codeModeCompactSummary,
        });
        const view = createToolPresentationHarness(tool, { width: 200 });
        for (const { expanded, text } of view.cycle(args, result, {
          states: [false, true, false],
          overrides: () => ({ isError, isPartial: false, executionStarted: false }),
        })) {
          // A failure explains itself with its first line; the rest waits for expansion.
          expect(text.includes("Full retained result diagnostic")).toBe(expanded || isError);
          expect(text.includes("SECOND_LINE")).toBe(expanded);
          if (!expanded) expect(text).toContain("result.read");
        }
      }
    });
  });

  it("declines missing, legacy, contradictory and malformed settled details", () => {
    const legacyLedger = {
      version: 2,
      admitted: 0,
      started: 0,
      unsupported: 0,
      observed: 0,
      errors: 0,
      warnings: 0,
      cancelled: 0,
      uncertain: 0,
      incomplete: false,
      notices: [],
      issues: { coverage: "complete", entries: [] },
    };
    expect(summarize(success)?.outcome).toBe("success");
    for (const details of [
      undefined,
      {},
      { toolCalls: [] },
      { ...callEntryDetails([]), outputKind: "text" },
      { ...success, compactAttention: legacyLedger },
      { ...success, compactAttention: { ...success.compactAttention, version: 4 } },
      { ...success, truncated: "yes" },
      { ...success, toolCalls: [{ tool: "pi.read", status: "unknown" }] },
      { ...success, counts: { ...success.counts, total: 1 } },
      { ...success, outputKind: undefined },
    ])
      expect(summarize(details)).toBeUndefined();
    for (const details of [{}, { ...success, compactAttention: legacyLedger }])
      expect(summarize(details, { isError: true, text: "boom" })).toBeUndefined();
    // Running rows need the same current ledger as settled ones.
    expect(
      summarize(callEntryDetails([{ tool: "pi.read", status: "running" }]), { phase: "running" }),
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
      const summary = summarize(result.details);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.issues?.map((issue) => issue.code)).toContain("output-truncated");
    });
  });
});
