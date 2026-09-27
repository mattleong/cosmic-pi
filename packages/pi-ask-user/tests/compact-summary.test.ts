import { describe, expect, it } from "vitest";
import type { CompactSummaryProvider } from "pi-code-previews";
import { issueMessageStyleProblems, renderContextFixture } from "pi-code-previews/testing";
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
type SummaryInput = Parameters<CompactSummaryProvider>[0];
function summarize<Details>(
  provider: CompactSummaryProvider,
  details: Details,
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
  it("summarizes live transcript args without claiming an answer", () => {
    for (const provider of [askUserCompactSummary, asyncAskUserCompactSummary]) {
      for (const phase of ["pending", "running"] as const) {
        const summary = summarize(provider, undefined, {
          phase,
          args: { questions: [{ title: "Library" }] },
        });
        expect(summary).toBeDefined();
        expect(summary?.outcome).toBeUndefined();
      }
    }
  });

  it.each(["queued", "open", "hidden"])(
    "keeps pending %s state and retrieval guidance",
    (presentation) => {
      const pending = row({
        status: "pending",
        outcome: undefined,
        delivery: "pending",
        presentation,
      });
      for (const details of [pending, { requests: [pending] }]) {
        const summary = summarize(asyncAskUserCompactSummary, details);
        // Waiting is a questionnaire's normal state: success, with guidance kept for expansion.
        expect(summary?.outcome).toBe("success");
        expect(summary?.subject).toBe(pending.requestId);
        expect(summary?.counters).toHaveLength(1);
        expect(summary?.counters?.join(" ")).toContain(
          presentation === "queued" ? "queued" : "awaiting answers",
        );
        expect(summary?.issues).toEqual([
          expect.objectContaining({
            severity: "info",
            code: "answers-pending",
            detail: expect.stringContaining("ask_user_async_control await"),
          }),
        ]);
        expect(summary?.issues?.[0]?.message).not.toMatch(/ask_user_async_control|request-1/);
      }
    },
  );
  it("preserves queued and awaiting counts for mixed pending requests", () => {
    const pending = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const summary = summarize(asyncAskUserCompactSummary, {
      requests: [
        { ...pending, requestId: "queued-1", presentation: "queued" },
        { ...pending, requestId: "queued-2", presentation: "queued" },
        { ...pending, requestId: "open-1", presentation: "open" },
      ],
    });
    expect(summary?.outcome).toBe("success");
    expect(summary?.counters).toHaveLength(1);
    expect(summary?.counters?.join(" ")).toContain("2 queued");
    expect(summary?.counters?.join(" ")).toContain("1 awaiting answers");
    // Every pending request shares one wait fact.
    expect(summary?.issues).toEqual([
      expect.objectContaining({ severity: "info", code: "answers-pending" }),
    ]);
  });

  it.each(["custom", "text"])(
    "compacts %s answers without copying private text into the headline",
    (kind) => {
      const outcome = {
        ...submitted,
        answers: submitted.answers.map((answer) => ({ ...answer, kind })),
      };
      for (const summary of [
        summarize(askUserCompactSummary, outcome),
        summarize(asyncAskUserCompactSummary, row({ outcome })),
        summarize(asyncAskUserCompactSummary, { requests: [row({ outcome })] }),
      ]) {
        expect(summary?.outcome).toBe("success");
        expect(summary?.issues ?? []).toEqual([]);
        expect(JSON.stringify(summary)).not.toContain("Keep the current library");
        expect(JSON.stringify(summary)).not.toContain("No upgrade");
      }
    },
  );

  it("retains request titles at settlement without disclosing answers or delivery IDs", () => {
    for (const provider of [askUserCompactSummary, asyncAskUserCompactSummary]) {
      const details = provider === askUserCompactSummary ? submitted : row();
      const before = structuredClone(details);
      const summary = summarize(provider, details, {
        args: { questions: [{ key: "library", title: "Library" }] },
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
        const summary = summarize(provider, details, { args: { questions: sample.questions } });
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

  it("keeps automatic delivery recovery visible even when answers were submitted", () => {
    const failedDelivery = expect.objectContaining({
      severity: "warning",
      code: "delivery-failed",
      detail: expect.stringContaining("status or await"),
    });
    const summary = summarize(asyncAskUserCompactSummary, row({ delivery: "failed" }));
    expect(summary?.outcome).toBe("warning");
    expect(summary?.issues).toEqual([failedDelivery]);
    expect(summary?.issues?.[0]?.message).not.toMatch(/ask_user_async_control|delivery-1/);
    const cancelledDelivery = summarize(
      asyncAskUserCompactSummary,
      row({ status: "cancelled", outcome: cancelled, delivery: "failed" }),
    );
    expect(cancelledDelivery?.outcome).toBe("cancelled");
    expect(cancelledDelivery?.issues).toEqual([failedDelivery]);
    // Several failed deliveries are one fact with one retrieval procedure.
    const several = summarize(asyncAskUserCompactSummary, {
      requests: [
        row({ delivery: "failed" }),
        row({ requestId: "request-2", deliveryId: "delivery-2", delivery: "failed" }),
      ],
    });
    expect(several?.issues).toEqual([failedDelivery]);
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

  it("bounds compact replay IDs for both single and list snapshots", () => {
    for (const id of ["", "x".repeat(257)]) {
      for (const field of ["requestId", "deliveryId"] as const) {
        const snapshot = row({ [field]: id });
        expect(summarize(asyncAskUserCompactSummary, snapshot)).toBeUndefined();
        expect(summarize(asyncAskUserCompactSummary, { requests: [snapshot] })).toBeUndefined();
      }
    }
    for (const id of ["x", "x".repeat(256)]) {
      expect(summarize(asyncAskUserCompactSummary, row({ requestId: id }))?.outcome).toBe(
        "success",
      );
    }
  });

  it("prefers a valid single snapshot over malformed list data", () => {
    const details = { ...row(), requests: [row({ status: "pending" })] };
    expect(summarize(asyncAskUserCompactSummary, details)?.outcome).toBe("success");
    expect(
      summarize(asyncAskUserCompactSummary, { requests: [row(), row({ delivery: 3 })] }),
    ).toBeUndefined();
    expect(summarize(asyncAskUserCompactSummary, row({ independentWork: 123 }))?.outcome).toBe(
      "success",
    );
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
    expect(summarize(askUserCompactSummary, submitted, { isError: true })).toBeUndefined();
    expect(summarize(asyncAskUserCompactSummary, row(), { isError: true })).toBeUndefined();
    const hostile = Object.defineProperty({}, "outcome", {
      get() {
        throw new Error("untrusted replay getter");
      },
    });
    expect(summarize(askUserCompactSummary, hostile)).toBeUndefined();
    const hostileId = Object.defineProperty(row(), "requestId", {
      get() {
        throw new Error("untrusted replay ID");
      },
    });
    expect(summarize(asyncAskUserCompactSummary, hostileId)).toBeUndefined();
    expect(summarize(asyncAskUserCompactSummary, { requests: [hostileId] })).toBeUndefined();
  });

  it("writes every questionnaire issue message in the shared style", () => {
    const pending = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const failed = row({ delivery: "failed" });
    const summaries = [
      summarize(asyncAskUserCompactSummary, pending),
      summarize(asyncAskUserCompactSummary, {
        requests: [pending, { ...pending, requestId: "request-2" }],
      }),
      summarize(asyncAskUserCompactSummary, failed),
      summarize(asyncAskUserCompactSummary, {
        requests: [failed, { ...failed, requestId: "request-2" }],
      }),
    ];
    const messages = summaries
      .flatMap((summary) => summary?.issues ?? [])
      .map((issue) => issue.message);
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
