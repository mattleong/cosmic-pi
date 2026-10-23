import { setFlagsFromString } from "node:v8";
import { createContext, runInContext } from "node:vm";
import { it as effectIt } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import { BACKGROUND_LOG_BOUNDS } from "../src/task/bounds.ts";
import { LogBuffer, readLogBuffer, splitLogText } from "../src/task/log-buffer.ts";
import { plainTerminalText } from "../src/task/terminal-text.ts";

const OVERHEAD = BACKGROUND_LOG_BOUNDS.eventOverheadBytes;
// Room for `count` stored events of `bytes` text bytes each.
const budgetFor = (count: number, bytes: number) => count * (bytes + OVERHEAD);

const tailText = (buffer: LogBuffer, tailLines: number) =>
  Arr.join(
    Arr.map(
      readLogBuffer("task-0000000001", buffer, "running", { tailLines }).events,
      (event) => event.text,
    ),
    "",
  );

// One context, created once: a new context for each collection would add its own allocations
// to the heap being measured. A missing gc throws rather than skipping.
setFlagsFromString("--expose-gc");
const gcContext = createContext();
const collectGarbage = Effect.sync(() => {
  runInContext("gc()", gcContext);
});

describe("background log buffer", () => {
  it("keeps detached snapshots through appends, eviction, and repeated compaction", () => {
    const budget = budgetFor(64, 4);
    const buffer = new LogBuffer();
    for (let index = 0; index < 64; index++) buffer.append("stdout", "🙂", index, budget);
    const events = buffer.events;
    const original = Arr.map(events, (event) => ({ ...event }));
    const slice = readLogBuffer("task-0000000001", buffer, "running", { afterCursor: 0 });
    expect(buffer.events).toBe(events);

    for (let index = 64; index < 256; index++) buffer.append("stderr", "🙂", index, budget);
    for (let index = 0; index < 48; index++) buffer.dropOldest();
    buffer.addDropped(7).append("stdout", "done", 256, budget);

    expect(events).toEqual(original);
    expect(slice.events).toEqual(original);
    expect(slice).toMatchObject({ nextCursor: 64, earliestAvailableCursor: 0, droppedBytes: 0 });
    expect(buffer.events).toHaveLength(17);
    expect(buffer.events.at(-1)).toMatchObject({ cursor: 257, text: "done", droppedBefore: true });
    expect(buffer.bytes).toBe(68);
    expect(buffer.droppedBytes).toBe(4 * 240 + 7);
    expect(buffer.oldestEvent?.cursor).toBe(241);
    expect(buffer.nextCursor).toBe(258);
  });

  it("rejects consumer mutations without corrupting later reads or eviction accounting", () => {
    const budget = budgetFor(1, 8);
    const buffer = new LogBuffer().append("stdout", "one\ntwo\n", 1, budget);
    const cached = buffer.events;
    const full = readLogBuffer("task-0000000001", buffer, "running", { afterCursor: 0 });
    const tail = readLogBuffer("task-0000000001", buffer, "running", { tailLines: 1 });
    const empty = readLogBuffer("task-0000000001", buffer, "running", { tailLines: 0 });
    for (const events of [cached, full.events, tail.events, empty.events]) {
      expect(Reflect.set(events, "0", { text: "corrupted", bytes: 999 })).toBe(false);
      expect(Reflect.set(events, "length", 0)).toBe(false);
    }
    for (const event of [buffer.oldestEvent!, full.events[0]!, tail.events[0]!]) {
      expect(Reflect.set(event, "bytes", 999)).toBe(false);
      expect(Reflect.set(event, "text", "corrupted")).toBe(false);
      expect(Reflect.set(event, "cursor", 999)).toBe(false);
      expect(Reflect.set(event, "timestamp", 999)).toBe(false);
    }
    expect(Reflect.set(full, "droppedBytes", 999)).toBe(false);
    expect(buffer.bytes).toBe(8);
    expect(buffer.events).toEqual([
      { cursor: 1, stream: "stdout", text: "one\ntwo\n", timestamp: 1, bytes: 8 },
    ]);
    expect(tail.events[0]).toMatchObject({ text: "two\n", bytes: 4 });
    buffer.append("stderr", "🙂🙂", 2, budget);
    expect(readLogBuffer("task-0000000001", buffer, "running", { afterCursor: 0 })).toMatchObject({
      events: [{ cursor: 2, text: "🙂🙂", bytes: 8 }],
      earliestAvailableCursor: 1,
      droppedBytes: 8,
    });
    expect(buffer.bytes).toBe(8);
    expect(cached[0]?.text).toBe("one\ntwo\n");
    expect(full).toMatchObject({ nextCursor: 1, droppedBytes: 0 });
    expect(tail.events[0]?.text).toBe("two\n");
  });

  it("tails logical lines that span chunks or end without a newline", () => {
    const open = new LogBuffer().append("stdout", "one\ntw", 1, 1024);
    open.append("stdout", "o\nthree\nfour", 2, 1024);
    expect(tailText(open, 1)).toBe("four");
    expect(tailText(open, 2)).toBe("three\nfour");
    expect(tailText(open, 3)).toBe("two\nthree\nfour");
    expect(tailText(open, 5)).toBe("one\ntwo\nthree\nfour");

    const terminated = new LogBuffer().append("stdout", "one\ntw", 1, 1024);
    terminated.append("stderr", "o\n", 2, 1024);
    expect(tailText(terminated, 1)).toBe("two\n");
    expect(tailText(terminated, 2)).toBe("one\ntwo\n");

    const boundary = new LogBuffer().append("stdout", "one\n", 1, 1024);
    boundary.append("stdout", "two\n", 2, 1024);
    expect(
      readLogBuffer("task-0000000001", boundary, "running", { tailLines: 1 }).events,
    ).toMatchObject([{ cursor: 2, text: "two\n" }]);
  });

  it("reads after any cursor, and from the reported earliest cursor, once older events are gone", () => {
    const buffer = new LogBuffer();
    const budget = budgetFor(40, 6);
    for (let index = 1; index <= 100; index++)
      buffer.append(
        index % 2 ? "stdout" : "stderr",
        `e${Fn.pipe(String(index), Str.padStart(3, "0"))}\n`,
        0,
        budget,
      );
    expect(Arr.map(buffer.events, (event) => event.cursor)).toEqual(
      Array.from({ length: 40 }, (_, index) => index + 61),
    );
    const earliest = readLogBuffer("task-0000000001", buffer, "running", { tailLines: 1 });
    expect(earliest.earliestAvailableCursor).toBe(60);
    const fromEarliest = readLogBuffer("task-0000000001", buffer, "running", {
      afterCursor: earliest.earliestAvailableCursor,
    });
    expect(fromEarliest.events[0]?.text).toBe("e061\n");
    expect(fromEarliest.events).toHaveLength(40);
    for (const cursor of [0, 59, 60, 61, 80, 99, 100]) {
      const after = readLogBuffer("task-0000000001", buffer, "running", { afterCursor: cursor });
      expect(Arr.map(after.events, (event) => event.cursor)).toEqual(
        Arr.filter(
          Arr.map(buffer.events, (event) => event.cursor),
          (value) => value > cursor,
        ),
      );
    }
    const drained = new LogBuffer().append("stdout", "x", 0, budget).dropOldest();
    expect(readLogBuffer("task-0000000001", drained, "exited", { afterCursor: 0 })).toMatchObject({
      events: [],
      nextCursor: 1,
      earliestAvailableCursor: 1,
    });
  });

  it("charges each stored event a fixed overhead, so tiny writes cannot outgrow the budget", () => {
    const budget = 4_096;
    const buffer = new LogBuffer();
    for (let index = 0; index < 10_000; index++) buffer.append("stdout", "x", index, budget);
    expect(buffer.events.length).toBe(Math.floor(budget / (1 + OVERHEAD)));
    expect(buffer.bytes + buffer.events.length * OVERHEAD).toBeLessThanOrEqual(budget);
    expect(buffer.bytes + buffer.droppedBytes).toBe(10_000);

    // A budget smaller than one event keeps what fits and counts the rest exactly once.
    for (const tiny of [OVERHEAD + 32, OVERHEAD - 1]) {
      const small = new LogBuffer().append("stdout", Fn.pipe("x", Str.repeat(1_000)), 0, tiny);
      expect(small.chargedBytes).toBeLessThanOrEqual(Math.max(0, tiny));
      expect(small.bytes + small.droppedBytes).toBe(1_000);
    }
  });

  effectIt.live("releases evicted output at once rather than at compaction", () =>
    Effect.gen(function* () {
      const budget = budgetFor(4, 1_000);
      const buffer = new LogBuffer();
      const watched = (() => {
        buffer.append("stdout", Fn.pipe("a", Str.repeat(1_000)), 0, budget);
        return new WeakRef(buffer.oldestEvent!);
      })();
      for (let index = 0; index < 4; index++)
        buffer.append("stdout", Fn.pipe("b", Str.repeat(1_000)), 1, budget);
      expect(buffer.oldestEvent?.cursor).toBe(2);
      // A weak target stays alive until the current job ends.
      yield* Effect.sleep("1 millis");
      yield* collectGarbage;
      expect(watched.deref()).toBeUndefined();
    }),
  );

  effectIt.live("keeps memory for the output it retains, not for the writes it came from", () =>
    Effect.gen(function* () {
      // Large writes into small budgets put the two outcomes about a hundredfold apart, so heap
      // noise cannot pass a regression or fail a correct buffer.
      const buffers = 32;
      const writeBytes = 512 * 1_024;
      const write = (index: number) =>
        Buffer.alloc(writeBytes, `${Fn.pipe(String(index), Str.padStart(6, "0"))}\n`).toString(
          "utf8",
        );
      yield* collectGarbage;
      const before = process.memoryUsage().heapUsed;
      const retained = Array.from({ length: buffers }, (_, index) =>
        new LogBuffer().append("stdout", write(index), index, 4_096),
      );
      yield* collectGarbage;
      const heapGrowth = process.memoryUsage().heapUsed - before;
      const charged = Arr.reduce(retained, 0, (sum, buffer) => sum + buffer.chargedBytes);
      for (const [index, buffer] of retained.entries()) {
        expect(buffer.events.length).toBeGreaterThan(0);
        expect(
          Arr.join(
            Arr.map(buffer.events, (event) => event.text),
            "",
          ),
        ).toBe(Fn.pipe(write(index), Str.slice(-buffer.bytes)));
        expect(buffer.bytes + buffer.droppedBytes).toBe(writeBytes);
      }
      // Holding each whole write would take buffers * writeBytes, over a hundred times the charge.
      expect(charged * 100).toBeLessThan(buffers * writeBytes);
      expect(heapGrowth).toBeLessThan((buffers * writeBytes) / 8);
    }),
  );

  it("stores large writes as bounded events that never split a style sequence or character", () => {
    const red = "\u001b[31m";
    const reset = "\u001b[0m";
    const line = `${red}error${reset} 🙂 ${Fn.pipe("x", Str.repeat(37))}\n`;
    const text =
      Fn.pipe(line, Str.repeat(400)) + `${red}${Fn.pipe("y", Str.repeat(9_000))}${reset}`;
    const buffer = new LogBuffer().append("stdout", text, 0, 1 << 20);
    const events = buffer.events;
    expect(events.length).toBeGreaterThan(1);
    expect(
      Arr.join(
        Arr.map(events, (event) => event.text),
        "",
      ),
    ).toBe(text);
    for (const event of events) {
      expect(event.bytes).toBeLessThanOrEqual(BACKGROUND_LOG_BOUNDS.maxEventBytes);
      expect(Str.split(event.text, "\n").length - 1).toBeLessThanOrEqual(
        BACKGROUND_LOG_BOUNDS.maxEventLines,
      );
      expect(plainTerminalText(event.text)).not.toContain("\u001b");
      expect(plainTerminalText(event.text)).not.toMatch(/\[[0-9;]*m/u);
      expect(Buffer.from(event.text, "utf8").toString("utf8")).toBe(event.text);
    }
    expect(splitLogText("short\n")).toEqual(["short\n"]);
  });

  it("marks the first event after lost output, however a write is stored", () => {
    const buffer = new LogBuffer().append("stdout", "before\n", 0, 1 << 20);
    buffer.addDropped(0).append("stdout", "same\n", 1, 1 << 20);
    buffer.addDropped(12).append("stderr", Fn.pipe("z", Str.repeat(9_000)), 2, 1 << 20);
    expect(Arr.map(buffer.events, (event) => event.droppedBefore === true)).toEqual([
      false,
      false,
      true,
      false,
      false,
    ]);
    expect(buffer.droppedBytes).toBe(12);
  });
});
