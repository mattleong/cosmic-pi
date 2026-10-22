import { connect, createServer, type Server, type Socket } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import * as RpcTest from "effect/rpc/RpcTest";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { openSupervisorClient } from "../src/boundary/supervisor-client.ts";
import { SupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import {
  PARENT_REPLY_PREFIX,
  SupervisorChannelConfigSchema,
  SupervisorChannelIdSchema,
  SupervisorRpcGroup,
} from "../src/supervisor/protocol.ts";
import { runSupervisorTool, type SupervisorToolClient } from "../src/supervisor/tool-call.ts";
import { nodeFsPromises as fs } from "./support/node-builtins.ts";

interface LoopbackPeer {
  readonly port: number;
  readonly clients: Socket[];
  readonly server: Server;
}

const loopbackPeer = (upstreamPort?: number) =>
  Effect.acquireRelease(
    Effect.callback<LoopbackPeer>((resume) => {
      const clients: Socket[] = [];
      const server = createServer((client) => {
        clients.push(client);
        client.on("error", () => client.destroy());
        if (upstreamPort === undefined) {
          client.resume();
          return;
        }
        const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
        upstream.on("error", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
        client.on("data", (chunk) => upstream.write(chunk));
        upstream.on("data", (chunk) => client.write(chunk));
      });
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        resume(
          address === null || Predicate.isString(address)
            ? Effect.die(new Error("Expected the loopback server to listen on a TCP port."))
            : Effect.succeed({ port: address.port, clients, server }),
        );
      });
    }),
    ({ server, clients }) =>
      Effect.sync(() => {
        for (const client of clients) client.destroy();
        server.close();
      }),
  );

const socketClosed = (socket: Socket | undefined) =>
  Effect.callback<void>((resume) => {
    if (!socket || socket.destroyed) return resume(Effect.void);
    socket.once("close", () => resume(Effect.void));
  });

const waitForConnection = (peer: LoopbackPeer) =>
  Effect.gen(function* () {
    while (peer.clients.length === 0) yield* Effect.sleep("10 millis");
  }).pipe(Effect.timeout("5 seconds"));

const rawConfig = (port: number) =>
  Schema.decodeSync(SupervisorChannelConfigSchema)({
    version: 3,
    runId: "agent-native-client",
    host: "127.0.0.1",
    port,
    token: "a".repeat(64),
  });

const progress = (client: SupervisorToolClient) =>
  runSupervisorTool(client, { kind: "progress", message: "Still connected?" }, (exit) => exit);

describe("native supervisor client lifetime", () => {
  it.live("disconnects an interrupted open while its parent scope stays open", () =>
    Effect.gen(function* () {
      const peer = yield* loopbackPeer();
      const opening = yield* openSupervisorClient(rawConfig(peer.port)).pipe(Effect.forkScoped);
      yield* waitForConnection(peer);
      yield* Fiber.interrupt(opening);
      yield* socketClosed(peer.clients[0]);
    }),
  );

  for (const failure of ["scope close", "watch disconnect"] as const)
    it.live(`releases the connection and rejects later calls after ${failure}`, () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("pi-subagents-native-client-");
        const channel = yield* SupervisorChannel.use((channels) =>
          channels.open({ runId: "agent-native-client" }),
        ).pipe(Effect.provide(SupervisorChannel.layer({ agentDirectory: directory })));
        const source = yield* Effect.promise(() =>
          fs.readFile(channel.metadata.connectionConfigPath, "utf8"),
        );
        const config = yield* Schema.decodeEffect(
          Schema.fromJsonString(SupervisorChannelConfigSchema),
        )(source);
        const peer = yield* loopbackPeer(config.port);
        const clientScope = yield* Scope.fork(yield* Effect.scope);
        const client = yield* openSupervisorClient({ ...config, port: peer.port }).pipe(
          Scope.provide(clientScope),
        );
        yield* channel.awaitReady;
        yield* channel.setAssignmentEpoch(1);
        if (failure === "scope close") {
          yield* Scope.close(clientScope, Exit.void);
        } else {
          const question = yield* runSupervisorTool(
            client,
            { kind: "question", message: "Is the parent still connected?" },
            (exit) => exit,
          ).pipe(Effect.exit, Effect.forkScoped);
          expect(yield* Queue.take(channel.events)).toMatchObject({ kind: "question" });
          peer.clients[0]?.destroy();
          expect(Exit.isFailure(yield* Fiber.join(question))).toBe(true);
        }
        yield* Deferred.await(client.closed);
        yield* socketClosed(peer.clients[0]);
        expect(yield* progress(client).pipe(Effect.flip)).toMatchObject({
          code: "channel_unavailable",
        });
        yield* Effect.sleep("1 second");
        expect(peer.clients).toHaveLength(1);
      }),
    );
});

const unused = () => Effect.never;

// An in-memory parent whose acknowledgement of its reply waits until the test releases it.
const gatedReplyParent = Effect.gen(function* () {
  const acknowledging = yield* Deferred.make<void>();
  const releaseAcknowledgement = yield* Deferred.make<void>();
  const handlers = SupervisorRpcGroup.toLayer({
    SupervisorOpenSession: () => Effect.succeed({ assignmentEpoch: 1 }),
    SupervisorWatchAssignments: () => Stream.never,
    SupervisorAcknowledgeAssignment: unused,
    SupervisorProgress: unused,
    SupervisorWarning: unused,
    SupervisorQuestion: () =>
      Effect.succeed({
        questionId: SupervisorChannelIdSchema.make("question-1"),
        message: "Take the left path.",
      }),
    SupervisorAcknowledgeQuestionReply: () =>
      Deferred.succeed(acknowledging, undefined).pipe(
        Effect.andThen(Deferred.await(releaseAcknowledgement)),
      ),
    SupervisorReport: unused,
    SupervisorAgentList: unused,
    SupervisorAgentSend: unused,
    SupervisorAgentRead: unused,
  });
  const rpc = yield* RpcTest.makeClient(SupervisorRpcGroup).pipe(Effect.provide(handlers));
  const { version, runId, token } = rawConfig(1);
  const client: SupervisorToolClient = {
    rpc,
    auth: { version, runId, token },
    assignmentEpoch: () => 1,
    closed: yield* Deferred.make<void>(),
  };
  return { client, acknowledging, releaseAcknowledgement };
});

describe("parent replies", () => {
  it.effect("delivers a reply whose acknowledgement began before the call was cancelled", () =>
    Effect.gen(function* () {
      const { client, acknowledging, releaseAcknowledgement } = yield* gatedReplyParent;
      const delivered = yield* Deferred.make<Exit.Exit<{ readonly text: string }, unknown>>();
      const call = yield* runSupervisorTool(
        client,
        { kind: "question", message: "Which path?" },
        (exit) => Deferred.succeed(delivered, exit),
      ).pipe(Effect.forkChild({ startImmediately: true }));

      // The parent has handed over its reply, so cancelling now can't return it.
      yield* Deferred.await(acknowledging);
      const cancelling = yield* Fiber.interrupt(call).pipe(
        Effect.forkChild({ startImmediately: true }),
      );
      yield* Deferred.succeed(releaseAcknowledgement, undefined);
      yield* Fiber.join(cancelling);

      expect(yield* Deferred.await(delivered)).toEqual(
        Exit.succeed({ text: `${PARENT_REPLY_PREFIX}Take the left path.`, isError: false }),
      );
    }),
  );
});
