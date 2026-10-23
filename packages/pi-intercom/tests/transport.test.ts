import { expect, layer } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import type * as Duration from "effect/Duration";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Logger from "effect/Logger";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Tracer from "effect/Tracer";
import * as RpcSerialization from "effect/rpc/RpcSerialization";
import * as TestClock from "effect/testing/TestClock";
import * as NodeSocketServer from "@effect/platform-node/NodeSocketServer";
import {
  boundedNdjsonRpcSerialization,
  nodeFilePlatformLayer,
  runBoundedProcessNode,
} from "pi-cosmic-core";
import { connect, createServer, type Socket } from "node:net";
import * as Option from "effect/Option";
import * as Schedule from "effect/Schedule";
import {
  IntercomClientError,
  deliverMessage,
  describeSession,
  describeSessions,
  readLastMessage,
  type IntercomTarget,
} from "../src/transport/client.ts";
import {
  IntercomRefused,
  MAX_CWD_CHARS,
  MAX_FRAME_BYTES,
  MAX_IDENTITY_CHARS,
  MAX_MESSAGE_CHARS,
  MAX_READ_BYTES,
  type InboundMessage,
} from "../src/transport/protocol.ts";
import {
  guardedRpcProtocol,
  type ConnectionLimits,
  type GuardedProtocol,
  type IntercomConnection,
} from "../src/transport/connections.ts";
import { handshakeKey } from "../src/transport/handshake.ts";
import {
  IntercomInbound,
  serveIntercom,
  type IntercomInboundContract,
} from "../src/transport/server.ts";
import {
  decodeExitAnswer,
  decodeHelloAnswer,
  rawPeer,
  rogueListener,
  type RawPeer,
} from "./support/raw-peer.ts";

const TOKEN = "a".repeat(64);
const OTHER_TOKEN = "b".repeat(64);

const message: InboundMessage = {
  from: { sessionId: "sender-session", name: "sender", cwd: "/sender/project" },
  messageId: "message-1",
  text: "secret message body",
};

interface FakeInbound extends IntercomInboundContract {
  readonly delivered: Array<InboundMessage>;
}

const fakeInbound = (overrides: Partial<IntercomInboundContract> = {}): FakeInbound => {
  const delivered: Array<InboundMessage> = [];
  return {
    delivered,
    describe: Effect.succeed({ sessionId: "receiver", name: "receiver", cwd: "/r", state: "idle" }),
    deliver: (inbound) =>
      Effect.sync(() => {
        delivered.push(inbound);
        return "woken" as const;
      }),
    readLast: Effect.succeed({ text: "latest reply", truncated: false, state: "busy" }),
    ...overrides,
  };
};

/** A short socket directory: macOS temporary directories are too long for `sun_path`. */
const socketPath = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const paths = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped({ directory: "/tmp", prefix: "icom-t-" });
  return paths.join(directory, "s.sock");
});

/** Serves on `socket` until the returned scope or the test's scope closes. */
const startServer = (
  socket: string,
  inbound: IntercomInboundContract,
  token = TOKEN,
  limits?: ConnectionLimits,
) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();
    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    yield* serveIntercom({ socket, token, limits }).pipe(
      Effect.provideService(IntercomInbound, inbound),
      Scope.provide(scope),
    );
    return scope;
  });

const failureOf = <A, E>(effect: Effect.Effect<A, E>) =>
  Effect.map(Effect.result(effect), (result) =>
    Result.isFailure(result) ? result.failure : undefined,
  );

/** Leaves a socket file behind with nothing listening, as a killed process does. */
const abandonSocket = (socket: string) =>
  runBoundedProcessNode({
    executable: process.execPath,
    args: [
      "-e",
      `require("node:net").createServer().listen(${JSON.stringify(socket)}, () => process.kill(process.pid, "SIGKILL"))`,
    ],
    stdoutLimitBytes: 64,
    stderrLimitBytes: 4096,
    timeoutMillis: 10_000,
  }).pipe(Effect.ignore);

/** Writes raw bytes to the socket and waits for the server to close the connection. */
const closedAfterWriting = (socket: string, data: string) =>
  Effect.callback<boolean>((resume) => {
    const connection = connect(socket, () => connection.write(data));
    connection.on("data", () => undefined);
    connection.on("error", () => undefined);
    connection.on("close", () => resume(Effect.succeed(true)));
    return Effect.sync(() => connection.destroy());
  });

const limits = (overrides: Partial<ConnectionLimits>): ConnectionLimits => ({
  maxConnections: 32,
  authenticationDeadline: "10 seconds",
  idleDeadline: "10 seconds",
  ...overrides,
});

/** Completes the handshake by hand, as a client holding `token` would. */
const handshake = (peer: RawPeer, token = TOKEN) =>
  Effect.gen(function* () {
    const key = yield* handshakeKey(token);
    const clientNonce = "c".repeat(64);
    peer.request(0, "Hello", { nonce: clientNonce });
    const hello = decodeHelloAnswer(yield* peer.answer(0));
    const serverNonce = Option.isSome(hello) ? hello.value.exit.value.nonce : "";
    peer.request(1, "Authenticate", {
      proof: yield* key.prove("client", clientNonce, serverNonce),
    });
    return yield* peer.answer(1);
  });

const closesWithin = (peer: RawPeer, duration: Duration.Input) =>
  peer.closed.pipe(
    Effect.as(true),
    Effect.timeoutOrElse({ duration, orElse: () => Effect.succeed(false) }),
  );

/**
 * A clock that holds every reader of the current time until `arrivals` readers wait, then frees
 * them together; everything else passes through to `base`.
 */
const gatheringClock = (base: Clock.Clock, arrivals: number): Clock.Clock => {
  const gathered = Deferred.makeUnsafe<void>();
  let waiting = 0;
  return {
    currentTimeMillisUnsafe: () => base.currentTimeMillisUnsafe(),
    currentTimeMillis: Effect.suspend(() => {
      waiting += 1;
      if (waiting >= arrivals) Deferred.doneUnsafe(gathered, Effect.void);
      return Deferred.await(gathered).pipe(Effect.andThen(base.currentTimeMillis));
    }),
    currentTimeNanosUnsafe: () => base.currentTimeNanosUnsafe(),
    currentTimeNanos: base.currentTimeNanos,
    monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
    monotonicTimeNanos: base.monotonicTimeNanos,
    sleep: (duration) => base.sleep(duration),
  };
};

/** Text JSON escapes to six bytes a code unit, the most it spends on one. */
const escaped = (length: number) => "\u0001".repeat(length);

/** A listener at `socket` that takes connections and never answers them. */
const hangingListener = (socket: string) =>
  Effect.acquireRelease(
    Effect.callback<{
      readonly server: ReturnType<typeof createServer>;
      readonly peers: Set<Socket>;
    }>((resume) => {
      const peers = new Set<Socket>();
      const server = createServer((peer) => {
        peer.on("error", () => undefined);
        peers.add(peer);
      });
      server.listen(socket, () => resume(Effect.succeed({ server, peers })));
    }),
    ({ server, peers }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        for (const peer of peers) peer.destroy();
      }),
  );

/** Forwards connections at `socket` to `target`, recording what clients send. */
const recordingRelay = (socket: string, target: string) =>
  Effect.gen(function* () {
    let sent = "";
    const pipes = new Set<Socket>();
    const server = createServer((client) => {
      const upstream = connect(target);
      pipes.add(client).add(upstream);
      client.on("data", (data) => {
        sent += data.toString();
        upstream.write(data);
      });
      upstream.on("data", (data) => client.write(data));
      for (const end of [client, upstream]) {
        end.on("error", () => undefined);
        end.on("close", () => {
          client.destroy();
          upstream.destroy();
        });
      }
    });
    yield* Effect.acquireRelease(
      Effect.callback<void>((resume) => {
        server.listen(socket, () => resume(Effect.void));
      }),
      () =>
        Effect.callback<void>((resume) => {
          server.close(() => resume(Effect.void));
          for (const pipe of pipes) pipe.destroy();
        }),
    );
    return { sent: () => sent };
  });

// Client call deadlines run on the real clock.
layer(nodeFilePlatformLayer, { excludeTestServices: true })("intercom transport", (it) => {
  it.effect("serves describe, deliver, and read to a caller with the token", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const inbound = fakeInbound();
      yield* startServer(socket, inbound);
      const target: IntercomTarget = { socket, token: TOKEN };

      expect(yield* describeSession(target)).toEqual({
        sessionId: "receiver",
        name: "receiver",
        cwd: "/r",
        state: "idle",
      });
      expect(yield* deliverMessage(target, message)).toBe("woken");
      expect(inbound.delivered).toEqual([message]);
      expect(yield* readLastMessage(target)).toEqual({
        text: "latest reply",
        truncated: false,
        state: "busy",
      });
    }),
  );

  it.effect("passes a recipient's refusal through to the caller", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(
        socket,
        fakeInbound({
          deliver: () => Effect.fail(new IntercomRefused({ code: "session_unavailable" })),
        }),
      );

      const failure = yield* failureOf(deliverMessage({ socket, token: TOKEN }, message));

      expect(failure).toBeInstanceOf(IntercomRefused);
      expect(failure).toMatchObject({ code: "session_unavailable" });
    }),
  );

  it.effect("refuses a caller holding another runtime's token before any handler runs", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const inbound = fakeInbound();
      // The listener at this path is a different runtime than the record the caller read.
      yield* startServer(socket, inbound, OTHER_TOKEN);
      const stale: IntercomTarget = { socket, token: TOKEN };

      const failure = yield* failureOf(deliverMessage(stale, message));
      expect(failure).toBeInstanceOf(IntercomClientError);
      expect(failure).toMatchObject({ reason: "unauthorized" });
      expect(yield* failureOf(describeSession(stale))).toMatchObject({ reason: "unauthorized" });
      expect(yield* failureOf(readLastMessage(stale))).toMatchObject({ reason: "unauthorized" });
      expect(inbound.delivered).toEqual([]);
    }),
  );

  it.effect("never reveals the token or a message to a listener that can't prove the token", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const rogue = yield* rogueListener(socket);

      // Its forged answers, including ones sent before any request, are rejected.
      expect(yield* failureOf(deliverMessage({ socket, token: TOKEN }, message))).toMatchObject({
        reason: "unauthorized",
      });
      expect(yield* failureOf(describeSession({ socket, token: TOKEN }))).toMatchObject({
        reason: "unauthorized",
      });
      expect(yield* failureOf(readLastMessage({ socket, token: TOKEN }))).toMatchObject({
        reason: "unauthorized",
      });

      const received = rogue.received();
      expect(received.length).toBeGreaterThan(0);
      for (const secret of [TOKEN, message.text, message.from.cwd, "Authenticate", "Deliver"])
        expect(received).not.toContain(secret);
    }),
  );

  it.effect("authenticates both ends without the token ever crossing the socket", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const relay = yield* socketPath;
      const inbound = fakeInbound();
      yield* startServer(socket, inbound);
      const recorded = yield* recordingRelay(relay, socket);

      expect(yield* deliverMessage({ socket: relay, token: TOKEN }, message)).toBe("woken");

      expect(inbound.delivered).toEqual([message]);
      expect(recorded.sent()).not.toContain(TOKEN);
    }),
  );

  it.effect("restricts the bound socket to this user", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound());

      expect((yield* fs.stat(socket)).mode & 0o777).toBe(0o600);
    }),
  );

  it.effect("closes a connection that requests anything before the handshake", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const inbound = fakeInbound();
      yield* startServer(socket, inbound);
      const peer = yield* rawPeer(socket);

      peer.request(0, "Deliver", message);

      expect(yield* closesWithin(peer, "5 seconds")).toBe(true);
      expect(inbound.delivered).toEqual([]);
    }),
  );

  it.effect("refuses a wrong proof and admits nothing more on that connection", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const inbound = fakeInbound();
      yield* startServer(socket, inbound);
      const peer = yield* rawPeer(socket);

      const answer = decodeExitAnswer(yield* handshake(peer, OTHER_TOKEN));
      expect(Option.map(answer, ({ exit }) => exit._tag)).toEqual(Option.some("Failure"));
      peer.request(2, "Deliver", message);

      expect(yield* closesWithin(peer, "5 seconds")).toBe(true);
      expect(inbound.delivered).toEqual([]);
    }),
  );

  it.effect("closes a connection with too many requests in flight", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound({ deliver: () => Effect.never }));
      const peer = yield* rawPeer(socket);
      yield* handshake(peer);

      for (let id = 2; id < 12; id += 1)
        peer.request(id, "Deliver", { ...message, messageId: `message-${id}` });

      expect(yield* closesWithin(peer, "5 seconds")).toBe(true);
    }),
  );

  it.effect("closes connections beyond the limit and serves again once they leave", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound(), TOKEN, limits({ maxConnections: 2 }));
      const held = yield* Scope.make();
      yield* Effect.addFinalizer(() => Scope.close(held, Exit.void));
      const first = yield* rawPeer(socket).pipe(Scope.provide(held));
      yield* rawPeer(socket).pipe(Scope.provide(held));
      // The listener has accepted both once the first one's handshake opens.
      first.request(0, "Hello", { nonce: "c".repeat(64) });
      yield* first.answer(0);

      const extra = yield* rawPeer(socket);
      expect(yield* closesWithin(extra, "5 seconds")).toBe(true);

      yield* Scope.close(held, Exit.void);
      const description = yield* describeSession({ socket, token: TOKEN }).pipe(
        Effect.retry({ schedule: Schedule.spaced("50 millis"), times: 40 }),
      );
      expect(description.sessionId).toBe("receiver");
    }),
  );

  it.effect("admits no more connections than the limit when they arrive together", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const arrivals = 12;
      // Every connection is held at its first clock read until all have arrived, then all resume
      // at once: a clock read or any other suspension between the bound check and taking a slot
      // would let them all pass the check.
      yield* startServer(socket, fakeInbound(), TOKEN, limits({ maxConnections: 2 })).pipe(
        Effect.provideService(Clock.Clock, gatheringClock(yield* Clock.Clock, arrivals)),
      );
      const peers = yield* Effect.forEach(Array.from({ length: arrivals }), () => rawPeer(socket), {
        concurrency: "unbounded",
      });

      const served = yield* Effect.forEach(
        peers,
        (peer) => {
          peer.request(0, "Hello", { nonce: "c".repeat(64) });
          return Effect.raceFirst(
            peer.answer(0).pipe(Effect.as(true)),
            peer.closed.pipe(Effect.as(false)),
          );
        },
        { concurrency: "unbounded" },
      );

      expect(served.filter(Boolean)).toHaveLength(2);
    }),
  );

  it.effect("reports a missing socket or one nobody listens on as unreachable", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      expect(yield* failureOf(describeSession({ socket, token: TOKEN }))).toMatchObject({
        reason: "unreachable",
      });

      yield* abandonSocket(socket);
      const fs = yield* FileSystem.FileSystem;
      expect(yield* fs.exists(socket)).toBe(true);
      expect(yield* failureOf(deliverMessage({ socket, token: TOKEN }, message))).toMatchObject({
        reason: "unreachable",
      });
    }),
  );

  it.effect("never takes over a path another listener holds", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound());

      const exit = yield* Effect.exit(startServer(socket, fakeInbound(), OTHER_TOKEN));

      expect(Exit.isFailure(exit)).toBe(true);
      expect((yield* describeSession({ socket, token: TOKEN })).sessionId).toBe("receiver");
    }),
  );

  it.effect("closes a peer that sends an oversized frame and keeps serving others", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound());

      const closed = yield* closedAfterWriting(socket, "x".repeat(MAX_FRAME_BYTES + 1)).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.succeed(false) }),
      );

      expect(closed).toBe(true);
      expect((yield* describeSession({ socket, token: TOKEN })).state).toBe("idle");
    }),
  );

  it.effect("closes the listener and removes its socket when the scope closes", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const socket = yield* socketPath;
      const started = yield* Deferred.make<void>();
      const scope = yield* startServer(
        socket,
        fakeInbound({
          readLast: Effect.andThen(Deferred.succeed(started, undefined), Effect.never),
        }),
      );
      expect(yield* fs.exists(socket)).toBe(true);
      // A request still in flight doesn't hold the listener open.
      const pending = yield* Effect.forkChild(
        readLastMessage({ socket, token: TOKEN }, "10 seconds"),
      );
      yield* Deferred.await(started);

      yield* Scope.close(scope, Exit.void).pipe(
        Effect.timeoutOrElse({ duration: "5 seconds", orElse: () => Effect.die("close hung") }),
      );

      expect(yield* fs.exists(socket)).toBe(false);
      expect(yield* failureOf(describeSession({ socket, token: TOKEN }))).toMatchObject({
        reason: "unreachable",
      });
      expect(yield* failureOf(Fiber.join(pending))).toMatchObject({ reason: "disconnected" });
    }),
  );

  it.effect("bounds each call by its deadline", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound({ describe: Effect.never }));

      expect(
        yield* failureOf(describeSession({ socket, token: TOKEN }, "100 millis")),
      ).toMatchObject({ reason: "timeout" });
    }),
  );

  it.effect("tells a listener that holds the connection past the deadline from a refused one", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* hangingListener(socket);

      // The handshake never finished, so nothing was sent and a `Deliver` is certainly undone.
      expect(
        yield* failureOf(deliverMessage({ socket, token: TOKEN }, message, "100 millis")),
      ).toMatchObject({ reason: "unresponsive" });
      expect(
        yield* failureOf(describeSession({ socket: `${socket}.missing`, token: TOKEN })),
      ).toMatchObject({ reason: "unreachable" });
    }),
  );

  it.effect("carries the largest message and read text even when every character is escaped", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const largest: InboundMessage = {
        from: {
          sessionId: escaped(MAX_IDENTITY_CHARS),
          name: escaped(MAX_IDENTITY_CHARS),
          cwd: escaped(MAX_CWD_CHARS),
        },
        messageId: escaped(128),
        text: escaped(MAX_MESSAGE_CHARS),
      };
      const longest = escaped(MAX_READ_BYTES);
      const inbound = fakeInbound({
        readLast: Effect.succeed({ text: longest, truncated: false, state: "idle" }),
      });
      yield* startServer(socket, inbound);

      expect(yield* deliverMessage({ socket, token: TOKEN }, largest)).toBe("woken");
      expect(inbound.delivered).toEqual([largest]);
      expect((yield* readLastMessage({ socket, token: TOKEN })).text).toBe(longest);
    }),
  );

  it.effect("describes many sessions in order, each with its own outcome", () =>
    Effect.gen(function* () {
      const live = yield* socketPath;
      const silent = yield* socketPath;
      const missing = yield* socketPath;
      yield* startServer(live, fakeInbound());
      yield* startServer(silent, fakeInbound({ describe: Effect.never }));
      const targets = [
        { socket: live, token: TOKEN, label: "live" },
        { socket: silent, token: TOKEN, label: "silent" },
        { socket: missing, token: TOKEN, label: "missing" },
        { socket: live, token: OTHER_TOKEN, label: "foreign" },
      ];

      const results = yield* describeSessions(targets, "200 millis");

      expect(results.map(({ target }) => target.label)).toEqual(targets.map(({ label }) => label));
      expect(
        results.map(({ result }) =>
          Result.isSuccess(result) ? result.success.state : result.failure,
        ),
      ).toMatchObject([
        "idle",
        { reason: "timeout" },
        { reason: "unreachable" },
        { reason: "unauthorized" },
      ]);
    }),
  );

  it.effect("keeps message content, tokens, and paths out of logs and spans", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const logs: Array<unknown> = [];
      const spans: Array<Tracer.NativeSpan> = [];
      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);
          spans.push(span);
          return span;
        },
      });
      const capture = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.withTracer(tracer),
          Effect.provide(
            Logger.layer([
              Logger.make((options) => void logs.push(Logger.formatStructured.log(options))),
            ]),
          ),
        );
      const handled = yield* Deferred.make<void>();
      yield* capture(
        startServer(
          socket,
          fakeInbound({
            deliver: (inbound) =>
              Effect.logInfo("Delivered an intercom message.").pipe(
                Effect.andThen(Deferred.succeed(handled, undefined)),
                Effect.as(inbound.text.length > 0 ? ("queued" as const) : ("held" as const)),
              ),
          }),
        ),
      );
      const target = { socket, token: TOKEN };

      yield* capture(deliverMessage(target, message));
      yield* capture(Effect.ignore(deliverMessage({ socket, token: OTHER_TOKEN }, message)));
      yield* capture(readLastMessage(target));
      yield* Deferred.await(handled);

      const telemetry = yield* Schema.encodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))({
        logs,
        spans: spans.map((span) => ({
          name: span.name,
          attributes: [...span.attributes],
          events: span.events,
        })),
      });
      expect(logs.length).toBeGreaterThan(0);
      for (const secret of [
        message.text,
        message.from.cwd,
        "latest reply",
        TOKEN,
        OTHER_TOKEN,
        socket,
      ])
        expect(telemetry).not.toContain(secret);
    }),
  );
});

/** The guarded connection layer alone, so a test can hold a connection's handshake state. */
const guardedServer = (socket: string, connectionLimits: ConnectionLimits) =>
  Effect.gen(function* () {
    const server = yield* NodeSocketServer.make({ path: socket });
    return yield* guardedRpcProtocol(server, connectionLimits).pipe(
      Effect.provideService(
        RpcSerialization.RpcSerialization,
        boundedNdjsonRpcSerialization(MAX_FRAME_BYTES),
      ),
    );
  });

/** Lets the event loop deliver pending socket events, independently of the test clock. */
const nextTurn = Effect.callback<void>((resume) => {
  const turn = setImmediate(() => resume(Effect.void));
  return Effect.sync(() => clearImmediate(turn));
});

/** The connection the server registered as `clientId`, once the listener has accepted it. */
const accepted = (guarded: GuardedProtocol, clientId: number): Effect.Effect<IntercomConnection> =>
  Effect.suspend(() => {
    const connection = guarded.connection(clientId);
    return connection === undefined
      ? nextTurn.pipe(Effect.andThen(accepted(guarded, clientId)))
      : Effect.succeed(connection);
  });

/** Whether the server answers request `id` rather than closing the connection. */
const answers = (peer: RawPeer, id: number) =>
  Effect.raceFirst(peer.answer(id).pipe(Effect.as(true)), peer.closed.pipe(Effect.as(false)));

// Connection deadlines run on the test clock.
layer(nodeFilePlatformLayer)("intercom connection deadlines and handshake state", (it) => {
  it.effect("closes a connection that doesn't authenticate in time but keeps one that did", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(
        socket,
        fakeInbound(),
        TOKEN,
        limits({ authenticationDeadline: "2 seconds", idleDeadline: "1 hour" }),
      );
      const slow = yield* rawPeer(socket);
      const prompt = yield* rawPeer(socket);
      // Each answer shows its connection is served, so its deadline is running.
      slow.request(0, "Hello", { nonce: "c".repeat(64) });
      yield* slow.answer(0);
      const answer = decodeExitAnswer(yield* handshake(prompt));
      expect(Option.map(answer, ({ exit }) => exit._tag)).toEqual(Option.some("Success"));

      yield* TestClock.adjust("2 seconds");
      yield* slow.closed;

      prompt.request(2, "Deliver", message);
      expect(yield* answers(prompt, 2)).toBe(true);
    }),
  );

  it.effect("closes an authenticated connection only once it has been idle for the deadline", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      yield* startServer(socket, fakeInbound(), TOKEN, limits({ idleDeadline: "10 seconds" }));
      const peer = yield* rawPeer(socket);
      const answer = decodeExitAnswer(yield* handshake(peer));
      expect(Option.map(answer, ({ exit }) => exit._tag)).toEqual(Option.some("Success"));

      yield* TestClock.adjust("6 seconds");
      peer.request(2, "Deliver", message);
      expect(yield* answers(peer, 2)).toBe(true);
      // The first idle check finds traffic 4 seconds old.
      yield* TestClock.adjust("4 seconds");
      peer.request(3, "Deliver", { ...message, messageId: "message-3" });
      expect(yield* answers(peer, 3)).toBe(true);

      yield* TestClock.adjust("10 seconds");
      yield* peer.closed;
    }),
  );

  it.effect("never advances a handshake the authentication deadline closed", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const guarded = yield* guardedServer(
        socket,
        limits({ authenticationDeadline: "2 seconds", idleDeadline: "1 hour" }),
      );
      const slow = yield* rawPeer(socket);
      const pending = yield* accepted(guarded, 0);
      yield* rawPeer(socket);
      const authenticated = yield* accepted(guarded, 1);
      expect(authenticated.advance("fresh", "challenged")).toBe(true);
      expect(authenticated.advance("challenged", "authenticated")).toBe(true);

      // A handler awaiting its proof when the deadline passes finds the connection closed.
      yield* TestClock.adjust("2 seconds");
      yield* slow.closed;

      expect(pending.advance("fresh", "challenged")).toBe(false);
      expect(pending.advance("challenged", "authenticated")).toBe(false);
      expect(pending.phase).toBe("refused");
      expect(authenticated.phase).toBe("authenticated");
    }),
  );

  it.effect("advances a handshake only from the phase it is in", () =>
    Effect.gen(function* () {
      const socket = yield* socketPath;
      const guarded = yield* guardedServer(socket, limits({}));
      yield* rawPeer(socket);
      const connection = yield* accepted(guarded, 0);

      expect(connection.advance("challenged", "authenticated")).toBe(false);
      expect(connection.advance("fresh", "challenged")).toBe(true);
      expect(connection.advance("fresh", "challenged")).toBe(false);
      expect(connection.advance("challenged", "refused")).toBe(true);
      expect(connection.advance("challenged", "authenticated")).toBe(false);
      expect(connection.phase).toBe("refused");
    }),
  );
});
