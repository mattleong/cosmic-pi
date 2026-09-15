import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import { setCodePreviewSettings } from "../../pi-code-previews/src/config/state.ts";
import { defaultCodePreviewSettings } from "../../pi-code-previews/src/config/defaults.ts";
import { registerAskUserTool } from "../src/tools/ask-user.ts";
import { registerAsyncAskUserTools } from "../src/tools/ask-user-async.ts";
import { describe, expect, it } from "vitest";
import type { CompactSummaryProvider } from "pi-code-previews";
import { askUserCompactSummary, asyncAskUserCompactSummary } from "../src/ui/compact-summary.ts";

const submitted = {
  outcome: "submitted",
  answers: [
    { key: "library", kind: "custom", text: "Keep the current library", note: "No upgrade" },
  ],
};
const cancelled = { outcome: "cancelled", answers: [] };
const row = (overrides = {}) => ({
  requestId: "request-1",
  deliveryId: "delivery-1",
  status: "submitted",
  delivery: "waiter",
  outcome: submitted,
  ...overrides,
});
function summarize<Details>(provider: CompactSummaryProvider, details: Details, isError = false) {
  return provider({
    phase: "settled",
    args: {},
    result: { content: [], details },
    // SAFETY: These pure providers read only isError, not Pi's rendering capabilities.
    context: { isError } as Parameters<CompactSummaryProvider>[0]["context"],
  });
}

describe("questionnaire compact outcome projection", () => {
  it("summarizes live transcript args without claiming an answer", () => {
    for (const provider of [askUserCompactSummary, asyncAskUserCompactSummary]) {
      for (const phase of ["pending", "running"] as const) {
        const summary = provider({
          phase,
          args: { questions: [{ title: "Library" }] },
          result: undefined,
          // SAFETY: These providers only read isError from the renderer context.
          context: { isError: false } as Parameters<CompactSummaryProvider>[0]["context"],
        });
        expect(summary).toBeDefined();
        expect(summary?.outcome).toBeUndefined();
      }
    }
  });

  it("summarizes queued admissions and pending status with retrieval guidance", () => {
    const pending = row({
      status: "pending",
      outcome: undefined,
      delivery: "pending",
      presentation: "queued",
    });
    for (const details of [pending, { requests: [pending] }]) {
      const summary = summarize(asyncAskUserCompactSummary, details);
      expect(summary?.outcome).toBe("warning");
      expect(summary?.subject).toBe(pending.requestId);
      expect(
        summary?.notices?.some((notice) => notice.text.includes("ask_user_async_control await")),
      ).toBe(true);
    }
  });
  it("compacts submitted answers without copying private answer text into the headline", () => {
    for (const summary of [
      summarize(askUserCompactSummary, submitted),
      summarize(asyncAskUserCompactSummary, row()),
      summarize(asyncAskUserCompactSummary, { requests: [row()] }),
    ]) {
      expect(summary?.outcome).toBe("success");
      expect(summary?.failure).toBeUndefined();
      expect(JSON.stringify(summary)).not.toContain("Keep the current library");
    }
  });

  it("retains request titles at settlement without disclosing answers or delivery IDs", () => {
    for (const provider of [askUserCompactSummary, asyncAskUserCompactSummary]) {
      const details = provider === askUserCompactSummary ? submitted : row();
      const before = structuredClone(details);
      const summary = provider({
        phase: "settled",
        args: { questions: [{ key: "library", title: "Library" }] },
        result: { content: [], details },
        // SAFETY: These providers only read isError from the renderer context.
        context: { isError: false } as Parameters<CompactSummaryProvider>[0]["context"],
      });
      expect(summary?.subject).toBe("Library");
      expect(summary?.counters).toHaveLength(1);
      expect(JSON.stringify(summary)).not.toMatch(/Keep the current library|No upgrade|delivery-1/);
      expect(details).toEqual(before);
    }
  });

  it("shows only one short selected label verified against the matching question", () => {
    const question = {
      key: "style",
      title: "Preview style",
      choices: [{ label: "Compact" }, { label: "Full" }],
    };
    const answer = { key: "style", kind: "choices", labels: ["Compact"], note: "PRIVATE NOTE" };
    for (const provider of [askUserCompactSummary, asyncAskUserCompactSummary]) {
      for (const sample of [
        { questions: [question], answers: [answer], selected: true },
        { questions: [{ title: question.title }], answers: [answer] },
        { questions: [question], answers: [{ ...answer, key: "other" }] },
        { questions: [question], answers: [{ ...answer, labels: ["Unverified"] }] },
        { questions: [question], answers: [{ ...answer, labels: ["Compact", "Full"] }] },
        { questions: [question, { ...question, key: "other" }], answers: [answer] },
        {
          questions: [question],
          answers: [{ key: "style", kind: "custom", text: "PRIVATE CUSTOM" }],
        },
        {
          questions: [{ ...question, choices: [{ label: "L".repeat(41) }] }],
          answers: [{ ...answer, labels: ["L".repeat(41)] }],
        },
      ]) {
        const outcome = { outcome: "submitted", answers: sample.answers };
        const details = provider === askUserCompactSummary ? outcome : row({ outcome });
        const before = structuredClone(details);
        const summary = provider({
          phase: "settled",
          args: { questions: sample.questions },
          result: { content: [], details },
          // SAFETY: These providers only read isError from the renderer context.
          context: { isError: false } as Parameters<CompactSummaryProvider>[0]["context"],
        });
        expect(summary?.outcome).toBe("success");
        expect(summary?.subject).toContain(question.title);
        if (sample.selected) {
          expect(summary?.subject).toContain("Compact");
          expect(summary?.counters ?? []).toHaveLength(0);
        } else {
          expect(summary?.counters).toHaveLength(1);
          expect(summary?.subject).not.toMatch(/Compact|Unverified|LLLL/);
        }
        expect(JSON.stringify(summary)).not.toMatch(/PRIVATE/);
        expect(details).toEqual(before);
      }
    }
  });

  it("never interprets cancellation as approval or replaces the original cancelled detail", () => {
    for (const summary of [
      summarize(askUserCompactSummary, cancelled),
      summarize(asyncAskUserCompactSummary, row({ status: "cancelled", outcome: cancelled })),
    ]) {
      expect(summary?.outcome).toBe("cancelled");
      expect(summary?.failure).toBeUndefined();
    }
  });

  it("keeps automatic delivery recovery visible even when answers were submitted", () => {
    const summary = summarize(asyncAskUserCompactSummary, row({ delivery: "failed" }));
    expect(summary?.outcome).toBe("warning");
    expect(summary?.notices).toEqual([
      expect.objectContaining({
        kind: "recovery",
        text: expect.stringContaining("status or await"),
      }),
    ]);
    expect(
      summarize(
        asyncAskUserCompactSummary,
        row({ status: "cancelled", outcome: cancelled, delivery: "failed" }),
      )?.outcome,
    ).toBe("cancelled");
  });

  it("preserves inconsistent pending replies, failed openings, and metadata-only terminal lists", () => {
    for (const details of [
      row({ status: "pending", outcome: undefined, presentation: "queued" }),
      row({ status: "failed", outcome: undefined, delivery: "none" }),
      { requests: [row({ outcome: undefined })] },
      { requests: [row(), row({ status: "pending", outcome: undefined })] },
    ])
      expect(summarize(asyncAskUserCompactSummary, details)).toBeUndefined();
  });

  it("declines missing, malformed, inconsistent, and error-marked replies", () => {
    for (const details of [undefined, {}, { outcome: "submitted" }, { ...submitted, answers: [] }])
      expect(summarize(askUserCompactSummary, details)).toBeUndefined();
    for (const details of [
      {},
      row({ status: "pending" }),
      row({ delivery: "unknown" }),
      row({ outcome: { ...submitted, answers: [{ key: "x", kind: "custom", text: 3 }] } }),
      { requests: Array.from({ length: 17 }, () => row()) },
    ])
      expect(summarize(asyncAskUserCompactSummary, details)).toBeUndefined();
    expect(summarize(askUserCompactSummary, submitted, true)).toBeUndefined();
    expect(summarize(asyncAskUserCompactSummary, row(), true)).toBeUndefined();
    const hostile = Object.defineProperty({}, "outcome", {
      get() {
        throw new Error("untrusted replay getter");
      },
    });
    expect(summarize(askUserCompactSummary, hostile)).toBeUndefined();
  });
});

// SAFETY: Only the declared rendering and registration capabilities are used by this test.
const animationFixture = <Value>(value: Value): never => value as never;
interface AnimationCallback {
  tick: (() => void) | undefined;
}

it("uses the registering owner's scheduler and releases it when the call settles", () => {
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
  });
  try {
    const tools: ToolDefinition[] = [];
    const pi: ExtensionAPI = animationFixture({
      registerTool: (tool: ToolDefinition) => tools.push(tool),
      registerMessageRenderer() {},
    });
    const unavailable = () => Promise.reject(new Error("not executed"));
    const animation: AnimationCallback = { tick: undefined };
    let stopped = 0;
    const scheduleAnimation = (_interval: number, callback: () => void) => {
      animation.tick = callback;
      return () => {
        stopped++;
      };
    };
    registerAskUserTool(pi, unavailable, scheduleAnimation);
    registerAsyncAskUserTools(pi, unavailable, unavailable, scheduleAnimation);
    const theme = animationFixture({
      fg: (_color: string, text: string) => text,
      bg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    });
    for (const tool of tools) {
      let invalidated = 0;
      const args =
        tool.name === "ask_user_async_control"
          ? { action: "await", requestId: "request-1" }
          : { questions: [{ title: "Library" }] };
      const context: Parameters<NonNullable<ToolDefinition["renderCall"]>>[2] = animationFixture({
        args,
        state: {},
        toolCallId: tool.name,
        cwd: "/tmp",
        expanded: false,
        executionStarted: true,
        argsComplete: true,
        isPartial: true,
        isError: false,
        invalidate: () => {
          invalidated++;
        },
      });
      tool.renderCall?.(args, theme, context).render(100);
      expect(animation.tick).toBeTypeOf("function");
      animation.tick?.();
      expect(invalidated).toBeGreaterThan(0);
      const before = stopped;
      tool
        .renderResult?.(
          { content: [{ type: "text", text: "done" }], details: undefined },
          { expanded: false, isPartial: false },
          theme,
          { ...context, isPartial: false },
        )
        .render(100);
      expect(stopped).toBeGreaterThan(before);
    }
  } finally {
    setCodePreviewSettings(defaultCodePreviewSettings);
  }
});
