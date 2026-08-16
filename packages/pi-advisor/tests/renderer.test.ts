import { describe, expect, test, vi } from "vitest";
import {
  ADVISOR_REVIEW_ACTION_TYPE,
  ADVISOR_REVIEW_CARD_TYPE,
  decodeAdvisorReviewAction,
  decodeAdvisorReviewCard,
  makeAdvisorReviewCard,
  renderAdvisorReviewCard,
} from "../src/ui/review-card.ts";
import {
  latestOpenAdvisorReviewCardAtHostBoundary,
  registerAdvisorReviewCardRendererAtHostBoundary,
} from "../src/boundary/host-review-cards.ts";

const review = {
  verdict: "revise" as const,
  summary: "A material issue remains.",
  suggestions: [],
  findings: [
    {
      category: "correctness" as const,
      severity: "blocker" as const,
      confidence: "high" as const,
      evidenceBasis: "direct" as const,
      id: "af_deadbeefdeadbeefdeadbeefdeadbeef",
      status: "open" as const,
      issue: "The result is wrong.",
      evidence: "The test reports a mismatch.",
      recommendation: "Correct the implementation.",
    },
  ],
};
// SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
const theme = {
  bold: (value: string) => value,
  fg: (_name: string, value: string) => value,
} as never;

describe("Advisor local review cards", () => {
  test("creates a bounded strict v1 card without hidden metadata", () => {
    const card = makeAdvisorReviewCard("arc_test", review)!;
    expect(card).toEqual({
      version: 1,
      cardId: "arc_test",
      kind: "issues",
      summary: "A material issue remains.",
      items: [
        {
          issue: "The result is wrong.",
          evidence: "The test reports a mismatch.",
          suggestedFix: "Correct the implementation.",
        },
      ],
    });
    expect(JSON.stringify(card)).not.toMatch(
      /provider|model|verdict|confidence|category|status|af_/,
    );
  });

  test("redacts secrets and strips terminal controls before persistence", () => {
    const unsafe = {
      ...review,
      summary: "token=secret-value\u001b[31m",
      findings: [{ ...review.findings[0]!, issue: "bad\u0007issue" }],
    };
    const card = makeAdvisorReviewCard("arc_safe", unsafe)!;
    expect(JSON.stringify(card)).not.toContain("secret-value");
    expect(JSON.stringify(card)).not.toContain("\\u001b");
    expect(card.items[0]?.issue).toBe("badissue");
  });

  test("strictly rejects old and malformed render data", () => {
    expect(decodeAdvisorReviewCard({ review, provider: "p", model: "m" })).toBeUndefined();
    expect(
      decodeAdvisorReviewCard({
        version: 1,
        cardId: "arc_x",
        kind: "issues",
        summary: "x",
        items: [],
      }),
    ).toBeUndefined();
    expect(decodeAdvisorReviewAction({ version: 1, cardId: "arc_x", action: "fix" })).toEqual({
      version: 1,
      cardId: "arc_x",
      action: "fix",
    });
    expect(
      decodeAdvisorReviewAction({ version: 0, cardId: "arc_x", action: "fix" }),
    ).toBeUndefined();
    expect(
      decodeAdvisorReviewAction({ version: 1, cardId: "arc_x", action: "fix", extra: true }),
    ).toBeUndefined();
    expect(
      decodeAdvisorReviewCard({
        version: 1,
        cardId: "arc_x",
        kind: "issues",
        summary: "x",
        items: [{ issue: "x", evidence: "y", suggestedFix: "z" }],
        extra: true,
      }),
    ).toBeUndefined();
    expect(
      decodeAdvisorReviewCard({
        version: 1,
        cardId: "arc_x",
        kind: "issues",
        summary: "x".repeat(801),
        items: [{ issue: "x", evidence: "y", suggestedFix: "z" }],
      }),
    ).toBeUndefined();
  });

  test("collapsed and expanded views expose only the approved fields", () => {
    const card = makeAdvisorReviewCard("arc_test", review)!;
    const collapsed = renderAdvisorReviewCard(card, false, theme)!.render(120).join("\n");
    expect(collapsed).toContain("Advisor · 1 issue");
    expect(collapsed).toContain(review.summary);
    expect(collapsed).not.toContain("Evidence:");
    expect(collapsed).toContain("/advisor fix · /advisor dismiss");
    const expanded = renderAdvisorReviewCard(card, true, theme)!.render(120).join("\n");
    expect(expanded).toContain("Evidence: The test reports a mismatch.");
    expect(expanded).toContain("Suggested fix: Correct the implementation.");
    expect(expanded).not.toMatch(/blocker|correctness|confidence|provider|model|af_/i);
  });

  test("restores the latest untombstoned card from the active branch", () => {
    const first = makeAdvisorReviewCard("arc_first", review)!;
    const second = makeAdvisorReviewCard("arc_second", review)!;
    const branch = [
      { id: "1", type: "custom", customType: ADVISOR_REVIEW_CARD_TYPE, data: first },
      {
        id: "2",
        type: "custom",
        customType: ADVISOR_REVIEW_ACTION_TYPE,
        data: { version: 1, cardId: first.cardId, action: "dismiss" },
      },
      { id: "3", type: "custom", customType: ADVISOR_REVIEW_CARD_TYPE, data: second },
    ];
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    const ctx = { sessionManager: { getBranch: () => branch } } as never;
    expect(latestOpenAdvisorReviewCardAtHostBoundary(ctx)).toEqual(second);
    branch.push({
      id: "4",
      type: "custom",
      customType: ADVISOR_REVIEW_ACTION_TYPE,
      data: { version: 1, cardId: second.cardId, action: "fix" },
    });
    expect(latestOpenAdvisorReviewCardAtHostBoundary(ctx)).toBeUndefined();
  });

  test("registers an entry renderer, never a message renderer", () => {
    const pi = { registerEntryRenderer: vi.fn(), registerMessageRenderer: vi.fn() };
    // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
    registerAdvisorReviewCardRendererAtHostBoundary(pi as never);
    expect(pi.registerEntryRenderer).toHaveBeenCalledWith(
      ADVISOR_REVIEW_CARD_TYPE,
      expect.any(Function),
    );
    expect(pi.registerMessageRenderer).not.toHaveBeenCalled();
    expect(ADVISOR_REVIEW_ACTION_TYPE).toBe("pi-advisor-review-action-v1");
  });
});
