import * as Arr from "effect/Array";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import * as Str from "effect/String";
import type * as Scope from "effect/Scope";
import { connect, createServer, type Server, type Socket } from "node:net";
import type { InboundMessage } from "../../src/transport/protocol.ts";

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const RequestId = Schema.Union([Schema.String, Schema.Finite]);

/** The wire forms of the requests and answers these peers exchange. */
const WireRequest = Schema.TaggedStruct("Request", {
  id: RequestId,
  tag: Schema.String,
  payload: Schema.Unknown,
  headers: Schema.Array(Schema.String),
});
const WireSuccess = Schema.TaggedStruct("Success", { value: Schema.Unknown });
const WireExit = Schema.TaggedStruct("Exit", {
  requestId: RequestId,
  exit: Schema.Union([WireSuccess, Schema.TaggedStruct("Failure", {})]),
});
const HelloAnswer = Schema.TaggedStruct("Exit", {
  exit: Schema.TaggedStruct("Success", {
    value: Schema.Struct({ nonce: Schema.String, proof: Schema.String }),
  }),
});

export const decodeHelloAnswer = Schema.decodeUnknownOption(HelloAnswer);
const decodeExitAnswer = Schema.decodeUnknownOption(WireExit);
const decodeRequest = Schema.decodeOption(Schema.fromJsonString(WireRequest));

/** Whether an answer reports its request's success; none when it isn't an answer at all. */
export const answerSucceeded = (answer: unknown): Option.Option<boolean> =>
  Option.map(decodeExitAnswer(answer), ({ exit }) => Predicate.isTagged(exit, "Success"));

/** Feeds each complete line of the chunks it is given to `onLine`. */
const lineReader = (onLine: (line: string) => void) => {
  let buffer = "";
  return (data: Buffer) => {
    buffer += data.toString();
    let newline = Fn.pipe(buffer, Str.indexOf("\n"));
    while (Option.isSome(newline)) {
      onLine(Fn.pipe(buffer, Str.slice(0, newline.value)));
      buffer = Fn.pipe(buffer, Str.slice(newline.value + 1));
      newline = Fn.pipe(buffer, Str.indexOf("\n"));
    }
  };
};

/**
 * A raw listener at `socket` that hands each connection to `onConnection`. Releasing it closes
 * the listener and the connections still open.
 */
export const listenAt = (socket: string, onConnection: (peer: Socket) => void) =>
  Effect.acquireRelease(
    Effect.callback<{ readonly server: Server; readonly peers: Set<Socket> }>((resume) => {
      const peers = new Set<Socket>();
      const server = createServer((peer) => {
        peers.add(peer);
        peer.on("error", () => undefined);
        peer.on("close", () => peers.delete(peer));
        onConnection(peer);
      });
      server.listen(socket, () => resume(Effect.succeed({ server, peers })));
    }),
    ({ server, peers }) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
        for (const peer of peers) peer.destroy();
      }),
  );

/**
 * Forwards connections at `socket` to `target`. `onClientData` sees everything a client sends and
 * says whether to forward it; refusing drops both ends, as a recipient that dies mid-request would.
 */
export const relay = (socket: string, target: string, onClientData: (data: string) => boolean) =>
  listenAt(socket, (client) => {
    const upstream = connect(target);
    const drop = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("data", (data) => {
      if (onClientData(data.toString())) upstream.write(data);
      else drop();
    });
    upstream.on("data", (data) => client.write(data));
    upstream.on("error", () => undefined);
    for (const end of [client, upstream]) end.on("close", drop);
  });

/** What a fooled client would believe each request achieved. */
const forgedValue = (tag: string) =>
  Match.value(tag).pipe(
    Match.when("Hello", () => ({
      nonce: Fn.pipe("1", Str.repeat(64)),
      proof: Fn.pipe("2", Str.repeat(64)),
    })),
    Match.when("Deliver", () => ({ disposition: "woken" })),
    Match.when("Describe", () => ({ sessionId: "forged", cwd: "/forged", state: "idle" })),
    Match.orElse(() => null),
  );

const forged = (requestId: string | number, tag: string) =>
  `${JSON.stringify(
    WireExit.make({ requestId, exit: WireSuccess.make({ value: forgedValue(tag) }) }),
  )}\n`;

/** A request payload these tests send by hand. */
export type RawPayload = { readonly nonce: string } | { readonly proof: string } | InboundMessage;

/** A hand-driven client speaking the wire format directly, to step outside the real client. */
export interface RawPeer {
  /** Writes bytes as they are, framed or not. */
  readonly write: (raw: string) => void;
  readonly request: (id: number, tag: string, payload: RawPayload) => void;
  /** The next answer for request `id`. */
  readonly answer: (id: number) => Effect.Effect<unknown>;
  /** Completes when the server closes the connection. */
  readonly closed: Effect.Effect<void>;
}

export const rawPeer = (socket: string): Effect.Effect<RawPeer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const closed = yield* Deferred.make<void>();
    const lines: Array<unknown> = [];
    const waiting = new Set<() => void>();
    const readLines = lineReader((line) => {
      const decoded = decodeLine(line);
      if (Option.isSome(decoded)) lines.push(decoded.value);
    });
    const connection = yield* Effect.acquireRelease(
      Effect.callback<Socket>((resume) => {
        const opened = connect(socket, () => resume(Effect.succeed(opened)));
        opened.on("data", (data) => {
          readLines(data);
          for (const wake of waiting) wake();
        });
        opened.on("error", () => undefined);
        opened.on("close", () => Deferred.doneUnsafe(closed, Effect.void));
      }),
      (opened) => Effect.sync(() => opened.destroy()),
    );
    const answer = (id: number): Effect.Effect<unknown> =>
      Effect.callback<unknown>((resume) => {
        const check = () => {
          const found = Arr.findFirst(lines, (line) => {
            const exit = decodeExitAnswer(line);
            return Option.isSome(exit) && String(exit.value.requestId) === String(id);
          });
          if (Option.isNone(found)) return;
          waiting.delete(check);
          resume(Effect.succeed(found.value));
        };
        waiting.add(check);
        check();
        return Effect.sync(() => waiting.delete(check));
      });
    const write = (raw: string) => void connection.write(raw);
    return {
      write,
      request: (id, tag, payload) =>
        write(`${JSON.stringify(WireRequest.make({ id, tag, payload, headers: [] }))}\n`),
      answer,
      closed: Deferred.await(closed),
    };
  });

/**
 * A listener at `socket` that doesn't hold the token: it records everything it receives and
 * answers every request, and some never made, with forged successes.
 */
export const rogueListener = (
  socket: string,
): Effect.Effect<{ readonly received: () => string }, never, Scope.Scope> =>
  Effect.gen(function* () {
    let received = "";
    yield* listenAt(socket, (peer) => {
      // Answers ahead of time for the requests a fooled client would send next.
      for (const id of [1, 2, 3]) peer.write(forged(id, "Deliver"));
      const readLines = lineReader((line) => {
        const request = decodeRequest(line);
        if (Option.isSome(request)) peer.write(forged(request.value.id, request.value.tag));
      });
      peer.on("data", (data) => {
        received += data.toString();
        readLines(data);
      });
    });
    return { received: () => received };
  });
