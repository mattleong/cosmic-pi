// Private in-process supervisor bridge integration test over real loopback sockets.
import { connect, createServer, type AddressInfo, type Server, type Socket } from "node:net";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Queue from "effect/Queue";
import * as Scope from "effect/Scope";
import { afterEach, describe, expect, it } from "vitest";
import {
  openPiSupervisorBridge,
  type PiSupervisorBridgeClient,
  PiSupervisorBridgeError,
  type PiSupervisorBridgeOpenOptions,
} from "../src/boundary/pi-supervisor-bridge-client.ts";
import type { SupervisorMcpToolArgumentsByName as SupervisorToolArgumentsByName } from "../src/supervisor/mcp-contract.ts";
import {
  makeSupervisorChannel,
  type SupervisorChannelHandle,
  type SupervisorChannelOpenRequest,
} from "../src/boundary/supervisor-channel.ts";
import { MAX_PARENT_MESSAGE_CHARS } from "../src/run/limits.ts";
import { nodeFsPromises as fs, nodePath } from "./support/node-builtins.ts";
import {
  makeTemporaryDirectory,
  removeTemporaryDirectories,
} from "./support/temporary-directories.ts";

const { join } = nodePath;

afterEach(removeTemporaryDirectories);

const privateDirectory = () => makeTemporaryDirectory("pi-subagents-pi-bridge-");

interface LoopbackPeer {
  readonly port: number;
  readonly clients: ReadonlyArray<Socket>;
}

/**
 * A scoped raw loopback peer. Without an upstream it accepts, drains, and never answers; with one
 * it forwards both ways and shows `onServerData` each server chunk before relaying it.
 */
const loopbackPeer = (upstreamPort?: number, onServerData?: (chunk: Buffer) => void) =>
  Effect.acquireRelease(
    Effect.callback<LoopbackPeer & { readonly server: Server; readonly clients: Socket[] }>(
      (resume) => {
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
          upstream.on("data", (chunk: Buffer) => {
            onServerData?.(chunk);
            client.write(chunk);
          });
        });
        server.listen(0, "127.0.0.1", () =>
          // SAFETY: A TCP server listening on a loopback port reports its AddressInfo.
          resume(Effect.succeed({ port: (server.address() as AddressInfo).port, clients, server })),
        );
      },
    ),
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

/** Writes a private connection config for `port`, copying a real channel's identity when given. */
const peerConfig = (port: number, channel?: SupervisorChannelHandle) =>
  Effect.promise(() =>
    Promise.all([
      privateDirectory(),
      channel
        ? fs.readFile(channel.metadata.connectionConfigPath, "utf8")
        : `{"version":3,"runId":"agent-raw-peer","host":"127.0.0.1","port":0,"token":"${"a".repeat(64)}"}`,
    ]).then(([directory, source]) => {
      const path = join(directory, "connection.json");
      return fs
        .writeFile(path, source.replace(/"port":\d+/u, `"port":${port}`), { mode: 0o600 })
        .then(() => path);
    }),
  );

const waitFor = (predicate: () => boolean) =>
  Effect.gen(function* () {
    for (let attempt = 0; attempt < 500 && !predicate(); attempt += 1)
      yield* Effect.sleep(Duration.millis(10));
    expect(predicate()).toBe(true);
  });

const bridgeFailure = (effect: Effect.Effect<string, PiSupervisorBridgeError>) =>
  Effect.flip(effect).pipe(
    Effect.tap((error) => Effect.sync(() => expect(error).toBeInstanceOf(PiSupervisorBridgeError))),
  );

interface BridgeHarness {
  readonly channel: SupervisorChannelHandle;
  readonly client: PiSupervisorBridgeClient;
  /** The forwarding peer between bridge and channel, when `forward` was requested. */
  readonly peer: LoopbackPeer;
  readonly bridgeScope: Scope.Closeable;
}

/**
 * Opens a real channel and a bridge client in its own child scope, ready at assignment epoch 1.
 * With `forward`, the bridge reaches the channel through a forwarding loopback peer.
 */
const withBridgeChannel = <E>(
  request: SupervisorChannelOpenRequest,
  body: (harness: BridgeHarness) => Effect.Effect<void, E, Scope.Scope>,
  options: {
    readonly bridge?: PiSupervisorBridgeOpenOptions;
    readonly forward?: { readonly onServerData?: (chunk: Buffer) => void };
  } = {},
) =>
  privateDirectory().then((directory) =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const channel = yield* makeSupervisorChannel({ agentDirectory: directory }).open(request);
          const peer = options.forward
            ? yield* loopbackPeer(channel.metadata.port, options.forward.onServerData)
            : { port: channel.metadata.port, clients: [] };
          const configPath = options.forward
            ? yield* peerConfig(peer.port, channel)
            : channel.metadata.connectionConfigPath;
          const bridgeScope = yield* Scope.fork(yield* Effect.scope);
          const client = yield* openPiSupervisorBridge(configPath, options.bridge).pipe(
            Scope.provide(bridgeScope),
          );
          yield* channel.awaitReady;
          yield* channel.setAssignmentEpoch(1);
          yield* body({ channel, client, peer, bridgeScope });
        }),
      ),
    ),
  );

const proxyInput = (argumentsJson = "{}") => ({
  tool: "subagent_list",
  arguments_json: argumentsJson,
});

describe("in-process delegated-Pi supervisor bridge", () => {
  it("disconnects an interrupted open while its parent scope stays open", () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const peer = yield* loopbackPeer();
          const opening = yield* openPiSupervisorBridge(yield* peerConfig(peer.port)).pipe(
            Effect.forkScoped,
          );
          yield* waitFor(() => peer.clients.length === 1);
          yield* Fiber.interrupt(opening);
          yield* socketClosed(peer.clients[0]);
        }),
      ),
    ));

  it(
    "fails an open whose peer disconnects and never redials",
    () =>
      Effect.runPromise(
        Effect.scoped(
          Effect.gen(function* () {
            const peer = yield* loopbackPeer();
            const opening = yield* openPiSupervisorBridge(yield* peerConfig(peer.port)).pipe(
              Effect.forkScoped,
            );
            yield* waitFor(() => peer.clients.length === 1);
            peer.clients[0]?.destroy();
            expect(Exit.isFailure(yield* Fiber.await(opening))).toBe(true);
            yield* Effect.sleep(Duration.seconds(1));
            expect(peer.clients).toHaveLength(1);
          }),
        ),
      ),
    15_000,
  );

  it("releases the supervisor connection when its scope closes", () =>
    withBridgeChannel(
      { runId: "agent-pi-release" },
      ({ client, peer, bridgeScope }) =>
        Effect.gen(function* () {
          yield* Scope.close(bridgeScope, Exit.void);
          yield* socketClosed(peer.clients[0]);
          expect(
            yield* bridgeFailure(client.call("supervisor_progress", { message: "late" })),
          ).toMatchObject({ reason: "transport" });
        }),
      { forward: {} },
    ));

  it(
    "fails in-flight and later calls promptly after a watch failure and never redials",
    () =>
      withBridgeChannel(
        { runId: "agent-pi-watch-failure" },
        ({ channel, client, peer }) =>
          Effect.gen(function* () {
            const question = yield* client
              .call("supervisor_question", { message: "Still there?" })
              .pipe(Effect.flip, Effect.forkScoped);
            expect(yield* Queue.take(channel.events)).toMatchObject({ kind: "question" });
            peer.clients[0]?.destroy();
            expect(yield* Fiber.join(question)).toMatchObject({
              reason: "transport",
              message: "Supervisor RPC delivery did not settle within its bound.",
            });
            expect(
              yield* bridgeFailure(
                client.call("supervisor_progress", { message: "after failure" }),
              ),
            ).toMatchObject({
              reason: "transport",
              message: "Private supervisor channel is unavailable or has no active assignment.",
            });
            yield* Effect.sleep(Duration.seconds(1));
            expect(peer.clients).toHaveLength(1);
          }),
        { forward: {} },
      ),
    15_000,
  );

  // Measures the accepted failure mode: a delegated-Pi event-loop stall that begins after a ping
  // and before its pong is read, and outlasts the 5 s ping interval, ends the channel.
  it("ends the channel when an event-loop stall outlasts one ping interval", () => {
    let stalled = false;
    return withBridgeChannel(
      { runId: "agent-pi-stall" },
      ({ client, peer }) =>
        Effect.gen(function* () {
          yield* waitFor(() => stalled).pipe(Effect.timeout(Duration.seconds(8)));
          yield* Effect.sleep(Duration.millis(200));
          expect(
            yield* bridgeFailure(client.call("supervisor_progress", { message: "after" })),
          ).toMatchObject({ reason: "transport" });
          expect(peer.clients).toHaveLength(1);
        }),
      {
        forward: {
          onServerData: (chunk) => {
            if (stalled || !chunk.includes('"_tag":"Pong"')) return;
            stalled = true;
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5_500);
          },
        },
      },
    );
  }, 30_000);

  it("supports concurrent progress, exact question/reply, and report delivery", () =>
    withBridgeChannel({ runId: "agent-pi-bridge" }, ({ channel, client }) =>
      Effect.gen(function* () {
        const question = yield* client
          .call("supervisor_question", { message: "Which branch?" })
          .pipe(Effect.forkScoped);
        const progress = yield* client
          .call("supervisor_progress", { message: "Inspecting branches" })
          .pipe(Effect.forkScoped);

        const first = yield* Queue.take(channel.events);
        const second = yield* Queue.take(channel.events);
        const contacts = [first, second].filter((event) => event.type === "supervisor_contact");
        expect(contacts).toHaveLength(2);
        const questionEvent = contacts.find(
          (event) => event.type === "supervisor_contact" && event.kind === "question",
        );
        expect(questionEvent).toMatchObject({
          type: "supervisor_contact",
          assignmentEpoch: 1,
          message: "Which branch?",
        });
        if (!questionEvent || questionEvent.type !== "supervisor_contact")
          throw new Error("missing question");
        yield* channel.reply(questionEvent.requestId, "main");
        expect(yield* Fiber.join(question)).toContain("Parent reply: main");
        expect(yield* Fiber.join(progress)).toContain("Progress delivered");

        const reportCall = yield* client
          .call("supervisor_submit_report", {
            delivery_id: "generation-1",
            report: "Complete report",
          })
          .pipe(Effect.forkScoped);
        const report = yield* Queue.take(channel.events);
        expect(report).toMatchObject({
          type: "report",
          runId: "agent-pi-bridge",
          assignmentEpoch: 1,
          sequence: 1,
          deliveryId: "generation-1",
          text: "Complete report",
        });
        expect(yield* Fiber.join(reportCall)).toContain("Final report accepted");
      }),
    ));

  it("delivers root-pushed descendant outcomes and survives a throwing host callback", () => {
    const notifications: string[] = [];
    return withBridgeChannel(
      { runId: "agent-pi-notification", allowPiProxy: true },
      ({ channel }) =>
        Effect.gen(function* () {
          yield* channel.deliverNotification("First outcome.");
          yield* channel.deliverNotification("Descendant report ready.");
          expect(notifications).toEqual(["First outcome.", "Descendant report ready."]);
        }),
      {
        bridge: {
          onNotification: (message) => {
            notifications.push(message);
            if (notifications.length === 1) throw new Error("session is shutting down");
          },
        },
      },
    );
  });

  it("round-trips the private coordinator proxy and rejects a refused proxy call", () =>
    withBridgeChannel({ runId: "agent-pi-proxy", allowPiProxy: true }, ({ channel, client }) =>
      Effect.gen(function* () {
        const payload = '{"content":[{"type":"text","text":"No child runs."}]}';
        for (const ok of [true, false]) {
          const call = yield* client
            .call("supervisor_pi_proxy", proxyInput())
            .pipe(Effect.exit, Effect.forkScoped);
          const event = yield* Queue.take(channel.events);
          expect(event).toMatchObject({
            type: "proxy_request",
            tool: "subagent_list",
            argumentsJson: "{}",
          });
          if (event.type !== "proxy_request") throw new Error("expected proxy request");
          yield* event.respond(ok, payload);
          const exit = yield* Fiber.join(call);
          if (ok) expect(exit).toEqual(Exit.succeed(payload));
          else
            expect(exit).toEqual(
              Exit.fail(
                new PiSupervisorBridgeError({
                  reason: "rejected",
                  message: "The private supervisor rejected this call.",
                }),
              ),
            );
        }
      }),
    ));

  it("fails fast above 16 concurrent calls without queueing", () =>
    withBridgeChannel({ runId: "agent-pi-admission", allowPiProxy: true }, ({ channel, client }) =>
      Effect.gen(function* () {
        for (let index = 0; index < 16; index += 1)
          yield* client.call("supervisor_pi_proxy", proxyInput()).pipe(Effect.forkScoped);
        for (let index = 0; index < 16; index += 1) yield* Queue.take(channel.events);
        expect(
          yield* bridgeFailure(client.call("supervisor_progress", { message: "over capacity" })),
        ).toMatchObject({ reason: "capacity" });
        expect(Queue.sizeUnsafe(channel.events)).toBe(0);
      }),
    ));

  it("rejects an oversized proxy frame locally and keeps the connection", () =>
    withBridgeChannel({ runId: "agent-pi-frame", allowPiProxy: true }, ({ channel, client }) =>
      Effect.gen(function* () {
        // Each control character escapes to six bytes, so this stays within the character bound.
        const oversized = "\u0001".repeat(600_000);
        expect(
          yield* bridgeFailure(client.call("supervisor_pi_proxy", proxyInput(oversized))),
        ).toMatchObject({ reason: "capacity" });
        expect(Queue.sizeUnsafe(channel.events)).toBe(0);
        expect(yield* client.call("supervisor_progress", { message: "still open" })).toContain(
          "Progress delivered",
        );
      }),
    ));

  it("preserves the maximum parent reply", () =>
    withBridgeChannel({ runId: "agent-pi-max-reply" }, ({ channel, client }) =>
      Effect.gen(function* () {
        const question = yield* client
          .call("supervisor_question", { message: "Return the maximum reply" })
          .pipe(Effect.forkScoped);
        const questionEvent = yield* Queue.take(channel.events);
        if (questionEvent.type !== "supervisor_contact")
          return yield* Effect.die("missing maximum-reply question");
        const reply = "x".repeat(MAX_PARENT_MESSAGE_CHARS);
        yield* channel.reply(questionEvent.requestId, reply);
        const delivered = yield* Fiber.join(question);
        expect(delivered).toBe(`Parent reply: ${reply}`);
      }),
    ));

  it("propagates question cancellation without failing the bridge session", () =>
    withBridgeChannel({ runId: "agent-pi-cancel" }, ({ channel, client }) =>
      Effect.gen(function* () {
        const question = yield* client
          .call("supervisor_question", { message: "Cancel this exact question" })
          .pipe(Effect.forkScoped);
        const questionEvent = yield* Queue.take(channel.events);
        expect(questionEvent).toMatchObject({
          type: "supervisor_contact",
          kind: "question",
          assignmentEpoch: 1,
        });
        yield* Fiber.interrupt(question);
        expect(yield* Queue.take(channel.events)).toMatchObject({
          type: "supervisor_question_cancelled",
          assignmentEpoch: 1,
        });

        expect(
          yield* client.call("supervisor_progress", { message: "Bridge remains live" }),
        ).toContain("Progress delivered");
        expect(yield* Queue.take(channel.events)).toMatchObject({
          type: "supervisor_contact",
          kind: "progress",
          message: "Bridge remains live",
        });
      }),
    ));

  it("opens only the helper's bounded, normalized configuration path grammar", () =>
    withBridgeChannel({ runId: "agent-pi-config-path" }, ({ channel }) =>
      Effect.gen(function* () {
        const directory = yield* Effect.promise(privateDirectory);
        const source = yield* Effect.promise(() =>
          fs.readFile(channel.metadata.connectionConfigPath, "utf8"),
        );
        for (const name of ["connection.json", "line\nbreak.json"])
          yield* Effect.promise(() => fs.writeFile(join(directory, name), source, { mode: 0o600 }));
        expect(
          yield* Effect.flip(openPiSupervisorBridge(join(directory, "line\nbreak.json"))),
        ).toMatchObject({ reason: "transport" });
        yield* openPiSupervisorBridge(join(directory, "missing", "..", "connection.json"));
      }),
    ));

  it("rejects malformed tool input locally", () =>
    withBridgeChannel({ runId: "agent-pi-invalid" }, ({ channel, client }) =>
      Effect.gen(function* () {
        // SAFETY: This locally constructed test fixture satisfies the declared contract used by this assertion.
        const callHostileInput = client.call as (
          name: "supervisor_progress",
          input: SupervisorToolArgumentsByName["supervisor_progress"] & {
            readonly extra: boolean;
          },
        ) => ReturnType<typeof client.call>;
        expect(
          yield* bridgeFailure(
            callHostileInput("supervisor_progress", { message: "ok", extra: true }),
          ),
        ).toMatchObject({ reason: "rejected" });
        expect(Queue.sizeUnsafe(channel.events)).toBe(0);
      }),
    ));
});
