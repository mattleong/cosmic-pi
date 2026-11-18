import * as NodeFileSystem from "@effect/platform-node/NodeFileSystem";
import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { nodeCreateConnection } from "pi-cosmic-core/platform/node-builtins";
import { deferredPromise, pollUntil } from "pi-cosmic-core/testing";
import {
  REX_ANSWER_NOTE,
  REX_ASK_MESSAGE,
  REX_FRAME,
  rexFrame,
  splitRexFrames,
} from "../src/boundary/rex-session-frames.mjs";
import { rexSessionHost, type RexLauncherMessage } from "../src/boundary/rex-session-host.ts";

const REX = { REX_SESSION: "session:1", REX_BLOCK: "block:root", REX_BIN_DIR: "/opt/rex" };
const run = { runId: "run-1", name: "auth-review", cwd: "/project" };
const decodeConfig = Schema.decodeUnknownSync(
  Schema.fromJsonString(
    Schema.Struct({
      rex: Schema.String,
      session: Schema.String,
      label: Schema.String,
      command: Schema.Array(Schema.String),
      adoptBlock: Schema.optional(Schema.String),
    }),
  ),
);

const encodeBlocks = Schema.encodeSync(
  Schema.fromJsonString(
    Schema.Struct({
      blocks: Schema.Array(Schema.Struct({ block_id: Schema.String, placement: Schema.String })),
    }),
  ),
);

const fixture = (environment: NodeJS.ProcessEnv = REX) => {
  /** Every call that changes something; listing blocks only reads. */
  const calls: Array<ReadonlyArray<string>> = [];
  const resumed: Array<readonly [string, string]> = [];
  let rexWorks = true;
  /** Whether Rex shows the child's block in a window, which the user can change in Rex itself. */
  let shown = false;
  const host = rexSessionHost({
    environment,
    onResume: (runId, text) => resumed.push([runId, text]),
    rex: (_executable, args) => {
      if (args[2] === "session.list_blocks")
        return encodeBlocks({
          blocks: [{ block_id: "block:child", placement: shown ? "placed" : "detached" }],
        });
      calls.push(args);
      if (!rexWorks) return undefined;
      if (args[0] === "split") {
        shown = true;
        return '{"block_ids":["block:child","block:root"]}';
      }
      if (args[2] === "session.move_block") shown = true;
      if (args[2] === "session.detach_block" || args[1] === "close") shown = false;
      return "{}";
    },
  });
  const launchConfig = () => decodeConfig(host.launch(run, ["node", "pi"])?.args[1] ?? "{}");
  return {
    host,
    calls,
    resumed,
    launchConfig,
    refuseRex: () => {
      rexWorks = false;
    },
    /** The user hides the pane with Rex's own key. */
    hideInRex: () => {
      shown = false;
    },
    /** A launch whose launcher has reported its block. */
    hosted: () => {
      host.setEnabled(true);
      const config = launchConfig();
      host.observe(run.runId, { type: "pi_subagents_rex_block", blockId: "block:child" });
      return config;
    },
  };
};

describe("Rex session host", () => {
  it.live("opens a writer display on demand and revokes only the display on hide or teardown", () =>
    Effect.gen(function* () {
      const h = fixture();
      h.host.setEnabled(true);
      yield* Effect.addFinalizer(() => Effect.sync(h.host.close));
      const enter = (runId: string) =>
        Effect.gen(function* () {
          const closed = deferredPromise();
          const keys: string[] = [];
          const output: string[] = [];
          let signal: AbortSignal | undefined;
          expect(
            h.host.toggleWriterView(runId, "writer", (terminal, owner) => {
              signal = owner;
              terminal.start(
                (key) => keys.push(key),
                () => undefined,
              );
              terminal.write("Writer transcript");
              return closed.promise;
            }),
          ).toBe(true);
          const socketPath = h.calls.at(-1)?.at(-2);
          if (!socketPath) return yield* Effect.die("Missing viewer socket");
          const peer = nodeCreateConnection(socketPath);
          peer.setEncoding("utf8");
          peer.on("data", (data: string) => output.push(data));
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              peer.destroy();
              closed.resolve();
            }),
          );
          peer.write('{"columns":80,"rows":24}\n');
          expect(yield* pollUntil(() => output.length > 0)).toBe(true);
          peer.write('{"key":"x"}\n');
          expect(yield* pollUntil(() => keys.includes("x"))).toBe(true);
          expect(signal?.aborted).toBe(false);
          expect(h.host.parkTarget(runId)).toBeUndefined();
          return { ended: () => signal?.aborted };
        });
      const first = yield* enter("writer");
      h.host.released("writer"); // releasing a backend isn't releasing its display
      expect(first.ended()).toBe(false);
      expect(h.host.toggleWriterView("writer", "writer", () => Promise.resolve())).toBe(true);
      expect(first.ended()).toBe(true);
      const second = yield* enter("writer");
      h.host.setParking(false);
      expect(second.ended()).toBe(true);
    }).pipe(Effect.scoped),
  );

  it("hosts a run only while the setting is on and Pi runs inside Rex", () => {
    const inside = fixture();
    expect(inside.host.launch(run, ["node", "pi"])).toBeUndefined();
    inside.host.setEnabled(true);
    expect(inside.launchConfig()).toMatchObject({
      rex: "/opt/rex/rex",
      session: "session:1",
      label: "subagent: auth-review",
      command: ["node", "pi"],
    });

    const outside = fixture({});
    outside.host.setEnabled(true);
    expect(outside.host.isAvailable()).toBe(false);
    expect(outside.host.launch(run, ["node", "pi"])).toBeUndefined();
  });

  it("shows a hidden block beside the root's pane and hides it again", () => {
    const h = fixture();
    expect(h.host.pane(run.runId)).toBeUndefined();
    h.hosted();
    let changes = 0;
    h.host.subscribe(() => {
      changes += 1;
    });
    expect(h.host.pane(run.runId)).toBe("hidden");

    expect(h.host.togglePane(run.runId)).toBe(true);
    expect(h.host.pane(run.runId)).toBe("open");
    expect(h.calls.at(-2)?.slice(0, 3)).toEqual(["api", "call", "session.move_block"]);
    expect(h.calls.at(-2)?.[3]).toContain('"anchor_block_id":"block:root"');
    // The opened pane takes the focus.
    expect(h.calls.at(-1)).toEqual(["block", "focus", "-s", "session:1", "block:child"]);

    expect(h.host.togglePane(run.runId)).toBe(true);
    expect(h.host.pane(run.runId)).toBe("hidden");
    expect(h.calls.at(-1)?.[2]).toBe("session.detach_block");
    expect(changes).toBe(2);

    // A pane the user hid with Rex's own key opens again: Rex says what the pane is now.
    h.host.togglePane(run.runId);
    h.hideInRex();
    expect(h.host.togglePane(run.runId)).toBe(true);
    expect(h.calls.at(-2)?.[2]).toBe("session.move_block");
    h.host.togglePane(run.runId);

    // A pane Rex wouldn't open stays hidden, and the caller is told.
    h.refuseRex();
    expect(h.host.togglePane(run.runId)).toBe(false);
    expect(h.host.pane(run.runId)).toBe("hidden");
    expect(h.host.togglePane("unknown")).toBe(false);
  });

  it("parks only a session whose pane is open, and never while its runtime is ending", () => {
    const h = fixture();
    h.hosted();
    expect(h.host.parkTarget(run.runId)).toBeUndefined();
    h.host.togglePane(run.runId);
    h.host.setParking(false);
    expect(h.host.parkTarget(run.runId)).toBeUndefined();
    h.host.setParking(true);
    // Hidden in Rex since, it has no reader to stay for.
    h.hideInRex();
    expect(h.host.parkTarget(run.runId)).toBeUndefined();
    h.host.togglePane(run.runId);
    const target = h.host.parkTarget(run.runId);
    expect(target?.socket).toBeTypeOf("string");
    expect(target?.token).toHaveLength(48);
    h.host.close();
  });

  it("forgets an ended launcher even if it asked to park but never connected", () => {
    const h = fixture();
    h.hosted();
    h.host.released(run.runId);
    expect(h.host.pane(run.runId)).toBeUndefined();

    h.hosted();
    h.host.togglePane(run.runId);
    h.host.parkTarget(run.runId);
    h.host.released(run.runId);
    expect(h.host.pane(run.runId)).toBeUndefined();
    h.host.close();
  });

  it.live(
    "resumes a parked session from what the user typed, then hands it to a new launcher",
    () =>
      Effect.gen(function* () {
        const h = fixture();
        h.hosted();
        h.host.togglePane(run.runId);
        const target = h.host.parkTarget(run.runId)!;

        const received: Array<{ readonly kind: string; readonly body: string }> = [];
        const parked = nodeCreateConnection(target.socket);
        parked.setEncoding("utf8");
        parked.on("data", (chunk: string) => received.push(...splitRexFrames(chunk).frames));
        parked.on("error", () => undefined);
        parked.write(rexFrame(REX_FRAME.hello, { token: target.token, pid: 1, parked: true }));
        expect(yield* pollUntil(() => received[0]?.kind === REX_FRAME.accept)).toBe(true);
        h.host.released(run.runId);
        parked.write(rexFrame(REX_FRAME.resume, { text: "also check the tests" }));
        expect(yield* pollUntil(() => h.resumed.length === 1)).toBe(true);
        expect(h.resumed).toEqual([[run.runId, "also check the tests"]]);

        // The resumed run's launcher serves the same block instead of starting one.
        expect(h.launchConfig().adoptBlock).toBe("block:child");
        h.host.observe(run.runId, {
          type: "pi_subagents_rex_listening",
          socket: "/tmp/relay",
          token: "relay-token",
        });
        expect(yield* pollUntil(() => received.length === 2)).toBe(true);
        expect(received[1]).toEqual(
          splitRexFrames(rexFrame(REX_FRAME.adopt, { socket: "/tmp/relay", token: "relay-token" }))
            .frames[0],
        );
        // The adopted session leaves the root's socket, and its pane stays open.
        parked.end(rexFrame(REX_FRAME.adopt, { ok: true }));
        yield* Effect.sleep("50 millis");
        expect(h.host.pane(run.runId)).toBe("open");

        // A stranger's token is turned away.
        const stranger = nodeCreateConnection(target.socket);
        stranger.on("error", () => undefined);
        let closed = false;
        stranger.on("close", () => {
          closed = true;
        });
        stranger.write(rexFrame(REX_FRAME.hello, { token: "guess", pid: 2, parked: true }));
        expect(yield* pollUntil(() => closed)).toBe(true);
        h.host.close();
      }).pipe(Effect.provide(NodeFileSystem.layer)),
  );

  it.live("ends a parked session when its pane is hidden or the root closes", () =>
    Effect.gen(function* () {
      const h = fixture();
      h.hosted();
      h.host.togglePane(run.runId);
      const target = h.host.parkTarget(run.runId)!;
      const parked = nodeCreateConnection(target.socket);
      parked.on("error", () => undefined);
      parked.write(rexFrame(REX_FRAME.hello, { token: target.token, pid: 1, parked: true }));
      yield* Effect.sleep("50 millis");
      h.host.released(run.runId);

      // Asked from inside the parked session, hiding ends it, as hiding it from Activity does.
      parked.write(rexFrame(REX_FRAME.hide, { ok: true }));
      expect(yield* pollUntil(() => h.calls.at(-1)?.[1] === "close")).toBe(true);
      expect(h.calls.at(-1)).toEqual(["block", "close", "-s", "session:1", "block:child"]);
      // Rex closing the block ends the session, whose connection going is what forgets it.
      parked.destroy();
      expect(yield* pollUntil(() => h.host.pane(run.runId) === undefined)).toBe(true);
      h.host.close();
      // The session already went with its pane, so the root closing has no block left to close.
      expect(Arr.filter(h.calls, (call) => call[1] === "close")).toHaveLength(1);
    }),
  );
});

describe("a questionnaire for the user in a hosted run's pane", () => {
  const request = { questions: [] };
  /** A hosted run whose launcher the host can speak to, and what each ask settled with. */
  const asking = () => {
    const h = fixture();
    h.hosted();
    const sent: RexLauncherMessage[] = [];
    h.host.attach(run.runId, (message) => sent.push(message));
    const settled: Array<Schema.Json | undefined> = [];
    let shown = 0;
    const ask = () =>
      h.host.ask(run.runId, request, {
        shown: () => {
          shown += 1;
        },
        settled: (outcome) => settled.push(outcome),
      });
    const answer = (word: {
      readonly shown?: boolean;
      readonly declined?: boolean;
      readonly outcome?: Schema.Json;
    }) =>
      h.host.observe(run.runId, {
        type: REX_ANSWER_NOTE,
        answer: { id: sent.at(-1)?.ask.id ?? "", ...word },
      });
    return { ...h, sent, settled, shownCount: () => shown, ask, answer };
  };

  it("goes to the run's pane only while a window shows it", () => {
    const h = asking();
    // Hidden: the caller is told at once, and nothing reaches the launcher.
    h.ask();
    expect(h.settled).toEqual([undefined]);
    expect(h.sent).toEqual([]);

    h.host.togglePane(run.runId);
    h.ask();
    expect(h.sent).toMatchObject([{ type: REX_ASK_MESSAGE, ask: { request } }]);
    h.answer({ shown: true });
    expect(h.shownCount()).toBe(1);
    expect(h.settled).toHaveLength(1);
    const outcome = { outcome: "cancelled", answers: [] };
    h.answer({ outcome });
    expect(h.settled.at(-1)).toEqual(outcome);
    // A settled questionnaire hears nothing more.
    h.answer({ outcome });
    expect(h.settled).toHaveLength(2);
  });

  it("delivers a submitted answer even after Activity hides the pane", () => {
    const h = asking();
    h.host.togglePane(run.runId);
    h.ask();
    h.host.togglePane(run.runId);
    expect(h.settled).toEqual([]);
    h.answer({ outcome: { answers: ["red"] } });
    h.answer({ declined: true });
    expect(h.settled).toEqual([{ answers: ["red"] }]);
  });

  it("refuses new pane asks once a park was requested", () => {
    const h = asking();
    h.host.togglePane(run.runId);
    expect(h.host.parkTarget(run.runId)).toBeDefined();
    h.ask();
    expect(h.sent).toEqual([]);
    expect(h.settled).toEqual([undefined]);
    h.host.close();
  });

  it("comes back to the caller when the user can no longer answer it in the pane", () => {
    for (const leave of ["declined", "hidden", "released", "withdrawn"] as const) {
      const h = asking();
      h.host.togglePane(run.runId);
      const withdraw = h.ask();
      const id = h.sent.at(-1)?.ask.id;
      if (leave === "declined") h.answer({ declined: true });
      if (leave === "hidden") h.host.togglePane(run.runId);
      if (leave === "released") h.host.released(run.runId);
      if (leave === "withdrawn") void withdraw();
      if (leave === "withdrawn" || leave === "hidden") {
        expect(h.settled).toEqual([]);
        h.answer({ declined: true });
      }
      expect(h.settled).toEqual([undefined]);
      // The pane is told to stop showing what the root took back itself.
      expect(
        Arr.some(h.sent, (message) => "withdraw" in message.ask && message.ask.id === id),
      ).toBe(leave === "hidden" || leave === "withdrawn");
    }
  });
});

describe("Rex session frames", () => {
  it("splits whole frames from an unfinished rest", () => {
    const text = `${rexFrame("R", { a: 1 })}${rexFrame("C", "x\ny")}H{"tok`;
    expect(splitRexFrames(text)).toEqual({
      frames: [
        { kind: "R", body: '{"a":1}' },
        { kind: "C", body: '"x\\ny"' },
      ],
      rest: 'H{"tok',
    });
    expect(splitRexFrames("")).toEqual({ frames: [], rest: "" });
  });
});
