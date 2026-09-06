import { describe, expect, test } from "vitest";
import {
  ADVISOR_REVIEW_ACTION_TYPE,
  ADVISOR_REVIEW_CARD_TYPE,
  decodeAdvisorReviewAction,
  decodeAdvisorReviewCard,
  makeAdvisorReviewCard,
} from "../src/ui/review-card.ts";
import { latestOpenAdvisorReviewCardAtHostBoundary } from "../src/boundary/host-review-cards.ts";

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
const validCard = {
  version: 1 as const,
  cardId: "arc_x",
  kind: "issues" as const,
  summary: "x",
  items: [{ issue: "x", evidence: "y", suggestedFix: "z" }],
};

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
    expect(decodeAdvisorReviewCard({ ...validCard, items: [] })).toBeUndefined();
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
    expect(decodeAdvisorReviewCard({ ...validCard, extra: true })).toBeUndefined();
    expect(decodeAdvisorReviewCard({ ...validCard, summary: "x".repeat(801) })).toBeUndefined();
  });

  test("enforces card bounds at their exact limits", () => {
    const item = {
      issue: "i".repeat(1_200),
      evidence: "e".repeat(1_200),
      suggestedFix: "f".repeat(1_200),
    };
    const bounded = {
      ...validCard,
      cardId: `arc_${"a".repeat(80)}`,
      summary: "s".repeat(800),
      items: Array.from({ length: 5 }, () => item),
    };

    expect(decodeAdvisorReviewCard(bounded)).toEqual(bounded);
    expect(
      decodeAdvisorReviewCard({ ...bounded, cardId: `arc_${"a".repeat(81)}` }),
    ).toBeUndefined();
    expect(
      decodeAdvisorReviewCard({ ...bounded, items: [...bounded.items, item] }),
    ).toBeUndefined();
    expect(
      decodeAdvisorReviewCard({
        ...bounded,
        items: [{ ...item, issue: "i".repeat(1_201) }],
      }),
    ).toBeUndefined();
  });

  test("rejects excess properties inside card items", () => {
    expect(
      decodeAdvisorReviewCard({
        ...validCard,
        cardId: "arc_nested",
        summary: "summary",
        items: [{ ...validCard.items[0]!, extra: true }],
      }),
    ).toBeUndefined();
  });

  test("snapshots hostile card and action input once without invoking accessors", () => {
    const cardInput = {
      version: 1 as const,
      cardId: "arc_hostile",
      kind: "issues" as const,
      summary: "summary",
      items: [{ issue: "x", evidence: "y", suggestedFix: "z" }],
    };
    let cardOwnKeyReads = 0;
    const singleReadCard = new Proxy(cardInput, {
      ownKeys(target) {
        cardOwnKeyReads += 1;
        if (cardOwnKeyReads > 1) throw new Error("card inspected twice");
        return Reflect.ownKeys(target);
      },
    });
    const actionInput = { version: 1 as const, cardId: "arc_hostile", action: "fix" as const };
    let actionOwnKeyReads = 0;
    const singleReadAction = new Proxy(actionInput, {
      ownKeys(target) {
        actionOwnKeyReads += 1;
        if (actionOwnKeyReads > 1) throw new Error("action inspected twice");
        return Reflect.ownKeys(target);
      },
    });
    let getterInvoked = false;
    const accessor = Object.defineProperty(
      { version: 1, cardId: "arc_accessor", kind: "issues", items: cardInput.items },
      "summary",
      {
        enumerable: true,
        get() {
          getterInvoked = true;
          throw new Error("getter invoked");
        },
      },
    );

    expect(decodeAdvisorReviewCard(singleReadCard)).toEqual(cardInput);
    expect(decodeAdvisorReviewAction(singleReadAction)).toEqual(actionInput);
    expect(decodeAdvisorReviewCard(accessor)).toBeUndefined();
    expect(cardOwnKeyReads).toBe(1);
    expect(actionOwnKeyReads).toBe(1);
    expect(getterInvoked).toBe(false);
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
});
