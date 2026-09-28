/**
 * The control protocol between Pi and one program process on fd 3: a 4-byte big-endian length,
 * then UTF-8 JSON. Pi decodes every child message with a schema; the child trusts Pi.
 */
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

/** Largest frame Pi accepts from a program: 16 MiB of call input or result plus envelope. */
export const MAX_CHILD_FRAME_BYTES = 17 * 1024 * 1024;

/** Largest return value a program sends back, before Pi applies its own output limit. */
export const MAX_RESULT_BYTES = 16 * 1024 * 1024;

const HEADER_BYTES = 4;

export class ProtocolError extends Data.TaggedError("ProtocolError")<{
  /** `in-flight`: queued and running tool inputs together exceeded Pi's hold limit. */
  readonly reason: "oversize" | "in-flight" | "malformed";
}> {}

/** Messages Pi sends to the program process. */
export type ParentMessage =
  | {
      readonly type: "start";
      readonly source: string;
      readonly tools: ReadonlyArray<ReadonlyArray<string>>;
      readonly resultLimit: number;
    }
  | {
      readonly type: "reply";
      readonly seq: number;
      readonly ok: false;
      readonly kind: string;
      readonly message: string;
    }
  | { readonly type: "finish" };

/** Encodes one message. Successful replies carry pre-encoded values; see `encodeReplyFrame`. */
export const encodeFrame = (message: ParentMessage): Uint8Array => {
  const body = new TextEncoder().encode(JSON.stringify(message));
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, HEADER_BYTES);
  return frame;
};

/** A value's JSON text, `null` for values JSON drops, or undefined when it is not JSON data. */
export const encodeValue = <Value>(value: Value): string | undefined => {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return undefined;
  }
};

/** A successful reply around a value the caller already encoded as JSON text. */
export const encodeReplyFrame = (seq: number, valueJson: string): Uint8Array => {
  const body = new TextEncoder().encode(
    `{"type":"reply","seq":${seq},"ok":true,"value":${valueJson}}`,
  );
  const frame = new Uint8Array(HEADER_BYTES + body.byteLength);
  new DataView(frame.buffer).setUint32(0, body.byteLength);
  frame.set(body, HEADER_BYTES);
  return frame;
};

/**
 * Incremental decoder over arbitrary chunk boundaries. It checks each frame's declared length
 * before buffering its body, and copies each body once.
 */
export const makeFrameDecoder = (maxFrameBytes: number) => {
  const chunks: Array<Uint8Array> = [];
  let buffered = 0;
  let expected: number | undefined;

  const take = (count: number): Uint8Array => {
    const out = new Uint8Array(count);
    let filled = 0;
    while (filled < count) {
      const head = chunks[0]!;
      const used = Math.min(head.byteLength, count - filled);
      out.set(head.subarray(0, used), filled);
      filled += used;
      if (used === head.byteLength) chunks.shift();
      else chunks[0] = head.subarray(used);
    }
    buffered -= count;
    return out;
  };

  return (chunk: Uint8Array): Array<Uint8Array> => {
    if (chunk.byteLength > 0) {
      chunks.push(chunk);
      buffered += chunk.byteLength;
    }
    const frames: Array<Uint8Array> = [];
    for (;;) {
      if (expected === undefined) {
        if (buffered < HEADER_BYTES) break;
        const header = take(HEADER_BYTES);
        expected = new DataView(header.buffer, header.byteOffset).getUint32(0);
        if (expected > maxFrameBytes) throw new ProtocolError({ reason: "oversize" });
      }
      if (buffered < expected) break;
      frames.push(take(expected));
      expected = undefined;
    }
    return frames;
  };
};

const Position = Schema.Int.check(Schema.isGreaterThanOrEqualTo(1));
const Text = (maximum: number) => Schema.String.check(Schema.isMaxLength(maximum));

/** Why the program failed, as the child observed it. Pi owns every diagnostic's wording. */
export const ChildFailure = Schema.Struct({
  kind: Schema.Literals(["syntax", "tool", "thrown", "arguments", "closed", "return"]),
  /** How a thrown value escaped: from the program body, an unhandled rejection, or a callback. */
  via: Schema.optionalKey(Schema.Literals(["body", "unhandled", "uncaught"])),
  /** Absent for tool failures, whose diagnostic Pi already recorded. */
  message: Schema.optionalKey(Text(65_536)),
  name: Schema.optionalKey(Text(256)),
  /** A thrown error's `code`, such as Node's `ERR_ACCESS_DENIED`. */
  code: Schema.optionalKey(Text(64)),
  /** Node's module loader raised the error, for example while resolving an import. */
  module: Schema.optionalKey(Schema.Literal(true)),
  /** What Node's permission model refused, such as `FileSystemRead`. */
  permission: Schema.optionalKey(Text(64)),
  /** The path a permission refusal applied to. */
  resource: Schema.optionalKey(Text(4096)),
  /** The request whose tool failure escaped. */
  seq: Schema.optionalKey(Schema.Int),
  tool: Schema.optionalKey(Text(2_048)),
  line: Schema.optionalKey(Position),
  column: Schema.optionalKey(Position),
});
export type ChildFailure = typeof ChildFailure.Type;

const CallMessage = Schema.Struct({
  type: Schema.Literal("call"),
  seq: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  path: Schema.Array(Text(128)).check(Schema.isMinLength(1), Schema.isMaxLength(16)),
  args: Schema.Array(Schema.Unknown),
});

const SuccessMessage = Schema.Struct({
  type: Schema.Literal("result"),
  ok: Schema.Literal(true),
  format: Schema.Literals(["text", "json"]),
  text: Schema.String,
  /** UTF-8 size of the whole value; larger than `text` when the child cut it short. */
  totalBytes: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
});

const FailureMessage = Schema.Struct({
  type: Schema.Literal("result"),
  ok: Schema.Literal(false),
  failure: ChildFailure,
});

export const ChildMessage = Schema.Union([CallMessage, SuccessMessage, FailureMessage]);
export type ChildMessage = typeof ChildMessage.Type;

const decodeMessage = Schema.decodeUnknownEffect(Schema.fromJsonString(ChildMessage));
const utf8 = new TextDecoder("utf-8", { fatal: true });

export const decodeChildMessage = (frame: Uint8Array): Effect.Effect<ChildMessage, ProtocolError> =>
  Effect.try({
    try: () => utf8.decode(frame),
    catch: () => new ProtocolError({ reason: "malformed" }),
  }).pipe(
    Effect.flatMap((text) => decodeMessage(text)),
    Effect.mapError(() => new ProtocolError({ reason: "malformed" })),
  );
