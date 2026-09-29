import { fileURLToPath } from "node:url";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { StdioEraVerdict } from "../../../src/boundary/mcp-protocol/shared/stdio-negotiation.ts";
import { openSdkStdio } from "../../../src/boundary/sdk-stdio.ts";

const fixture = fileURLToPath(new URL("../../fixtures/modern-stdio-server.mjs", import.meta.url));
const options = {
  command: process.execPath,
  args: [fixture],
  environment: {},
  connectTimeoutMs: 2_000,
  requestTimeoutMs: 1_000,
  cleanupTimeoutMs: 500,
};

describe.skipIf(process.platform !== "darwin")("macOS stdio negotiation", () => {
  it.live.each(["modern", "dual", "legacy", "silent", "exit-before-init", "malformed"])(
    "negotiates %s stdio on a disposable child before fresh acquisition",
    (mode) =>
      Effect.gen(function* () {
        const cleanup: boolean[] = [];
        const connection = yield* openSdkStdio({
          ...options,
          environment: { FIXTURE_MODE: mode },
          onCleanup: (value) => cleanup.push(value),
        });
        expect(connection.protocolVersion).toBe(
          mode === "modern" || mode === "dual" ? "2026-07-28" : "2025-11-25",
        );
        if (mode === "modern" || mode === "dual") {
          const probePid = Number(connection.instructions?.text);
          expect(probePid).toBeGreaterThan(0);
          // The real child has been acquired only after the disposable root/group/pipe join.
          expect(() => process.kill(probePid, 0)).toThrow();
        }
        expect((yield* connection.request({ action: "tools.call", tool: "pid" })).outcome).toBe(
          "completed",
        );
        yield* connection.close;
        expect(cleanup).toEqual([true]);
      }),
  );

  it.live.each(["dual", "modern"])(
    "recognizes a %s server whose startup outlasts a short probe",
    (mode) =>
      Effect.gen(function* () {
        const connection = yield* openSdkStdio({
          ...options,
          connectTimeoutMs: 6_000,
          environment: { FIXTURE_MODE: mode, FIXTURE_DELAY_MS: "1200" },
        });
        expect(connection.protocolVersion).toBe("2026-07-28");
        yield* connection.close;
      }),
    10_000,
  );

  it.live.each([
    { mode: "dual", expected: { era: "modern", version: "2026-07-28" } },
    { mode: "legacy", expected: { era: "legacy" } },
  ] as const)("reports the $mode verdict for reuse", ({ mode, expected }) =>
    Effect.gen(function* () {
      const verdicts: StdioEraVerdict[] = [];
      const connection = yield* openSdkStdio({
        ...options,
        environment: { FIXTURE_MODE: mode },
        onNegotiated: (verdict) => verdicts.push(verdict),
      });
      expect(verdicts).toEqual([expected]);
      yield* connection.close;
    }),
  );

  const pidText = Schema.decodeUnknownSync(
    Schema.Struct({ content: Schema.Array(Schema.Struct({ text: Schema.String })) }),
  );
  it.live("a remembered modern era negotiates on the application child alone", () =>
    Effect.gen(function* () {
      const connection = yield* openSdkStdio({
        ...options,
        environment: { FIXTURE_MODE: "modern" },
        remembered: { era: "modern", version: "2026-07-28" },
      });
      expect(connection.protocolVersion).toBe("2026-07-28");
      const reply = yield* connection.request({ action: "tools.call", tool: "pid" });
      // The child that answered server/discover is the one serving calls: no probe child.
      expect(pidText(reply.result).content[0]?.text).toBe(connection.instructions?.text);
      yield* connection.close;
    }),
  );

  it.live("a remembered legacy era sends no probe", () =>
    Effect.gen(function* () {
      const connection = yield* openSdkStdio({
        ...options,
        environment: { FIXTURE_MODE: "exit-before-init" },
        remembered: { era: "legacy" },
      });
      expect(connection.protocolVersion).toBe("2025-11-25");
      yield* connection.close;
    }),
  );

  it.live("a stale remembered modern era fails loudly instead of downgrading", () =>
    Effect.gen(function* () {
      const result = yield* openSdkStdio({
        ...options,
        environment: { FIXTURE_MODE: "legacy" },
        remembered: { era: "modern", version: "2026-07-28" },
      }).pipe(Effect.result);
      expect(result._tag).toBe("Failure");
    }),
  );

  it.live.each(["silent-all"])(
    "does not guess legacy when a %s server answers neither handshake",
    (mode) =>
      Effect.gen(function* () {
        const cleanup: boolean[] = [];
        const result = yield* openSdkStdio({
          ...options,
          connectTimeoutMs: 250,
          environment: { FIXTURE_MODE: mode },
          onCleanup: (value) => cleanup.push(value),
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        expect(cleanup).toEqual([true]);
      }),
  );

  it.live(
    "explicit legacy override skips the probe for a server which exits on any pre-initialize method",
    () =>
      Effect.gen(function* () {
        const connection = yield* openSdkStdio({
          ...options,
          protocol: "legacy",
          environment: { FIXTURE_MODE: "exit-before-init" },
        });
        expect(connection.protocolVersion).toBe("2025-11-25");
        expect((yield* connection.request({ action: "tools.call", tool: "pid" })).outcome).toBe(
          "completed",
        );
        yield* connection.close;
      }),
  );
});
