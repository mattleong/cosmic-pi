import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AdvisorReview } from "../review/schema.ts";
import { randomUUID } from "node:crypto";
import {
  ADVISOR_REVIEW_ACTION_TYPE,
  ADVISOR_REVIEW_CARD_TYPE,
  compactAdvisorGuidance,
  decodeAdvisorReviewAction,
  decodeAdvisorReviewCard,
  makeAdvisorReviewCard,
  renderAdvisorReviewCard,
  type AdvisorReviewAction,
  type AdvisorReviewCard,
} from "../ui/review-card.ts";
import { readAdvisorSessionBranchAtHostBoundary } from "./host-context.ts";

export function registerAdvisorReviewCardRendererAtHostBoundary(pi: ExtensionAPI): void {
  pi.registerEntryRenderer<AdvisorReviewCard>(
    ADVISOR_REVIEW_CARD_TYPE,
    (entry, { expanded }, theme) => renderAdvisorReviewCard(entry.data, expanded, theme),
  );
}

export interface AdvisorReviewCardPublishResult {
  readonly card?: AdvisorReviewCard;
  readonly appended: boolean;
}

export interface AdvisorGuidancePublishResult extends AdvisorReviewCardPublishResult {
  readonly guidanceSent: boolean;
}

export function appendAdvisorReviewCardAtHostBoundary(
  pi: ExtensionAPI,
  review: AdvisorReview,
): AdvisorReviewCardPublishResult {
  const card = makeAdvisorReviewCard(`arc_${randomUUID().replaceAll("-", "")}`, review);
  if (!card) return { appended: false };
  try {
    pi.appendEntry<AdvisorReviewCard>(ADVISOR_REVIEW_CARD_TYPE, card);
    return { card, appended: true };
  } catch {
    return { card, appended: false };
  }
}

export function appendAdvisorReviewActionAtHostBoundary(
  pi: ExtensionAPI,
  card: AdvisorReviewCard,
  action: AdvisorReviewAction["action"],
): boolean {
  try {
    pi.appendEntry<AdvisorReviewAction>(ADVISOR_REVIEW_ACTION_TYPE, {
      version: 1,
      cardId: card.cardId,
      action,
    });
    return true;
  } catch {
    return false;
  }
}

export function sendCompactAdvisorGuidanceAtHostBoundary(
  pi: ExtensionAPI,
  card: AdvisorReviewCard,
  triggerTurn: boolean,
): boolean {
  try {
    pi.sendMessage(
      {
        customType: "pi-advisor-guidance-v1",
        content: compactAdvisorGuidance(card),
        display: false,
      },
      triggerTurn ? { deliverAs: "steer", triggerTurn: true } : { deliverAs: "steer" },
    );
    return true;
  } catch {
    return false;
  }
}

/** Restore the latest card not followed by an action tombstone on the active branch. */
export function latestOpenAdvisorReviewCardAtHostBoundary(
  ctx: ExtensionContext,
): AdvisorReviewCard | undefined {
  const result = readAdvisorSessionBranchAtHostBoundary(ctx);
  if (!result.ok) return undefined;
  const closed = new Set<string>();
  for (let index = result.value.length - 1; index >= 0; index -= 1) {
    // SAFETY: The boundary adapter's ownership and validation checks establish this host contract before use.
    const entry = result.value[index] as {
      type?: unknown;
      customType?: unknown;
      data?: unknown;
    };
    if (entry.type !== "custom") continue;
    if (entry.customType === ADVISOR_REVIEW_ACTION_TYPE) {
      const action = decodeAdvisorReviewAction(entry.data);
      if (action) closed.add(action.cardId);
      continue;
    }
    if (entry.customType !== ADVISOR_REVIEW_CARD_TYPE) continue;
    const card = decodeAdvisorReviewCard(entry.data);
    if (card && !closed.has(card.cardId)) return card;
  }
  return undefined;
}
