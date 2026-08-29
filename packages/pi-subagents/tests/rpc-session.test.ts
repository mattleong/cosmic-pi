// Private process-boundary integration tests intentionally use Node process probes.
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { afterEach, describe, expect, it } from "vitest";
import { makeNdjsonRpcSession, type InboundClassification } from "../src/boundary/rpc-session.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";

const { join } = nodePath;

const fixture = fileURLToPath(new URL("./fixtures/rpc-session-fixture.mjs", import.meta.url));
const directories: string[] = [];

// Locally constructed fixture reply frames are serialized by this pure test encoder.
const replyFrame = (id: string, value: string): string => `${JSON.stringify({ id, value })}\n`;

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

const waitForDead = (pid: number): Promise<void> =>
  Effect.runPromise(
    Effect.gen(function* () {
      for (let attempt = 0; attempt < 200 && processAlive(pid); attempt++)
        yield* Effect.sleep(Duration.millis(10));
    }),
  );

afterEach(() =>
  Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  ).then(() => undefined),
);

describe("NDJSON RPC session", () => {
  it("does not treat lifetime output as queued output", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("echo"));
          for (let index = 0; index < 20; index++) {
            const value = `response-${index}`;
            expect(
              yield* session.call(String(index), replyFrame(String(index), value), 1_000),
            ).toBe(value);
          }
        }),
      ),
    ));

  it("isolates a timed-out call without failing concurrent or later calls", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("delay-first"));
          const slow = yield* session
            .call("slow", replyFrame("slow", "late"), 25)
            .pipe(Effect.result, Effect.forkScoped);
          expect(yield* session.call("fast", replyFrame("fast", "concurrent"), 1_000)).toBe(
            "concurrent",
          );
          expect((yield* Fiber.join(slow))._tag).toBe("Failure");
          expect(yield* session.call("later", replyFrame("later", "still-live"), 1_000)).toBe(
            "still-live",
          );
        }),
      ),
    ));

  it("force-cleans a failed session whose child ignores direct SIGTERM", () =>
    fs.mkdtemp(join(tmpdir(), "pi-subagents-rpc-session-")).then((directory) => {
      directories.push(directory);
      const pidPath = join(directory, "fixture.pid");
      return Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const session = yield* makeNdjsonRpcSession<string>(options("protocol-error", pidPath));
            const result = yield* Effect.result(
              session.call("request", replyFrame("request", "x"), 1_000),
            );
            expect(result._tag).toBe("Failure");
          }),
        ),
      )
        .then(() => fs.readFile(pidPath, "utf8"))
        .then((rawPid) => {
          const pid = Number(rawPid);
          expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
          return waitForDead(pid).then(() => {
            expect(processAlive(pid)).toBe(false);
          });
        });
    }));

  it("shares successful cleanup across concurrent and repeated closes", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const session = yield* makeNdjsonRpcSession<string>(options("echo"));
          expect(yield* session.call("ready", replyFrame("ready", "ready"), 1_000)).toBe("ready");
          const exits = yield* Effect.all(
            [session.close().pipe(Effect.exit), session.close().pipe(Effect.exit)],
            { concurrency: "unbounded" },
          );
          expect(exits.every(Exit.isSuccess)).toBe(true);
          yield* session.close();
        }),
      ),
    ));

  it("settles queued notification acknowledgements when closing", () =>
    Effect.runPromise(
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
    ));
});
