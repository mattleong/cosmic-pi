import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import type * as Schema from "effect/Schema";
import * as Predicate from "effect/Predicate";

/** A server hint cannot grant more than one day of local metadata freshness; longer hints clamp. */
export const MCP_MAX_METADATA_TTL_MS = 24 * 60 * 60 * 1000;
export interface McpMetadataFreshness {
  /** Local monotonic milliseconds, never a portable timestamp. */
  readonly expiresAt?: number;
  readonly cacheScope?: "public" | "private";
}
export const metadataTime = Clock.monotonicTimeNanos.pipe(
  Effect.map((nanos) => Number(nanos / 1_000_000n)),
);
export const metadataFreshness = (
  page: Schema.JsonObject,
  receivedAt: number,
): Required<McpMetadataFreshness> => {
  const ttl = page.ttlMs;
  const bounded =
    Predicate.isNumber(ttl) && Number.isFinite(ttl) && ttl > 0
      ? Math.min(Math.floor(ttl), MCP_MAX_METADATA_TTL_MS)
      : 0;
  return {
    expiresAt: receivedAt + bounded,
    cacheScope: page.cacheScope === "public" ? "public" : "private",
  };
};
export const metadataIsFresh = (snapshot: McpMetadataFreshness, now: number): boolean =>
  snapshot.expiresAt !== undefined &&
  Number.isFinite(snapshot.expiresAt) &&
  now < snapshot.expiresAt;
