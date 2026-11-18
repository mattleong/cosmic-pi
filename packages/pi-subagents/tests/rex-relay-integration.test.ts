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
import * as Str from "effect/String";
import { nodeFs, nodePath, nodeTemporaryRoot } from "pi-cosmic-core/platform/node-builtins";
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
      block: Schema.String,
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

/** How the fake Rex answers `session.new_block`; see the fixture. */
interface FakeRex {
  readonly replyDelayMs?: number;
  readonly startDelayMs?: number;
}

/**
 * Hosted launches through the real Rex session host, launcher, and process transport, around
 * fixtures standing in for the Rex CLI and for Pi's own command.
 */
const hostedChildren = (session: string, fake: FakeRex = {}) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pisa-relay-" });
    const blocksFile = `${directory}/blocks`;
    // The host looks for `rex` in REX_BIN_DIR; this one is the fixture.
    yield* fs.writeFileString(
      `${directory}/rex`,
      Arr.join(
        [
          "#!/bin/sh",
          `export FAKE_REX_BLOCKS='${blocksFile}'`,
          `export FAKE_REX_REPLY_DELAY_MS=${String(fake.replyDelayMs ?? 0)}`,
          `export FAKE_REX_START_DELAY_MS=${String(fake.startDelayMs ?? 0)}`,
          `exec '${process.execPath}' '${fixturePath("fake-rex.ts")}' "$@"`,
          "",
        ],
        "\n",
      ),
    );
    yield* fs.chmod(`${directory}/rex`, 0o755);
    /** Each block's host process, alive for as long as Rex would keep the block. */
    const blocks = () =>
      nodeFs.existsSync(blocksFile)
        ? Arr.map(
            Arr.filter(
              Str.split(nodeFs.readFileSync(blocksFile, "utf8"), "\n"),
              (line) => line !== "",
            ),
            Number,
          )
        : [];
    // Whatever a failing test leaves, no block outlives it.
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        for (const pid of blocks())
          try {
            process.kill(pid, "SIGTERM");
          } catch {}
      }),
    );
    const host = rexSessionHost({
      environment: { REX_SESSION: session, REX_BLOCK: "block:root", REX_BIN_DIR: directory },
      onResume: () => undefined,
    });
    host.setEnabled(true);
    yield* Effect.addFinalizer(() => Effect.sync(host.close));
    const children = yield* Effect.service(ChildProcess).pipe(
      Effect.provide(
        ChildProcess.layer({
          agentDirectory: directory,
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
    return { directory, host, children, blocks };
  });

describe("a Rex-hosted launch", () => {
  it.live(
    "starts Pi in a block, carries both channels, and ends the block's process with the run",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        // The fixture records which block a window shows in a file named for the session.
        const session = `session-${String(process.pid)}`;
        const placement = nodePath.join(nodeTemporaryRoot(), `fake-rex-${session}.json`);
        yield* Effect.addFinalizer(() => Effect.ignore(fs.remove(placement)));
        const { directory, host, children, blocks } = yield* hostedChildren(session);
        const request = backendLaunch({ runId: "hosted-run", cwd: directory });
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
        ask({ finishing: "green" });
        expect(yield* pollUntil(() => shown === 2)).toBe(true);
        yield* fs.writeFileString(
          placement,
          encodeBlocks({
            blocks: [{ block_id: response?.data.block ?? "", placement: "detached" }],
          }),
        );
        expect(yield* pollUntil(() => settled.length === 3, 800)).toBe(true);
        // A user decision committed just before external hide must beat a synthetic decline.
        expect(settled[2]).toEqual({ answered: "green" });
        yield* Fiber.interrupt(drain);

        const pid = response?.data.pid ?? 0;
        expect(alive(pid)).toBe(true);
        yield* Scope.close(scope, Exit.void);
        expect(yield* pollUntil(() => !alive(pid))).toBe(true);
        expect(Arr.every(blocks(), (block) => !alive(block))).toBe(true);
        expect(host.pane("hosted-run")).toBeUndefined();
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    30_000,
  );

  // Rex has made the block, but its answer hasn't reached the launcher when the run is stopped:
  // the transport's SIGTERM to the launcher's group also ends the Rex call, so the launcher never
  // learns the block's ID, and a block whose program exits quickly stays in Rex.
  it.live(
    "closes a block whose creation the run's stop interrupted, though its Pi had started",
    () =>
      Effect.gen(function* () {
        const { directory, children, blocks } = yield* hostedChildren(
          `session-${String(process.pid)}-started`,
          { replyDelayMs: 20_000 },
        );
        const scope = yield* Scope.make();
        const child = yield* children
          .spawn(backendLaunch({ runId: "started-run", cwd: directory }))
          .pipe(Scope.provide(scope));
        yield* child.send({ type: "get_state", id: "one" });
        const pid = yield* Effect.gen(function* () {
          while (true) {
            const event = yield* Queue.take(child.events);
            child.acknowledge(event);
            if (event.type !== "rpc_message") continue;
            const response = decodeResponse(event.value);
            if (Option.isSome(response)) return response.value.data.pid;
          }
        }).pipe(Effect.timeout("10 seconds"));
        const [block] = blocks();
        expect(block !== undefined && alive(block) && alive(pid)).toBe(true);

        yield* Scope.close(scope, Exit.void);
        expect(alive(pid)).toBe(false);
        expect(yield* pollUntil(() => !alive(block ?? 0), 50, "100 millis")).toBe(true);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    30_000,
  );

  it.live(
    "closes a block whose creation the run's stop interrupted, before its Pi could start",
    () =>
      Effect.gen(function* () {
        const { directory, children, blocks } = yield* hostedChildren(
          `session-${String(process.pid)}-late`,
          { replyDelayMs: 20_000, startDelayMs: 1_000 },
        );
        const scope = yield* Scope.make();
        yield* children
          .spawn(backendLaunch({ runId: "late-run", cwd: directory }))
          .pipe(Scope.provide(scope));
        expect(yield* pollUntil(() => blocks().length === 1)).toBe(true);
        yield* Scope.close(scope, Exit.void);
        // The block's program starts after the launcher has gone, finds nothing to run, and
        // closes its own block.
        const [block] = blocks();
        expect(yield* pollUntil(() => !alive(block ?? 0), 50, "100 millis")).toBe(true);
      }).pipe(Effect.provide(NodeFileSystem.layer)),
    30_000,
  );
});
