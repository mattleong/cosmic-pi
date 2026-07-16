import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { formatAdvisorReview, type AdvisorReview } from "./review.ts";

export const ADVISOR_REVIEW_MESSAGE_TYPE = "advisor-review";

export interface AdvisorReviewMessageDetails {
  review: AdvisorReview;
  provider: string;
  model: string;
}

export function registerAdvisorReviewRenderer(pi: ExtensionAPI): void {
  pi.registerMessageRenderer<AdvisorReviewMessageDetails>(
    ADVISOR_REVIEW_MESSAGE_TYPE,
    (message, _options, theme) => {
      const details = message.details;
      if (
        !details?.review ||
        typeof details.provider !== "string" ||
        typeof details.model !== "string"
      ) {
        return undefined;
      }
      try {
        const heading = theme.bold(theme.fg("warning", "Advisor requested a revision"));
        const model = theme.fg("muted", `${details.provider}/${details.model}`);
        return new Text(`${heading} ${model}\n${formatAdvisorReview(details.review)}`, 1, 0);
      } catch {
        return undefined;
      }
    },
  );
}
