import * as Arr from "effect/Array";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import { clampPercent, formatDuration } from "pi-cosmic-core/display";
import { JsonHttpClient } from "pi-cosmic-core/platform/json-http";
import type { CodexCredentials } from "../auth/codex-auth.ts";

export type UsageSnapshot = {
  capturedAt: number;
  fiveHourLeftPercent: number | null;
  sevenDayLeftPercent: number | null;
  fiveHourResetInSeconds: number | null;
  sevenDayResetInSeconds: number | null;
};
export const USAGE_URL = "https://chatgpt.com/backend-api/wham/usage";

const MAX_RESET_SECONDS = 366 * 86_400;
const UsageWindowSchema = Schema.Struct({
  used_percent: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_after_seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  reset_at: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const RateLimitBucketSchema = Schema.Struct({
  allowed: Schema.optional(Schema.Boolean),
  limit_reached: Schema.optional(Schema.Boolean),
  primary_window: Schema.optional(Schema.NullOr(UsageWindowSchema)),
  secondary_window: Schema.optional(Schema.NullOr(UsageWindowSchema)),
});
const CodexUsageSchema = Schema.Struct({
  rate_limit: Schema.optional(Schema.NullOr(RateLimitBucketSchema)),
});
export type CodexUsageResponse = typeof CodexUsageSchema.Type;
type UsageWindow = typeof UsageWindowSchema.Type;

export class CodexUsageError extends Schema.TaggedError<
  CodexUsageError,
  { readonly brand: unique symbol }
>()("CodexUsageError", {
  operation: Schema.Literals(["decode", "request"]),
  message: Schema.String,
}) {}

const boundedResetSeconds = (value: number | null | undefined): number | null =>
  Predicate.isNumber(value) && Number.isFinite(value) && value >= 0 && value <= MAX_RESET_SECONDS
    ? value
    : null;

function resetSeconds(window: UsageWindow | null | undefined, now: number): number | null {
  const resetAfter = boundedResetSeconds(window?.reset_after_seconds);
  if (resetAfter !== null) return resetAfter;

  const resetAtValue = window?.reset_at;
  if (
    !Predicate.isNumber(resetAtValue) ||
    !Number.isFinite(resetAtValue) ||
    resetAtValue < 0 ||
    !Number.isFinite(now)
  )
    return null;

  const resetAt = resetAtValue > 100_000_000_000 ? resetAtValue / 1000 : resetAtValue;
  return boundedResetSeconds(Math.max(0, resetAt - now / 1000));
}

export function parseUsageSnapshot(data: CodexUsageResponse, now: number): UsageSnapshot {
  const primary = data.rate_limit?.primary_window ?? null;
  const secondary = data.rate_limit?.secondary_window ?? null;
  const fiveHour = secondary ? primary : null;
  const sevenDay = secondary ?? primary;
  return {
    capturedAt: now,
    fiveHourLeftPercent: usedToLeftPercent(fiveHour?.used_percent),
    sevenDayLeftPercent: usedToLeftPercent(sevenDay?.used_percent),
    fiveHourResetInSeconds: resetSeconds(fiveHour, now),
    sevenDayResetInSeconds: resetSeconds(sevenDay, now),
  };
}

/** A reset countdown in the suite's duration form: `42s`, `2h 3m`, `6d 1h`. */
function formatResetCountdown(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  return total < 60 ? `${total}s` : formatDuration(total * 1000);
}

const normalizeSpaces = (text: string): string => Fn.pipe(text, Str.replace(/\s+/gu, " "));

const localDay = (at: DateTime.DateTime): string =>
  DateTime.formatLocal(at, { locale: "en-US", year: "numeric", month: "numeric", day: "numeric" });

/** A local short time: `10:59 PM` today, `Nov 9, 10:59 PM` on another day. */
function formatLocalShort(at: DateTime.DateTime, now: number): string {
  const today = DateTime.make(now);
  const sameDay = Option.isSome(today) && localDay(today.value) === localDay(at);
  return normalizeSpaces(
    DateTime.formatLocal(at, {
      locale: "en-US",
      ...(sameDay ? {} : { month: "short", day: "numeric" }),
      hour: "numeric",
      minute: "2-digit",
    }),
  );
}

interface ResetMoment {
  readonly countdown: string;
  readonly at: string;
}

function resetMoment(seconds: number | null, now: number): ResetMoment | undefined {
  if (!Predicate.isNumber(seconds) || !Number.isFinite(seconds) || !Number.isFinite(now))
    return undefined;
  const reset = DateTime.make(now + seconds * 1000);
  return Option.isSome(reset)
    ? { countdown: formatResetCountdown(seconds), at: formatLocalShort(reset.value, now) }
    : undefined;
}

/**
 * The footer's reset segment, `<window> ↺ <countdown> - <local time>`. Cosmic UI parses this
 * shape, so neither part may contain `-` or `|`.
 */
function formatFooterReset(label: string, seconds: number | null, now: number): string | null {
  const moment = resetMoment(seconds, now);
  return moment === undefined ? null : `${label} ↺ ${moment.countdown} - ${moment.at}`;
}

function usedToLeftPercent(value: number | null | undefined): number | null {
  return Predicate.isNumber(value) && Number.isFinite(value) ? clampPercent(100 - value) : null;
}

/** A diagnostic timestamp in the local short form, always with its date: `Nov 3, 10:59 PM`. */
export function formatTimestampOrNever(value: number | undefined): string {
  if (value === undefined) return "never";
  const at = DateTime.make(value);
  return Option.isSome(at)
    ? normalizeSpaces(
        DateTime.formatLocal(at.value, {
          locale: "en-US",
          month: "short",
          day: "numeric",
          hour: "numeric",
          minute: "2-digit",
        }),
      )
    : "unknown";
}

function formatPercent(value: number | null): string {
  return Predicate.isNumber(value) && Number.isFinite(value)
    ? `${Math.round(clampPercent(value))}%`
    : "--";
}

function remainingResetSeconds(
  seconds: number | null,
  capturedAt: number,
  now: number,
): number | null {
  if (
    seconds === null ||
    !Number.isFinite(seconds) ||
    !Number.isFinite(capturedAt) ||
    !Number.isFinite(now)
  )
    return null;
  const remaining = seconds - (now - capturedAt) / 1000;
  return Number.isFinite(remaining) ? remaining : null;
}

interface UsageWindowView {
  /** The compact label the footer protocol and status line use. */
  readonly label: "5h" | "7d";
  /** The spelled-out name `/openai usage` uses. */
  readonly name: string;
  readonly leftPercent: number | null;
  readonly resetInSeconds: number | null;
}

const usageWindows = (snapshot: UsageSnapshot): ReadonlyArray<UsageWindowView> => [
  {
    label: "5h",
    name: "5-hour",
    leftPercent: snapshot.fiveHourLeftPercent,
    resetInSeconds: snapshot.fiveHourResetInSeconds,
  },
  {
    label: "7d",
    name: "7-day",
    leftPercent: snapshot.sevenDayLeftPercent,
    resetInSeconds: snapshot.sevenDayResetInSeconds,
  },
];

const reportedWindows = (snapshot: UsageSnapshot): ReadonlyArray<UsageWindowView> =>
  Arr.filter(
    usageWindows(snapshot),
    (window) => window.leftPercent !== null || window.resetInSeconds !== null,
  );

/**
 * The footer text Cosmic UI parses: `Usage: 5h: 50% | 7d: 90% | 7d ↺ 6d 1h - Nov 9, 10:59 PM`.
 * ` | ` separates protocol segments only; people see Cosmic UI's rendering or
 * {@link formatUsageStatus}.
 */
export function formatUsageSnapshot(
  snapshot: UsageSnapshot,
  options: { readonly showResetTimes: boolean },
  now: number,
): string {
  const { capturedAt } = snapshot;
  const visible = reportedWindows(snapshot);
  const labels = Arr.map(
    visible,
    (window) => `${window.label}: ${formatPercent(window.leftPercent)}`,
  );
  const resets = options.showResetTimes
    ? Arr.flatMapNullishOr(visible, (window) =>
        formatFooterReset(
          window.label,
          remainingResetSeconds(window.resetInSeconds, capturedAt, now),
          now,
        ),
      )
    : [];
  return `Usage: ${labels.length ? Arr.join(labels, " | ") : "--"}${resets.length ? ` | ${Arr.join(resets, " | ")}` : ""}`;
}

/**
 * The one-line status Pi shows when Cosmic UI's footer is inactive:
 * `OpenAI 5h 50% left · 7d 90% left · 7d resets Nov 9, 10:59 PM`.
 */
export function formatUsageStatus(
  snapshot: UsageSnapshot,
  options: { readonly showResetTimes: boolean },
  now: number,
): string | undefined {
  const visible = Arr.filter(reportedWindows(snapshot), (window) => window.leftPercent !== null);
  if (visible.length === 0) return undefined;
  const windows = Arr.map(
    visible,
    (window) => `${window.label} ${formatPercent(window.leftPercent)} left`,
  );
  const resets = options.showResetTimes
    ? Arr.flatMapNullishOr(visible, (window) => {
        const moment = resetMoment(
          remainingResetSeconds(window.resetInSeconds, snapshot.capturedAt, now),
          now,
        );
        return moment === undefined ? null : `${window.label} resets ${moment.at}`;
      })
    : [];
  return `OpenAI ${Arr.join([...windows, ...resets], " · ")}`;
}

function windowDetail(window: UsageWindowView, capturedAt: number, now: number): string {
  if (window.leftPercent === null) return "not reported";
  const moment = resetMoment(remainingResetSeconds(window.resetInSeconds, capturedAt, now), now);
  const left = `${formatPercent(window.leftPercent)} left`;
  return moment === undefined ? left : `${left} · resets ${moment.at}`;
}

/**
 * What `/openai usage` shows: when usage was read, then each window and its local reset time, the
 * same absolute form the footer uses. Lines stay short so a narrow pane doesn't wrap them.
 */
export function formatUsageDetails(snapshot: UsageSnapshot, now: number): string {
  const windows = usageWindows(snapshot);
  const width = Math.max(...Arr.map(windows, (window) => window.name.length));
  return Arr.join(
    [
      `OpenAI subscription usage · updated ${formatLocalShort(DateTime.makeUnsafe(now), now)}`,
      ...Arr.map(
        windows,
        (window) =>
          `  ${Fn.pipe(window.name, Str.padEnd(width))}  ${windowDetail(window, snapshot.capturedAt, now)}`,
      ),
    ],
    "\n",
  );
}

export const requestCodexUsageWithCredentials = Effect.fn("CodexUsage.requestWithCredentials")(
  function* (credentials: CodexCredentials) {
    const http = yield* JsonHttpClient;
    const response = yield* http
      .request({
        url: USAGE_URL,
        headers: {
          accept: "*/*",
          authorization: `Bearer ${Redacted.value(credentials.accessToken)}`,
          "chatgpt-account-id": credentials.accountId,
        },
        responseSchema: CodexUsageSchema,
      })
      .pipe(
        Effect.mapError((error) => {
          const malformed = error.operation === "decode";
          return CodexUsageError.make({
            operation: malformed ? "decode" : "request",
            message: malformed
              ? "OpenAI returned an unreadable usage response"
              : "Usage request failed",
          });
        }),
      );
    if (Predicate.isTagged(response, "Rejected"))
      return yield* CodexUsageError.make({
        operation: "request",
        message: `Usage request failed with status ${response.status}`,
      });
    const now = yield* Clock.currentTimeMillis;
    return parseUsageSnapshot(response.body, now);
  },
);
