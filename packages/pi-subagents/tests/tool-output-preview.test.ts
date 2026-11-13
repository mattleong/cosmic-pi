import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { describe, expect, it } from "vitest";
import { toolOutputPreview } from "../src/backend/tool-output-preview.ts";
import * as Fn from "effect/Function";

const lines = (count: number): string =>
  Arr.join(
    Arr.makeBy(count, (index) => `line ${index + 1}`),
    "\n",
  );
const xs = (count: number): string => Fn.pipe("x", Str.repeat(count));

describe("tool output previews", () => {
  it("keeps up to seven lines whole and marks longer output as cut", () => {
    expect(toolOutputPreview(`\n${lines(7)}\n`)).toBe(lines(7));
    expect(toolOutputPreview({ content: lines(8) })).toBe(`${lines(7)}…`);
    expect(toolOutputPreview(`${lines(6)}\n\n\nlast`)).toBe(`${lines(6)}\n…`);
    expect(
      toolOutputPreview([
        { type: "text", text: "first" },
        { type: "image", data: "" },
        { type: "text", text: "second" },
      ]),
    ).toBe("first\nsecond");
  });

  it("cuts long previews by characters", () => {
    expect(toolOutputPreview(xs(1_000))).toBe(xs(1_000));
    expect(toolOutputPreview(xs(5_000))).toBe(`${xs(1_000)}…`);
    expect(toolOutputPreview(`${xs(2_000)}\n${lines(9)}`)).toBe(`${xs(1_000)}…`);
  });

  it("keeps the first line's indentation", () => {
    expect(toolOutputPreview("\n    1  import thing;\n    2  export thing;  \n\n")).toBe(
      "    1  import thing;\n    2  export thing;",
    );
  });

  it("has no preview for blank or unrecognized output", () => {
    expect(toolOutputPreview(" \n ")).toBeUndefined();
    expect(toolOutputPreview({ unexpected: true })).toBeUndefined();
  });
});
