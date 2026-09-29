import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import {
  metadataFreshness,
  metadataIsFresh,
  metadataTime,
  MCP_MAX_METADATA_TTL_MS,
} from "../../src/discovery/freshness.ts";

it.each([undefined, -1, 0, 0.5, Infinity, NaN, "1000", null])(
  "unusable TTL %s grants no cache authority",
  (ttl) => {
    const page = ttl === undefined ? {} : { ttlMs: ttl };
    const value = metadataFreshness(page, 10);
    expect(value).toEqual({ expiresAt: 10, cacheScope: "private" });
    expect(metadataIsFresh(value, 10)).toBe(false);
  },
);
it.each([MCP_MAX_METADATA_TTL_MS + 1, Number.MAX_SAFE_INTEGER + 1, 1e100])(
  "TTL %s beyond one day clamps to one day",
  (ttl) => {
    expect(metadataFreshness({ ttlMs: ttl }, 10).expiresAt).toBe(10 + MCP_MAX_METADATA_TTL_MS);
  },
);
it("only explicit public scope is public and omitted snapshot freshness is stale", () => {
  expect(metadataFreshness({ ttlMs: 100, cacheScope: "public" }, 20)).toEqual({
    expiresAt: 120,
    cacheScope: "public",
  });
  for (const cacheScope of ["private", "PUBLIC", "unknown", null])
    expect(metadataFreshness({ ttlMs: 100, cacheScope }, 20).cacheScope).toBe("private");
  expect(metadataIsFresh({}, 0)).toBe(false);
});
it.effect("freshness uses the Effect monotonic clock and expires at the exact deadline", () =>
  Effect.gen(function* () {
    const receivedAt = yield* metadataTime;
    const value = metadataFreshness({ ttlMs: 100 }, receivedAt);
    yield* TestClock.adjust("99 millis");
    expect(metadataIsFresh(value, yield* metadataTime)).toBe(true);
    yield* TestClock.adjust("1 millis");
    expect(metadataIsFresh(value, yield* metadataTime)).toBe(false);
  }),
);
