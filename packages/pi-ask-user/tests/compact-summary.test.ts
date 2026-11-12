import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
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

/** A call still running, with any progress it reported. */
const live = (
  provider: CompactSummaryProvider,
  args: SummaryInput["args"],
  result?: SummaryInput["result"],
) => provider({ phase: "running", args, result, context: renderContextFixture({}) });

/** The progress a live call reports about where its questions stand. */
const progress = (questionnaire: string) => ({ content: [], details: { questionnaire } });

const pairedAnswers = (label: string) => ({
  outcome: "submitted",
  answers: [
    { key: "store", kind: "choices", labels: [label] },
    { key: "notes", kind: "text", text: "Keep prices in cents" },
  ],
});

const answer = (text: string, note?: string) => ({
  outcome: "submitted",
  answers: [{ key: "library", kind: "custom", text, ...(note && { note }) }],
});
const lone = (label: string) => ({
  outcome: "submitted",
  answers: [{ key: "store", kind: "choices", labels: [label] }],
});

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
  it("carries a lone short answer in its heading and counts the rest", () => {
    const short = summarize(askUserCompactSummary, answer("Keep it"));
    expect(short?.counters).toEqual(["Keep it"]);
    // The answer is a fact about the questions, so a glyph's word never drops it.
    expect(short?.subjectState).toBe(true);
    for (const details of [
      answer(`Keep the current library\n${Str.repeat(40)("more ")}`),
      answer("Keep the current library and pin its version"),
      answer("Keep it", "No upgrade"),
      pairedAnswers("SQLite"),
    ]) {
      const counters = summarize(askUserCompactSummary, details)?.counters ?? [];
      expect(counters).toHaveLength(1);
      expect(counters[0]).toMatch(/^\d+ answers?$/u);
    }
  });
  it("names a lone choice in the heading only when the call actually offered it", () => {
    const args = {
      questions: [
        { key: "store", title: "Store", choices: [{ label: "SQLite" }, { label: "Postgres" }] },
      ],
    };
    expect(summarize(askUserCompactSummary, lone("SQLite"), { args })?.counters).toEqual([
      "SQLite",
    ]);
    const forged = summarize(askUserCompactSummary, lone("Drop the database"), { args });
    expect(Arr.join(forged?.counters ?? [], " ")).not.toContain("Drop the database");
  });
  it("names what a compact row's expansion reveals once answered", () => {
    const args = { questions: [{ key: "library", title: "Library", prompt: "Which?" }] };
    const short = {
      outcome: "submitted",
      answers: [{ key: "library", kind: "text", text: "Intl" }],
    };
    // The heading shows the answer, so expanding reveals the questions; otherwise the answers.
    expect(summarize(askUserCompactSummary, short, { args })?.expandLabel).toBe("questions");
    expect(summarize(askUserCompactSummary, submitted, { args })?.expandLabel).toBe("answers");
    const awaited = { args: { action: "await", requestId: "request-1" } };
    expect(summarize(asyncAskUserCompactSummary, row(), awaited)?.expandLabel).toBe("answers");
    expect(
      summarize(asyncAskUserCompactSummary, row({ outcome: short }), awaited)?.expandLabel,
    ).toBe("details");
  });
  it("classifies failed questionnaires as errors that say no answer was recorded", () => {
    const broken = row({ status: "failed", outcome: undefined, delivery: "none" });
    for (const args of [{}, { action: "await", requestId: "request-1" }]) {
      const summary = summarize(asyncAskUserCompactSummary, broken, { args });
      expect(summary?.outcome).toBe("error");
      expect(summary?.issues).toEqual([expect.objectContaining({ severity: "error" })]);
      // The row's ✗ already says it failed; the issue says what that left undone.
      for (const issue of summary?.issues ?? [])
        expect(issueMessageStyleProblems(issue.message, { severity: issue.severity })).toEqual([]);
    }
    // A status only looks: a failure it finds is a fact in its neutral heading, not a problem line.
    for (const [details, args] of [
      [broken, { action: "status", requestId: "request-1" }],
      [{ requests: [row(), broken] }, { action: "status" }],
    ] as const) {
      const status = summarize(asyncAskUserCompactSummary, details, { args });
      expect(status?.outcome).toBe("returned");
      expect(status?.issues ?? []).toEqual([]);
      expect(Arr.join(status?.counters ?? [], " ")).toContain("failed");
    }
  });
  it("marks questionnaires awaiting answers for attention without overriding failures", () => {
    const pending = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const failed = row({ status: "failed", outcome: undefined, delivery: "none" });
    const status = { action: "status" };
    expect(summarize(asyncAskUserCompactSummary, pending)?.outcome).toBe("attention");
    expect(
      summarize(asyncAskUserCompactSummary, { requests: [row(), pending] }, { args: status })
        ?.outcome,
    ).toBe("attention");
    // A status that finds one waiting on the user asks for it, whatever else it finds.
    expect(
      summarize(asyncAskUserCompactSummary, { requests: [pending, failed] }, { args: status })
        ?.outcome,
    ).toBe("attention");
    expect(summarize(asyncAskUserCompactSummary, failed)?.outcome).toBe("error");
    expect(summarize(asyncAskUserCompactSummary, row())?.outcome).toBe("success");
  });
  it("marks a questionnaire queued behind others as queued, not as needing the user", () => {
    const queued = row({
      status: "pending",
      outcome: undefined,
      delivery: "pending",
      presentation: "queued",
    });
    const open = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const status = { action: "status" };
    expect(summarize(asyncAskUserCompactSummary, queued)?.outcome).toBe("queued");
    expect(
      summarize(asyncAskUserCompactSummary, { requests: [queued, row()] }, { args: status })
        ?.outcome,
    ).toBe("queued");
    expect(
      summarize(asyncAskUserCompactSummary, { requests: [queued, open] }, { args: status })
        ?.outcome,
    ).toBe("attention");
  });
  it("waits on the user only once a call's questions are on screen", () => {
    const args = { questions: [{ key: "library", title: "Library", prompt: "Which?" }] };
    expect(live(askUserCompactSummary, args)?.waiting).toBeUndefined();
    expect(live(askUserCompactSummary, args, progress("open"))?.waiting).toBe(true);
    const awaiting = { action: "await", requestId: "request-1" };
    // An await reads the state its questionnaire reports, not the call's own wait.
    expect(live(asyncAskUserCompactSummary, awaiting)?.waiting).toBeUndefined();
    expect(live(asyncAskUserCompactSummary, awaiting, progress("open"))?.waiting).toBe(true);
    const queued = live(asyncAskUserCompactSummary, awaiting, progress("queued"));
    expect(queued?.waiting).toBeUndefined();
    expect(queued?.queued).toBe(true);
    const hidden = live(asyncAskUserCompactSummary, awaiting, progress("hidden"));
    expect(hidden?.queued).toBeUndefined();
    // A hidden questionnaire says, even collapsed, that the user can bring it back.
    expect(hidden?.issues).toEqual([
      expect.objectContaining({ severity: "attention", code: "questionnaire-hidden" }),
    ]);
    expect(live(asyncAskUserCompactSummary, args)?.waiting).toBeUndefined();
  });
  it("tells the user how to resume hidden questionnaires in a status list", () => {
    const pending = { status: "pending", outcome: undefined, delivery: "pending" } as const;
    const hidden = row({ ...pending, presentation: "hidden" });
    const queued = row({ ...pending, requestId: "request-2", presentation: "queued" });
    const summary = summarize(
      asyncAskUserCompactSummary,
      { requests: [hidden, queued] },
      { args: { action: "status" } },
    );
    expect(summary?.outcome).toBe("attention");
    expect(Arr.map(summary?.issues ?? [], (issue) => [issue.severity, issue.code])).toEqual([
      ["attention", "questionnaire-hidden"],
      ["info", "questionnaire-queued"],
    ]);
    for (const issue of summary?.issues ?? [])
      expect(issueMessageStyleProblems(issue.message)).toEqual([]);
  });
  it("narrows a status list to its pressing state's count before only a total", () => {
    const open = row({ status: "pending", outcome: undefined, delivery: "pending" });
    const queued = row({ ...open, requestId: "request-2", presentation: "queued" });
    const counters =
      summarize(
        asyncAskUserCompactSummary,
        { requests: [open, queued] },
        { args: { action: "status" } },
      )?.counters ?? [];
    const at = (matches: (counter: string) => boolean) =>
      Option.getOrElse(Arr.findFirstIndex(counters, matches), () => -1);
    const pressing = at(
      (counter) => Str.includes("needs your input")(counter) && !Str.includes(" of ")(counter),
    );
    const total = at(Str.includes("questionnaire"));
    expect(pressing).toBeGreaterThanOrEqual(0);
    expect(pressing).toBeLessThan(total);
  });
  it("counts a status list by state only where states differ or still need something", () => {
    const status = { args: { action: "status" } };
    const first = (requests: readonly object[]) =>
      summarize(asyncAskUserCompactSummary, { requests }, status)?.counters?.[0];
    const second = row({ requestId: "request-2" });
    const open = row({ status: "pending", outcome: undefined, delivery: "pending" });
    expect(first([row(), second])).toBe("2 questionnaires");
    expect(first([open])).toContain("needs your input");
    expect(first([open, second])).toMatch(/needs your input.*answered/u);
  });
  it("names a control call's questions by their stored titles, else only by its action", () => {
    const args = { action: "await", requestId: "request-1" };
    const titled = row({ titles: [{ key: "library", title: "Library" }] });
    expect(summarize(asyncAskUserCompactSummary, titled, { args })?.subject).toBe("Library");
    const untitled = summarize(asyncAskUserCompactSummary, row(), { args });
    expect([untitled?.action, untitled?.subject]).toEqual(["await", ""]);
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
    // An open questionnaire's heading says it needs input, so it carries no issue saying so again.
    expect(summarize(asyncAskUserCompactSummary, pending)?.issues).toBeUndefined();
    expect(
      summarize(asyncAskUserCompactSummary, { requests: [pending] }, list)?.issues,
    ).toBeUndefined();
    const summaries = [
      summarize(asyncAskUserCompactSummary, { requests: [pending, queued] }, list),
      summarize(asyncAskUserCompactSummary, queued),
      summarize(asyncAskUserCompactSummary, { requests: [queued, { ...queued }] }, list),
      summarize(asyncAskUserCompactSummary, failed),
      summarize(asyncAskUserCompactSummary, {
        requests: [failed, { ...failed, requestId: "request-2" }],
      }),
      summarize(asyncAskUserCompactSummary, broken),
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
