import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";
import { makeLocalClaudeDiagnostics } from "../src/backend/local-claude-diagnostics.ts";
import type { PendingUserReplay } from "../src/backend/local-claude-input-delivery.ts";
import { processError } from "../src/run/errors.ts";

const pending = (): PendingUserReplay => ({
  uuid: "secret-uuid",
  sequence: 1,
  operation: "steer",
  contentDigest: "secret-digest",
  epoch: 1,
  emitRunStarted: false,
  resultKind: undefined,
  acknowledgement: Deferred.makeUnsafe(),
  ownedAtMillis: 0,
});

describe("Claude steering failure metadata", () => {
  it.effect("retains bounded category, timing, and native version without foreign content", () =>
    Effect.gen(function* () {
      const diagnostics = makeLocalClaudeDiagnostics(() => [
        "Bash",
        "secret-path-tool",
        "mcp__pi_subagents_supervisor__supervisor_question",
      ]);
      yield* diagnostics.observe("init", "2.1.259");
      yield* TestClock.adjust("298 seconds");
      yield* diagnostics.observe("assistant");
      yield* TestClock.adjust("2 seconds");
      const error = yield* diagnostics.diagnose(
        pending(),
        processError("steer", "steer_outcome_uncertain", "Guidance unconfirmed."),
        "steering-watchdog",
      );
      expect(error.code).toBe("steer_outcome_uncertain");
      expect(error.message).toContain('"waitElapsedMillis":300000');
      expect(error.message).toContain('"lastInboundAgeMillis":2000');
      expect(error.message).toContain('"activeToolCategory":"mixed"');
      expect(error.message).toContain('"activeToolCount":3');
      expect(error.message).toContain('"cliVersion":"2.1.259"');
      expect(error.message).not.toContain("secret");
      expect(error.message).not.toContain("supervisor_question");
      expect(error.message).not.toContain("uuid");
    }),
  );
  it.effect("ignores untrusted version text and caps timing and active count", () =>
    Effect.gen(function* () {
      const diagnostics = makeLocalClaudeDiagnostics(() =>
        Array.from({ length: 600 }, () => "Agent"),
      );
      yield* diagnostics.observe("init", "secret/path/token");
      yield* TestClock.adjust("2 days");
      const snapshot = yield* diagnostics.snapshot(pending(), "write-uncertain");
      expect(snapshot).toMatchObject({
        cliVersion: null,
        waitElapsedMillis: 86_400_000,
        lastInboundAgeMillis: 86_400_000,
        activeToolCount: 512,
        activeToolCategory: "native-agent",
      });
      expect(Object.values(snapshot).join(" ")).not.toContain("secret");
    }),
  );
});
