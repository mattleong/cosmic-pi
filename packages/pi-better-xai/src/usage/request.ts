import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import { JsonHttpClient, type JsonHttpResponseSchema } from "pi-cosmic-core";
import { getXaiCredentials, recoverRejectedXaiCredentials } from "../auth/auth.ts";
import {
  MONTHLY_BILLING_URL,
  MonthlyBillingSchema,
  parseUsageSnapshot,
  WEEKLY_BILLING_URL,
  WeeklyBillingSchema,
  type UsageSnapshot,
} from "./format.ts";

export class XaiUsageError extends Schema.TaggedError<XaiUsageError>()("XaiUsageError", {
  operation: Schema.String,
  message: Schema.String,
}) {}

const fetchBilling = Effect.fn("XaiUsage.fetchBilling")(function* <A, R>(
  url: string,
  accessToken: Redacted.Redacted<string>,
  responseSchema: JsonHttpResponseSchema<A, R>,
) {
  const http = yield* JsonHttpClient;
  return yield* http.request({
    url,
    headers: {
      Authorization: `Bearer ${Redacted.value(accessToken)}`,
      Accept: "application/json",
    },
    responseSchema,
  });
});

/**
 * Usage snapshot plus the redacted credential metadata resolved for the request.
 *
 * The metadata is carried out of the single credential resolution so callers never re-read the
 * auth file: registry-only credentials must not be reported as missing auth.
 */
export interface XaiUsageResult {
  readonly snapshot: UsageSnapshot;
  readonly teamId?: string;
}

const fetchUsageResponses = (accessToken: Redacted.Redacted<string>) =>
  Effect.all(
    [
      fetchBilling(MONTHLY_BILLING_URL, accessToken, MonthlyBillingSchema).pipe(
        Effect.mapError((error) =>
          error.operation === "decode"
            ? new XaiUsageError({
                operation: "monthly-decode",
                message: "xAI monthly billing response was malformed.",
              })
            : new XaiUsageError({
                operation: "request",
                message: "xAI billing request failed.",
              }),
        ),
      ),
      fetchBilling(WEEKLY_BILLING_URL, accessToken, WeeklyBillingSchema).pipe(
        Effect.catch(() => Effect.void),
      ),
    ] as const,
    { concurrency: 2 },
  );

export const requestXaiUsage = Effect.fn("XaiUsage.requestXaiUsage")(function* (authPath: string) {
  let credentials = yield* getXaiCredentials(authPath);
  if (!credentials) return undefined;
  let responses = yield* fetchUsageResponses(credentials.accessToken);
  if (responses[0]._tag === "Rejected" && responses[0].status === 401) {
    const replacement = yield* recoverRejectedXaiCredentials(
      authPath,
      credentials.accessToken,
    ).pipe(
      Effect.mapError(
        () =>
          new XaiUsageError({
            operation: "refresh",
            message: "xAI OAuth credentials could not be refreshed.",
          }),
      ),
    );
    if (replacement !== undefined) {
      credentials = replacement;
      responses = yield* fetchUsageResponses(credentials.accessToken);
    }
  }
  const [monthly, weekly] = responses;
  if (monthly._tag === "Rejected") {
    return yield* new XaiUsageError({
      operation: "monthly",
      message: `xAI monthly billing request failed (HTTP ${monthly.status}).`,
    });
  }
  const decodedMonthly = monthly.body;
  const decodedWeekly = weekly?._tag === "Accepted" ? weekly.body : undefined;
  const now = yield* Clock.currentTimeMillis;
  const snapshot = parseUsageSnapshot(decodedMonthly, decodedWeekly, now);
  const result: XaiUsageResult = credentials.teamId
    ? { snapshot, teamId: credentials.teamId }
    : { snapshot };
  return result;
});
