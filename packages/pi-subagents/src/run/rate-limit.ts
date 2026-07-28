import type { ChildRateLimitEvent } from "./child-agent.ts";

const NOTIFICATION_THRESHOLDS = [0.8, 0.9, 0.95] as const;

export interface RateLimitNoticeState {
  readonly resetsAt?: number | undefined;
  highestThreshold: number;
  overageNotified: boolean;
  rejectionNotified: boolean;
}

const rateLimitName = (value: string | undefined): string =>
  value ? value.replaceAll("_", " ") : "usage";

export const rateLimitWindowKey = (event: ChildRateLimitEvent): string =>
  `${event.rateLimitType ?? "usage"}:${event.resetsAt === undefined ? "unknown" : event.resetsAt}`;
const rateLimitLabel = (value: string | undefined): string => `${rateLimitName(value)} limit`;
const rateLimitAllowance = (value: string | undefined): string =>
  `${rateLimitName(value)} allowance`;

const rateLimitResetText = (resetsAt: number | undefined, now: number): string => {
  if (resetsAt === undefined || !Number.isFinite(resetsAt)) return "";
  const remainingMinutes = Math.max(0, Math.ceil((resetsAt * 1_000 - now) / 60_000));
  if (remainingMinutes < 60) return `; resets in ${remainingMinutes}m`;
  const hours = Math.floor(remainingMinutes / 60);
  const minutes = remainingMinutes % 60;
  return `; resets in ${hours}h${minutes ? ` ${minutes}m` : ""}`;
};

export const rateLimitMessage = (event: ChildRateLimitEvent, now: number): string => {
  const utilization =
    event.utilization !== undefined && Number.isFinite(event.utilization)
      ? ` (${Math.max(0, Math.round(event.utilization * 100))}% used)`
      : "";
  const reset = rateLimitResetText(event.resetsAt, now);
  if (event.isUsingOverage)
    return `Claude exhausted its ${rateLimitAllowance(event.rateLimitType)}${utilization}${reset}; continuing with paid overage.`;
  if (
    event.status === "rejected" &&
    (event.overageStatus === "allowed" || event.overageStatus === "allowed_warning")
  )
    return `Claude exhausted its ${rateLimitAllowance(event.rateLimitType)}${utilization}${reset}; paid overage is available.`;
  const overageUnavailable =
    event.overageStatus === "rejected"
      ? `; paid overage unavailable${event.overageDisabledReason ? ` (${event.overageDisabledReason.replaceAll("_", " ")})` : ""}`
      : "";
  return event.status === "allowed_warning"
    ? `Claude is approaching its ${rateLimitLabel(event.rateLimitType)}${utilization}${reset}${overageUnavailable}.`
    : `Claude request was rejected by its ${rateLimitLabel(event.rateLimitType)}${utilization}${reset}${overageUnavailable}.`;
};

export const isRejectedRateLimit = (event: ChildRateLimitEvent): boolean =>
  event.status === "rejected" &&
  event.isUsingOverage !== true &&
  event.overageStatus === "rejected";

export function advanceRateLimitNotice(
  previous: RateLimitNoticeState | undefined,
  event: ChildRateLimitEvent,
): { readonly notice: RateLimitNoticeState; readonly notifyParent: boolean } {
  const startsNewWindow =
    previous !== undefined && event.resetsAt !== undefined && previous.resetsAt !== event.resetsAt;
  const notice: RateLimitNoticeState =
    previous && !startsNewWindow
      ? { ...previous }
      : {
          ...(event.resetsAt !== undefined ? { resetsAt: event.resetsAt } : {}),
          highestThreshold: 0,
          overageNotified: false,
          rejectionNotified: false,
        };
  let notifyParent = false;
  if (event.isUsingOverage) {
    notifyParent = !notice.overageNotified;
    notice.overageNotified = true;
  } else if (event.status === "rejected") {
    notifyParent = !notice.rejectionNotified;
    notice.rejectionNotified = true;
  } else if (
    event.status === "allowed_warning" &&
    event.utilization !== undefined &&
    Number.isFinite(event.utilization)
  ) {
    const reached = NOTIFICATION_THRESHOLDS.filter(
      (threshold) => event.utilization !== undefined && event.utilization >= threshold,
    ).at(-1);
    if (reached !== undefined && reached > notice.highestThreshold) {
      notice.highestThreshold = reached;
      notifyParent = true;
    }
  }
  return { notice, notifyParent };
}
