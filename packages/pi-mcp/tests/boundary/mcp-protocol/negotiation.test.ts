import { fileURLToPath } from "node:url";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
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
const mac = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  process.platform === "darwin" ? Effect.asVoid(effect) : Effect.void;

it.live.each(["modern", "dual", "legacy", "silent"])(
  "negotiates %s stdio on a disposable child before fresh acquisition",
  (mode) =>
    mac(
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
    ),
);

it.live.each(["malformed", "exit-before-init", "silent-all"])(
  "does not guess legacy after failed %s negotiation",
  (mode) =>
    mac(
      Effect.gen(function* () {
        const cleanup: boolean[] = [];
        const result = yield* openSdkStdio({
          ...options,
          connectTimeoutMs: 250,
          environment: { FIXTURE_MODE: mode },
          onCleanup: (value) => cleanup.push(value),
        }).pipe(Effect.result);
        expect(result._tag).toBe("Failure");
        if (mode === "malformed" && result._tag === "Failure") {
          expect(result.failure).toMatchObject({
            kind: "protocol",
            outcome: "not-sent",
            reason: "protocol-negotiation-rejected",
          });
        }
        expect(cleanup).toEqual([true]);
      }),
    ),
);

it.live("explicit legacy override handles a server which exits on any pre-initialize method", () =>
  mac(
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
  ),
);
