import * as Arr from "effect/Array";
import { describe, expect, it } from "vitest";
import type { CompactSummaryProvider } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
import { askUserCompactSummary, asyncAskUserCompactSummary } from "../src/ui/compact-summary.ts";
import { hostile } from "./support/questionnaire.ts";

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
type SummaryInput = Parameters<CompactSummaryProvider>[0];
function summarize(
  provider: CompactSummaryProvider,
  details: NonNullable<SummaryInput["result"]>["details"],
  {
    isError = false,
    args = {},
    phase = "settled",
  }: Partial<Pick<SummaryInput, "args" | "phase"> & { isError: boolean }> = {},
) {
  return provider({
    phase,
    args,
    result: phase === "settled" ? { content: [], details } : undefined,
    context: renderContextFixture({ isError }),
  });
}

describe("questionnaire compact outcome projection", () => {
  it.each([false, true])(
    "never interprets cancellation as approval or replaces its detail (Pi error flag: %s)",
    (isError) => {
      for (const summary of [
        summarize(askUserCompactSummary, cancelled, { isError }),
        summarize(asyncAskUserCompactSummary, row({ status: "cancelled", outcome: cancelled }), {
          isError,
        }),
      ]) {
        expect(summary?.outcome).toBe("cancelled");
        expect(summary?.issues ?? []).toEqual([]);
      }
    },
  );
  it("classifies failed questionnaires as errors that say no answer was recorded", () => {
    for (const [details, args] of [
      [row({ status: "failed", outcome: undefined, delivery: "none" }), {}],
      [
        { requests: [row(), row({ status: "failed", outcome: undefined, delivery: "none" })] },
        { action: "status" },
      ],
    ] as const) {
      const summary = summarize(asyncAskUserCompactSummary, details, { args });
      expect(summary?.outcome).toBe("error");
      expect(summary?.issues).toEqual([expect.objectContaining({ severity: "error" })]);
    }
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
    for (const summary of [
      summarize(askUserCompactSummary, submitted, { isError: true }),
      summarize(asyncAskUserCompactSummary, row(), { isError: true }),
      summarize(asyncAskUserCompactSummary, {}, { isError: true }),
    ]) {
      expect(summary?.outcome).toBe("error");
      expect(summary?.issues ?? []).toEqual([]);
    }
    expect(summarize(askUserCompactSummary, hostile({}, "outcome"))).toBeUndefined();
    const hostileId = hostile(row(), "requestId");
    expect(summarize(asyncAskUserCompactSummary, hostileId)).toBeUndefined();
    expect(summarize(asyncAskUserCompactSummary, { requests: [hostileId] })).toBeUndefined();
  });

  it("writes every questionnaire issue message in the shared style", () => {
    const pending = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const queued = { ...pending, presentation: "queued" };
    const failed = row({ delivery: "failed" });
    const broken = row({ status: "failed", outcome: undefined, delivery: "none" });
    const list = { args: { action: "status" } };
    const summaries = [
      summarize(asyncAskUserCompactSummary, pending),
      summarize(asyncAskUserCompactSummary, queued),
      summarize(asyncAskUserCompactSummary, { requests: [pending] }, list),
      summarize(asyncAskUserCompactSummary, { requests: [queued, { ...queued }] }, list),
      summarize(asyncAskUserCompactSummary, {
        requests: [pending, { ...pending, requestId: "request-2" }],
      }),
      summarize(asyncAskUserCompactSummary, failed),
      summarize(asyncAskUserCompactSummary, {
        requests: [failed, { ...failed, requestId: "request-2" }],
      }),
      summarize(asyncAskUserCompactSummary, broken),
      summarize(asyncAskUserCompactSummary, { requests: [broken, broken] }, list),
    ];
    const messages = Arr.map(
      Arr.flatMap(summaries, (summary) => summary?.issues ?? []),
      (issue) => issue.message,
    );
    expect(messages.length).toBe(summaries.length);
    for (const message of messages)
      expect({
        message,
        problems: issueMessageStyleProblems(message, { forbidden: ["request-1"] }),
      }).toEqual({
        message,
        problems: [],
      });
  });
});
