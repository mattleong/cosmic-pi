import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import { utf8ByteLength } from "pi-cosmic-core/text";
import { describe, expect, it } from "vitest";
import { BACKGROUND_LOG_BOUNDS } from "../src/task/bounds.ts";
import { LogBuffer, readLogBuffer } from "../src/task/log-buffer.ts";
import { pageLogSlice, recentOutput } from "../src/tools/log-page.ts";
import { taskLogSlice } from "./support/task-service-double.ts";

const ID = "task-0000000001";
const BUDGET = BACKGROUND_LOG_BOUNDS.recentOutputBytes;
const LINES = BACKGROUND_LOG_BOUNDS.recentOutputLines;

const lineCount = (text: string) => Str.split(Fn.pipe(text, Str.replace(/\n$/u, "")), "\n").length;

const recentOf = (buffer: LogBuffer) =>
  recentOutput(
    readLogBuffer(ID, buffer, "running", { tailLines: BACKGROUND_LOG_BOUNDS.recentOutputLines }),
  );

describe("recent output", () => {
  it("keeps as many whole newest lines as fit, however output was split into events", () => {
    const buffer = new LogBuffer();
    // Long lines with blank ones between them, written in one large chunk and then a small one;
    // twenty of them are more than the byte budget.
    const lines = Arr.makeBy(60, (index) =>
      index % 3 === 2 ? "\n" : `L${index} ${Fn.pipe("x", Str.repeat(316))}\n`,
    );
    buffer.append("stdout", Arr.join(lines.slice(0, -1), ""), 1, 1024 * 1024);
    buffer.append("stdout", lines.at(-1) ?? "", 2, 1024 * 1024);
    const recent = recentOf(buffer);
    expect(utf8ByteLength(recent)).toBeLessThanOrEqual(BUDGET);
    expect(utf8ByteLength(recent)).toBeGreaterThan(BUDGET - 330);
    expect(recent).toContain(`L58 ${Fn.pipe("x", Str.repeat(316))}\n\n`);
    // Every kept line is whole.
    for (const line of Str.split(Fn.pipe(recent, Str.replace(/\n$/u, "")), "\n"))
      expect(line === "" || /^L\d+ x{316}$/u.test(line)).toBe(true);
  });

  it("keeps at most its line count and labels stderr lines", () => {
    const slice = taskLogSlice(ID, "running", [
      {
        stream: "stdout",
        text: Arr.join(
          Arr.makeBy(30, (index) => `out ${index}\n`),
          "",
        ),
      },
      { stream: "stderr", text: "\nerror one\n" },
    ]);
    const recent = recentOutput(slice);
    expect(lineCount(recent)).toBe(LINES);
    expect(recent).toContain("[stderr] error one\n");
    expect(recent).toContain("out 29\n");
    expect(recent).not.toContain("out 10\n");
  });

  it("keeps the end of a single line larger than its budget", () => {
    const line = `${Fn.pipe("é", Str.repeat(3_000))}end`;
    const recent = recentOutput(taskLogSlice(ID, "running", [{ stream: "stdout", text: line }]));
    expect(utf8ByteLength(recent)).toBeLessThanOrEqual(BUDGET);
    expect(recent).toMatch(/é+end$/u);
  });

  it("keeps output that starts with blank lines", () => {
    const text = "\n\nready\n";
    expect(recentOutput(taskLogSlice(ID, "running", [{ stream: "stdout", text }]))).toBe(text);
  });
});

describe("log pages", () => {
  it("shortens a single oversized event that starts with a line break", () => {
    const text = `\n${Fn.pipe("y", Str.repeat(200))}\nlast\n`;
    const page = pageLogSlice(taskLogSlice(ID, "running", [{ stream: "stdout", text }]), "tail", {
      maxBytes: 100,
      maxLines: Number.POSITIVE_INFINITY,
    });
    expect(utf8ByteLength(page.output)).toBeLessThanOrEqual(100);
    expect(page.output).toMatch(/last\n$/u);
    expect(page.cut).toBeDefined();
  });
});
