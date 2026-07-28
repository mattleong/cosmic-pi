// Test-owned Node streams exercise the process boundary room.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
import { once } from "node:events";
import { PassThrough } from "node:stream";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import { describe, expect, it, vi } from "vitest";
import {
  attachBoundedLineParser,
  makeByteBoundedQueueRoom,
} from "../src/boundary/bounded-line-parser.ts";

describe("bounded child line parser", () => {
  it("flushes split UTF-8 and the final unterminated Pi RPC frame", async () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const overflow = vi.fn();
    attachBoundedLineParser(stream, {
      maxLineBytes: 1_024,
      maxQueuedBytes: 2_048,
      onLine: (line) => lines.push(line),
      onOverflow: overflow,
    });
    const frame = Buffer.from('{"type":"message_end","text":"café 🌌"}', "utf8");
    const split = frame.indexOf(Buffer.from("é", "utf8")) + 1;
    stream.write(frame.subarray(0, split));
    stream.write(frame.subarray(split));
    const ended = once(stream, "end");
    stream.end();
    await ended;

    expect(lines).toEqual(['{"type":"message_end","text":"café 🌌"}']);
    expect(overflow).not.toHaveBeenCalled();
  });

  it.each(["Pi", "Claude"])(
    "bounds ordinary sequential %s line backlog until downstream acknowledgement",
    () => {
      const stream = new PassThrough();
      const queue = Effect.runSync(Queue.dropping<object>(512));
      const retained: object[] = [];
      const overflow = vi.fn();
      const room = makeByteBoundedQueueRoom(queue, 42, overflow);
      attachBoundedLineParser(stream, {
        maxLineBytes: 64,
        maxQueuedBytes: 128,
        onLine: (line) => {
          const event = { line };
          if (room.offer(event, Buffer.byteLength(line, "utf8") + 1)) retained.push(event);
        },
        onOverflow: overflow,
      });

      stream.write(`${"a".repeat(20)}\n`);
      stream.write(`${"b".repeat(20)}\n`);
      stream.write(`${"c".repeat(20)}\n`);

      expect(retained).toHaveLength(2);
      expect(room.queuedBytes()).toBe(42);
      expect(overflow).toHaveBeenCalledOnce();
      room.acknowledge(retained[0]!);
      expect(room.queuedBytes()).toBe(21);
    },
  );

  it("fails one parser room safely when re-entrant chunks overflow", () => {
    const stream = new PassThrough();
    const lines: string[] = [];
    const overflow = vi.fn();
    attachBoundedLineParser(stream, {
      maxLineBytes: 64,
      maxQueuedBytes: 32,
      onLine: (line) => {
        lines.push(line);
        // Re-entrant chunks remain queued until this callback returns and are bounded in aggregate.
        stream.emit("data", Buffer.from("x".repeat(20), "utf8"));
        stream.emit("data", Buffer.from("y".repeat(20), "utf8"));
      },
      onOverflow: overflow,
    });
    stream.write(Buffer.from("seed\n", "utf8"));

    expect(lines).toEqual(["seed"]);
    expect(overflow).toHaveBeenCalledOnce();
  });
});
