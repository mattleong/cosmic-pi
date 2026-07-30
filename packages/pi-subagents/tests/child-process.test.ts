import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import {
  requestCooperativeAbort,
  safeSubagentDirectorySegment,
} from "../src/boundary/child-process.ts";

describe("subagent child process boundary", () => {
  it("keeps untrusted session identifiers inside one directory segment", () => {
    expect(safeSubagentDirectorySegment("session-123")).toBe("session-123");
    const escaped = safeSubagentDirectorySegment("../../../../tmp/owned");
    expect(escaped).toMatch(/^id-[a-f0-9]{32}$/);
    expect(escaped).not.toContain("/");
    expect(safeSubagentDirectorySegment("../../../../tmp/owned")).toBe(escaped);
  });

  it.effect("bounds a cooperative abort when stdin never drains", () =>
    Effect.gen(function* () {
      const abort = yield* requestCooperativeAbort(() => Effect.never).pipe(Effect.forkScoped);
      yield* Effect.yieldNow;
      yield* TestClock.adjust("250 millis");
      yield* Fiber.join(abort);
    }).pipe(Effect.scoped),
  );
});
