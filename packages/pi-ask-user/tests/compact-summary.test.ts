import { describe, expect, it } from "vitest";
import { compactStatus, type CompactSummaryProvider } from "pi-code-previews";
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
        // Waiting is a questionnaire's normal state: the call succeeded, and the counter and one
        // informational issue say what it waits for, with guidance kept for expansion.
        expect(summary?.outcome).toBe("success");
        expect(JSON.stringify([summary?.subject, summary?.counters])).not.toContain("request-1");
        expect(summary?.counters?.[0]).toMatch(presentation === "queued" ? /queued/ : /waiting/);
        expect(summary?.issues).toEqual([
          expect.objectContaining({
            severity: "info",
            detail: expect.stringContaining("ask_user_async_control await"),
          }),
        ]);
        expect(summary?.issues?.[0]?.message).not.toMatch(/ask_user_async_control|request-1/);
      }
    },
  );

  it("does not say a queued questionnaire is waiting for answers", () => {
    const pending = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const [queued, open] = (["queued", "open"] as const).map(
      (presentation) =>
        summarize(asyncAskUserCompactSummary, { ...pending, presentation })?.issues?.[0]?.message,
    );
    expect(queued).toBeDefined();
    expect(queued).not.toBe(open);
  });

  it("counts queued and waiting requests, with shorter alternatives for narrow rows", () => {
    const pending = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const summary = summarize(
      asyncAskUserCompactSummary,
      {
        requests: [
          { ...pending, requestId: "queued-1", presentation: "queued" },
          { ...pending, requestId: "queued-2", presentation: "queued" },
          { ...pending, requestId: "open-1", presentation: "open" },
        ],
      },
      { args: { action: "status" } },
    );
    expect(summary?.outcome).toBe("success");
    expect(summary?.counters?.[0]).toMatch(/2 queued/);
    expect(summary?.counters?.[0]).toMatch(/1 waiting/);
    const lengths = summary?.counters?.map((counter) => counter.length) ?? [];
    expect(lengths.length).toBeGreaterThan(1);
    expect(lengths).toEqual([...lengths].sort((a, b) => b - a));
    // Every pending request shares one wait fact.
    expect(summary?.issues).toEqual([expect.objectContaining({ severity: "info" })]);
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
      expect(summary?.counters?.length).toBeGreaterThan(0);
      expect(JSON.stringify(summary)).not.toMatch(
        /Keep the current library|No upgrade|request-1|delivery-1/,
      );
      expect(details).toEqual(before);
    }
  });

  it("shows only short selected labels verified against the matching question", () => {
    const question = {
      key: "style",
      title: "Preview style",
      choices: [{ label: "Compact" }, { label: "Full" }],
    };
    const answer = { key: "style", kind: "choices", labels: ["Compact"], note: "PRIVATE NOTE" };
    for (const provider of [askUserCompactSummary, asyncAskUserCompactSummary]) {
      for (const sample of [
        { questions: [question], answers: [answer], selected: true },
        {
          questions: [question],
          answers: [{ ...answer, labels: ["Compact", "Full"] }],
          selected: true,
        },
        { questions: [{ title: question.title }], answers: [answer] },
        { questions: [question], answers: [{ ...answer, key: "other" }] },
        { questions: [question], answers: [{ ...answer, labels: ["Unverified"] }] },
        { questions: [question], answers: [{ ...answer, labels: ["Compact", "Unverified"] }] },
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
        expect(summary?.subject).not.toMatch(/Compact|Unverified|LLLL/);
        // Selected labels sit in the counter slot, where other answers show a count or kind.
        if (sample.selected) expect(summary?.counters?.[0]).toContain("Compact");
        else expect(summary?.counters?.join(" ")).not.toMatch(/Compact|Unverified|LLLL/);
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
    expect(summary && compactStatus("settled", summary)).toBe("warning");
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

  it("preserves inconsistent pending replies behind the generic row", () => {
    for (const details of [
      row({ status: "pending", outcome: undefined, presentation: "queued" }),
      row({ status: "failed", outcome: submitted }),
      { requests: [row(), row({ status: "pending", outcome: undefined })] },
    ])
      expect(summarize(asyncAskUserCompactSummary, details)).toBeUndefined();
  });

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

  it("counts metadata-only and empty status lists instead of leaving them unconfirmed", () => {
    const args = { action: "status" };
    const listed = summarize(
      asyncAskUserCompactSummary,
      {
        requests: [
          row({ outcome: undefined, delivery: "sent" }),
          row({ status: "cancelled", outcome: undefined, delivery: "sent" }),
          row({ status: "pending", outcome: undefined, delivery: "pending", presentation: "open" }),
        ],
      },
      { args },
    );
    expect(listed?.outcome).toBe("success");
    expect(listed?.counters?.[0]).toMatch(/1 answered/);
    expect(listed?.counters?.[0]).toMatch(/1 cancelled/);
    expect(JSON.stringify(listed)).not.toContain("request-1");
    const empty = summarize(asyncAskUserCompactSummary, { requests: [] }, { args });
    expect(empty?.outcome).toBe("success");
    expect(empty?.counters?.length).toBeGreaterThan(0);
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
    // Pi's error flag wins over submitted answers; the shell explains it from the error text.
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
