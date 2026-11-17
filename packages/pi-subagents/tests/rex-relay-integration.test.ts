import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { nodePath, nodeTemporaryRoot } from "pi-cosmic-core/platform/node-builtins";
import { pollUntil } from "pi-cosmic-core/testing";
import { ChildProcess, type ChildWireEvent } from "../src/boundary/child-process.ts";
import { rexSessionHost } from "../src/boundary/rex-session-host.ts";
import { backendLaunch } from "./fixtures/backend-launch.ts";

const fixturePath = (name: string) => nodePath.join(import.meta.dirname, "fixtures", name);
const decodeResponse = Schema.decodeUnknownOption(
  Schema.Struct({
    type: Schema.Literal("response"),
    data: Schema.Struct({
      runId: Schema.String,
      argv: Schema.Array(Schema.String),
      pid: Schema.Int,
    }),
  }),
);
const encodeBlocks = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      blocks: Schema.Array(Schema.Struct({ block_id: Schema.String, placement: Schema.String })),
    }),
  ),
);
const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("a Rex-hosted launch", () => {
  it.live(
    "starts Pi in a block, carries both channels, and ends the block's process with the run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pisa-relay-" });
        // The host looks for `rex` in REX_BIN_DIR; this one is the fixture.
        yield* fs.writeFileString(
          `${directory}/rex`,
          `#!/bin/sh\nexec '${process.execPath}' '${fixturePath("fake-rex.ts")}' "$@"\n`,
        );
        yield* fs.chmod(`${directory}/rex`, 0o755);
        // The fixture records which block a window shows in a file named for the session.
        const session = `session-${String(process.pid)}`;
        const placement = nodePath.join(nodeTemporaryRoot(), `fake-rex-${session}.json`);
        yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(placement)));
        const host = rexSessionHost({
          environment: {
            REX_SESSION: session,
            REX_BLOCK: "block:root",
            REX_BIN_DIR: directory,
          },
          onResume: () => undefined,
        });
        host.setEnabled(true);
        const request = backendLaunch({ runId: "hosted-run", cwd: directory });
        const children = yield* Effect.service(ChildProcess).pipe(
          Effect.provide(
            ChildProcess.layer({
              agentDirectory: directory,
              // The launch is the real one, around a fixture standing in for Pi's own command.
              rexHost: {
                ...host,
                launch: (run, command) =>
                  host.launch(run, [
                    process.execPath,
                    fixturePath("fake-rex-child.ts"),
                    ...command.slice(2, 4),
                  ]),
              },
            }),
          ),
        );
        const scope = yield* Scope.make();
        const child = yield* children.spawn(request).pipe(Scope.provide(scope));
        const seen: ChildWireEvent[] = [];
        const next = Effect.gen(function* () {
          const event = yield* Queue.take(child.events).pipe(Effect.timeout("10 seconds"));
          child.acknowledge(event);
          seen.push(event);
          return event;
        });
        const until = (matches: (event: ChildWireEvent) => boolean) =>
          Effect.gen(function* () {
            while (!Arr.some(seen, matches)) yield* next;
            return Arr.findFirst(seen, matches).pipe(Option.getOrThrow);
          });

        yield* child.send({ type: "get_state", id: "one" });
        const answered = yield* until(
          (event) => event.type === "rpc_message" && Option.isSome(decodeResponse(event.value)),
        );
        const response =
          answered.type === "rpc_message"
            ? Option.getOrThrow(decodeResponse(answered.value))
            : undefined;
        // The run's environment reached the block through the private file, and Pi's own
        // arguments through the block's command.
        expect(response?.data.runId).toBe("hosted-run");
        expect(response?.data.argv).toEqual(["--model", request.model]);
        expect(yield* until((event) => event.type === "parent_contact")).toMatchObject({
          value: { type: "user_input", text: "typed" },
        });
        expect(host.pane("hosted-run")).toBe("hidden");

        // A questionnaire for the user goes to the pane only once a window shows it.
        const settled: Array<Schema.Json | undefined> = [];
        let shown = 0;
        const ask = (questions: Schema.Json) =>
          host.ask("hosted-run", questions, {
            shown: () => {
              shown += 1;
            },
            settled: (outcome) => settled.push(outcome),
          });
        ask({ answer: "hidden" });
        expect(settled).toEqual([undefined]);
        expect(host.togglePane("hosted-run")).toBe(true);
        ask({ answer: "red" });
        // The launcher's word reaches the host as the run's events are read.
        const drain = yield* Effect.forkScoped(Effect.forever(next));
        expect(yield* pollUntil(() => settled.length === 2)).toBe(true);
        expect(settled[1]).toEqual({ answered: "red" });
        expect(shown).toBe(1);
        // The user hides the pane in Rex itself, which only the launcher notices: the
        // questionnaire it still shows comes back to be asked where the user can see it.
        ask({});
        expect(yield* pollUntil(() => shown === 2)).toBe(true);
        yield* fs.writeFileString(
          placement,
          encodeBlocks({
            blocks: [
              { block_id: `block:${String(response?.data.pid ?? 0)}`, placement: "detached" },
            ],
          }),
        );
        expect(yield* pollUntil(() => settled.length === 3, 800)).toBe(true);
        expect(settled[2]).toBeUndefined();
        yield* Fiber.interrupt(drain);

        const pid = response?.data.pid ?? 0;
        expect(alive(pid)).toBe(true);
        yield* Scope.close(scope, Exit.void);
        expect(yield* pollUntil(() => !alive(pid))).toBe(true);
        expect(host.pane("hosted-run")).toBeUndefined();
        host.close();
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    30_000,
  );
});
