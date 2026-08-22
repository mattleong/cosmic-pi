// Private process-boundary integration tests intentionally use Node process probes.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/globalTimers:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/preferSchemaOverJson:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { makeNdjsonRpcSession, type InboundClassification } from "../src/boundary/rpc-session.ts";

const fixture = fileURLToPath(new URL("./fixtures/rpc-session-fixture.mjs", import.meta.url));
const directories: string[] = [];

const FixtureReplySchema = Schema.fromJsonString(
  Schema.Struct({ id: Schema.String, value: Schema.String }),
);

const classify = (line: string): InboundClassification<string> => {
  if (line === "protocol-error") return { kind: "protocol-error", reason: "invalid fixture" };
  const decoded = Schema.decodeUnknownOption(FixtureReplySchema)(line);
  return Option.isSome(decoded)
    ? { kind: "reply", id: decoded.value.id, value: decoded.value.value }
    : { kind: "protocol-error", reason: "invalid fixture response" };
};

const options = (mode: string, pidPath?: string) => ({
  command: process.execPath,
  args: [fixture, mode, ...(pidPath ? [pidPath] : [])],
  diagnosticMaxBytes: 0,
  waitForSpawnEvent: true,
  maxLineBytes: 3 * 1024 * 1024,
  maxQueuedOutputBytes: 64,
  maxPendingCalls: 8,
  writeQueueCapacity: 4,
  classifyInbound: classify,
  unknownReplyPolicy: "fail-session" as const,
});

const processAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

const waitForDead = async (pid: number): Promise<void> => {
  for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
    await new Promise((resolve) => setTimeout(resolve, 10));
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("NDJSON RPC session", () => {
  it("does not treat lifetime output as queued output", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("echo"));
          for (let index = 0; index < 20; index++) {
            const value = `response-${index}`;
            expect(
              yield* session.call(
                String(index),
                `${JSON.stringify({ id: String(index), value })}\n`,
                1_000,
              ),
            ).toBe(value);
          }
        }),
      ),
    );
  });

  it("isolates a timed-out call without failing concurrent or later calls", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("delay-first"));
          const slow = yield* session
            .call("slow", `${JSON.stringify({ id: "slow", value: "late" })}\n`, 25)
            .pipe(Effect.result, Effect.forkScoped);
          expect(
            yield* session.call(
              "fast",
              `${JSON.stringify({ id: "fast", value: "concurrent" })}\n`,
              1_000,
            ),
          ).toBe("concurrent");
          expect((yield* Fiber.join(slow))._tag).toBe("Failure");
          expect(
            yield* session.call(
              "later",
              `${JSON.stringify({ id: "later", value: "still-live" })}\n`,
              1_000,
            ),
          ).toBe("still-live");
        }),
      ),
    );
  });

  it("force-cleans a failed session whose child ignores direct SIGTERM", async () => {
    const directory = await fs.mkdtemp(join(tmpdir(), "pi-subagents-rpc-session-"));
    directories.push(directory);
    const pidPath = join(directory, "fixture.pid");
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("protocol-error", pidPath));
          const result = yield* Effect.result(
            session.call("request", `${JSON.stringify({ id: "request", value: "x" })}\n`, 1_000),
          );
          expect(result._tag).toBe("Failure");
        }),
      ),
    );
    const pid = Number(await fs.readFile(pidPath, "utf8"));
    expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
    await waitForDead(pid);
    expect(processAlive(pid)).toBe(false);
  });

  it("settles queued notification acknowledgements when closing", async () => {
    await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("no-read"));
          const frame = `${"x".repeat(2 * 1024 * 1024)}\n`;
          const first = yield* session.notify(frame).pipe(Effect.forkScoped);
          const second = yield* session.notify(frame).pipe(Effect.forkScoped);
          yield* Effect.yieldNow;
          yield* session.close().pipe(Effect.catch(() => Effect.void));
          const exits = yield* Effect.all([Fiber.await(first), Fiber.await(second)], {
            concurrency: "unbounded",
          }).pipe(Effect.timeout("2 seconds"));
          expect(exits.every(Exit.isFailure)).toBe(true);
        }),
      ),
    );
  });
});
