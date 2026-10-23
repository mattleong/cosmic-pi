import { EventEmitter, once } from "node:events";
import { assert, describe, expect, it, vi } from "vitest";
import {
  attachBoundedLineParser,
  OVERSIZED_LINE_PREFIX_BYTES,
  type OversizedLine,
} from "../src/boundary/bounded-line-parser.ts";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const inputStream = () => {
  const events = new EventEmitter();
  const write = (data: Buffer | string) =>
    events.emit("data", Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8"));
  return Object.assign(events, {
    write,
    end: (data?: Buffer | string) => {
      if (data !== undefined) write(data);
      events.emit("end");
    },
  });
};

const collect = (maxLineBytes: number, maxQueuedBytes: number) => {
  const stream = inputStream();
  const lines: string[] = [];
  const oversized: OversizedLine[] = [];
  const overflow = vi.fn();
  const detach = attachBoundedLineParser(stream, {
    maxLineBytes,
    maxQueuedBytes,
    onLine: (line) => lines.push(line),
    onOversizedLine: (line) => oversized.push(line),
    onOverflow: overflow,
  });
  return { stream, lines, oversized, overflow, detach };
};

describe("bounded child line parser", () => {
  it("flushes split UTF-8 and the final unterminated Pi RPC frame", () => {
    const { stream, lines, overflow } = collect(1_024, 2_048);
    const frame = Buffer.from('{"type":"message_end","text":"café 🌌"}', "utf8");
    const split = frame.indexOf(Buffer.from("é", "utf8")) + 1;
    stream.write(frame.subarray(0, split));
    stream.write(frame.subarray(split));
    const ended = once(stream, "end");
    stream.end();
    return ended.then(() => {
      expect(lines).toEqual(['{"type":"message_end","text":"café 🌌"}']);
      expect(overflow).not.toHaveBeenCalled();
      return undefined;
    });
  });

  it("summarizes an oversized line by its ends and keeps parsing the lines after it", () => {
    const { stream, lines, oversized, overflow } = collect(4 * 1024, 64 * 1024);
    const body = Fn.pipe("x", Str.repeat(10 * 1024));
    const line = `{"type":"agent_end","messages":["${body}"],"willRetry":true}`;
    stream.write(`first\n${Fn.pipe(line, Str.slice(0, 3_000))}`);
    for (let offset = 3_000; offset < line.length; offset += 1_000)
      stream.write(Fn.pipe(line, Str.slice(offset, offset + 1_000)));
    stream.write('\r\n{"type":"agent_settled"}\n');

    expect(lines).toEqual(["first", '{"type":"agent_settled"}']);
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.bytes).toBe(Buffer.byteLength(line) + 1);
    expect(oversized[0]?.prefix).toBe(Fn.pipe(line, Str.slice(0, OVERSIZED_LINE_PREFIX_BYTES)));
    assert(oversized[0] !== undefined);
    expect(Fn.pipe(oversized[0].suffix, Str.endsWith(',"willRetry":true}'))).toBe(true);
    expect(overflow).not.toHaveBeenCalled();
  });

  it("fails one parser room safely when re-entrant chunks overflow", () => {
    const stream = inputStream();
    const lines: string[] = [];
    const overflow = vi.fn();
    attachBoundedLineParser(stream, {
      maxLineBytes: 64,
      maxQueuedBytes: 32,
      onLine: (line) => {
        lines.push(line);
        stream.emit("data", Buffer.from(Fn.pipe("x", Str.repeat(20)), "utf8"));
        stream.emit("data", Buffer.from(Fn.pipe("y", Str.repeat(20)), "utf8"));
      },
      onOverflow: overflow,
    });
    stream.write(Buffer.from("seed\n", "utf8"));

    expect(lines).toEqual(["seed"]);
    expect(overflow).toHaveBeenCalledOnce();
  });
});
