// Native supervisor client lifetime integration over real loopback sockets.
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import { temporaryDirectory } from "pi-cosmic-core/testing";
import { openSupervisorClient } from "../src/boundary/supervisor-client.ts";
import { makeSupervisorChannel } from "../src/boundary/supervisor-channel.ts";
import { SupervisorChannelConfigSchema } from "../src/supervisor/protocol.ts";
import { runSupervisorTool, type SupervisorToolClient } from "../src/supervisor/tool-call.ts";
import { nodeFsPromises as fs } from "./support/node-builtins.ts";

interface LoopbackPeer {
  readonly port: number;
  readonly clients: Socket[];
  readonly server: Server;
}

/** An unanswered peer, or a forwarding peer that exposes actual accepted connections. */
const loopbackPeer = (upstreamPort?: number) =>
  Effect.acquireRelease(
    Effect.callback<LoopbackPeer>((resume) => {
      const clients: Socket[] = [];
      const server = createServer((client) => {
        clients.push(client);
        client.on("error", () => client.destroy());
        if (upstreamPort === undefined) return void client.resume();
        const upstream = connect({ host: "127.0.0.1", port: upstreamPort });
        upstream.on("error", () => upstream.destroy());
        upstream.on("close", () => client.destroy());
        client.on("close", () => upstream.destroy());
        client.on("data", (chunk) => upstream.write(chunk));
        upstream.on("data", (chunk) => client.write(chunk));
      });
      server.listen(0, "127.0.0.1", () =>
        // SAFETY: A loopback TCP listener reports AddressInfo.
        resume(Effect.succeed({ port: (server.address() as AddressInfo).port, clients, server })),
      );
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
  runSupervisorTool(client, { kind: "progress", message: "Still connected?" });

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

  it.live("fails an open whose peer disconnects and never redials", () =>
    Effect.gen(function* () {
      const peer = yield* loopbackPeer();
      const opening = yield* openSupervisorClient(rawConfig(peer.port)).pipe(Effect.forkScoped);
      yield* waitForConnection(peer);
      peer.clients[0]?.destroy();
      expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true);
      yield* Effect.sleep("1 second");
      expect(peer.clients).toHaveLength(1);
    }),
  );

  for (const failure of ["scope close", "watch disconnect"] as const)
    it.live(`releases the connection and rejects later calls after ${failure}`, () =>
      Effect.gen(function* () {
        const directory = yield* temporaryDirectory("pi-subagents-native-client-");
        const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open({
          runId: "agent-native-client",
        });
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
          const question = yield* runSupervisorTool(client, {
            kind: "question",
            message: "Is the parent still connected?",
          }).pipe(Effect.exit, Effect.forkScoped);
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
