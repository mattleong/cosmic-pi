import { EventEmitter, once } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  attachBoundedLineParser,
  OVERSIZED_LINE_PREFIX_BYTES,
  type OversizedLine,
} from "../src/boundary/bounded-line-parser.ts";

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

  it("preserves CRLF, suppresses empty lines, and flushes a final frame", () => {
    const { stream, lines, overflow } = collect(1_024, 2_048);
    const ended = once(stream, "end");
    stream.end("\r\nfirst\r\n\nsecond\r");
    return ended.then(() => {
      expect(lines).toEqual(["first", "second"]);
      expect(overflow).not.toHaveBeenCalled();
      return undefined;
    });
  });

  it("detaches input listeners idempotently", () => {
    const { stream, lines, detach } = collect(64, 128);
    stream.emit("data", Buffer.from("before\n", "utf8"));
    detach();
    detach();
    stream.emit("data", Buffer.from("after\n", "utf8"));
    expect(lines).toEqual(["before"]);
  });

  it("summarizes an oversized line by its ends and keeps parsing the lines after it", () => {
    const { stream, lines, oversized, overflow } = collect(4 * 1024, 64 * 1024);
    const body = "x".repeat(10 * 1024);
    const line = `{"type":"agent_end","messages":["${body}"],"willRetry":true}`;
    stream.write(`first\n${line.slice(0, 3_000)}`);
    for (let offset = 3_000; offset < line.length; offset += 1_000)
      stream.write(line.slice(offset, offset + 1_000));
    stream.write('\r\n{"type":"agent_settled"}\n');

    expect(lines).toEqual(["first", '{"type":"agent_settled"}']);
    expect(oversized).toHaveLength(1);
    expect(oversized[0]?.bytes).toBe(Buffer.byteLength(line) + 1);
    expect(oversized[0]?.prefix).toBe(line.slice(0, OVERSIZED_LINE_PREFIX_BYTES));
    expect(oversized[0]?.suffix.endsWith(',"willRetry":true}')).toBe(true);
    expect(overflow).not.toHaveBeenCalled();
  });

  it("reports a final unterminated oversized line when the stream ends", () => {
    const { stream, lines, oversized } = collect(64, 1_024);
    const ended = once(stream, "end");
    const line = `{"type":"turn_end","message":"${"y".repeat(200)}"}`;
    stream.end(line);
    return ended.then(() => {
      expect(lines).toEqual([]);
      expect(oversized.map(({ bytes }) => bytes)).toEqual([Buffer.byteLength(line)]);
      return undefined;
    });
  });

  it("overflows on an oversized line when the reader cannot summarize it", () => {
    const stream = inputStream();
    const lines: string[] = [];
    const overflow = vi.fn();
    attachBoundedLineParser(stream, {
      maxLineBytes: 8,
      maxQueuedBytes: 1_024,
      onLine: (line) => lines.push(line),
      onOverflow: overflow,
    });
    stream.write("123456789");
    stream.write("\nafter\n");

    expect(overflow).toHaveBeenCalledOnce();
    expect(lines).toEqual([]);
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
