import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { BoundedProcessError, type BoundedProcessRequest } from "pi-cosmic-core";
import type { BoundedProcessResult, BoundedProcessRunner } from "pi-cosmic-core/platform/process";
import { describe, expect } from "vitest";
import { makeRexClient, type RexSplitInput } from "../src/rex.ts";

const result = (overrides: Partial<BoundedProcessResult> = {}): BoundedProcessResult => ({
  code: 0,
  signal: null,
  stdout: "",
  stderr: "",
  overflowed: false,
  timedOut: false,
  cleanupUnconfirmed: false,
  ...overrides,
});

const ENVIRONMENT = {
  HOME: "/home/test",
  PATH: "/bin",
  REX_BIN_DIR: "/opt/rex/bin",
  REX_SERVER: "unix:///tmp/rex.sock",
  OPENAI_API_KEY: "secret",
  PI_SESSION_FILE: "/sessions/parent.jsonl",
};

const SPLIT: RexSplitInput = {
  sessionId: "session:s",
  anchorBlockId: "block:anchor",
  direction: "right",
  cwd: "/projects/demo",
  command: { startsShell: true, argv: ["/bin/zsh", "-i", "-c", 'exec "$0" "$@"', "pi", "x; y"] },
};

const client = (
  respond: (
    request: BoundedProcessRequest,
  ) => Effect.Effect<BoundedProcessResult, BoundedProcessError>,
) => {
  const requests: BoundedProcessRequest[] = [];
  const runner: BoundedProcessRunner = (request) => {
    requests.push(request);
    return respond(request);
  };
  return { rex: makeRexClient(ENVIRONMENT, runner), requests };
};

describe("Rex client", () => {
  it.effect("runs the Rex binary with only its own environment and verbatim child arguments", () =>
    Effect.gen(function* () {
      const { rex, requests } = client(() =>
        Effect.succeed(result({ stdout: '{"block_ids":["block:new"]}' })),
      );
      expect(yield* rex.split(SPLIT)).toBe("block:new");
      const [request] = requests;
      expect(request?.executable).toBe("/opt/rex/bin/rex");
      expect(request?.environment).toEqual({
        HOME: "/home/test",
        PATH: "/bin",
        REX_BIN_DIR: "/opt/rex/bin",
        REX_SERVER: "unix:///tmp/rex.sock",
      });
      const args = request?.args ?? [];
      expect(args).toContain("--shell=none");
      expect(args.slice(args.indexOf("--") + 1)).toEqual(SPLIT.command.argv);
    }),
  );

  it.effect("reports a missing anchor pane as safe to retry elsewhere", () =>
    Effect.gen(function* () {
      const { rex } = client(() =>
        Effect.succeed(
          result({ code: 3, stderr: 'Error: block target "block:anchor" not found\n' }),
        ),
      );
      const error = yield* Effect.flip(rex.split(SPLIT));
      expect(error.reason).toBe("anchorMissing");
    }),
  );

  it.effect("treats split failures after launch as possibly applied", () =>
    Effect.gen(function* () {
      const outcomes: ReadonlyArray<Effect.Effect<BoundedProcessResult, BoundedProcessError>> = [
        Effect.succeed(result({ code: 1, stderr: "Error: server went away" })),
        Effect.succeed(result({ timedOut: true })),
        Effect.succeed(result({ stdout: "not json" })),
        Effect.fail(BoundedProcessError.make({ operation: "stream", message: "closed" })),
      ];
      for (const outcome of outcomes) {
        const { rex } = client(() => outcome);
        expect((yield* Effect.flip(rex.split(SPLIT))).reason).toBe("uncertain");
      }
    }),
  );

  it.effect("treats failures that prevented launch as confirmed", () =>
    Effect.gen(function* () {
      const spawnFailure = client(() =>
        Effect.fail(BoundedProcessError.make({ operation: "spawn", message: "ENOENT" })),
      );
      expect((yield* Effect.flip(spawnFailure.rex.split(SPLIT))).reason).toBe("failed");
      const sizeFailure = client(() => Effect.succeed(result({ code: 1, stderr: "boom" })));
      const location = { sessionId: "session:s", blockId: "block:b" };
      expect((yield* Effect.flip(sizeFailure.rex.paneColumns(location))).reason).toBe("failed");
    }),
  );

  it.effect("reads a pane's width", () =>
    Effect.gen(function* () {
      const { rex } = client(() =>
        Effect.succeed(result({ stdout: '{"columns":140,"rows":40,"owner":null}' })),
      );
      expect(yield* rex.paneColumns({ sessionId: "session:s", blockId: "block:b" })).toBe(140);
    }),
  );
});
