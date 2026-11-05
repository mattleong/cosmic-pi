import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import { stripAnsi } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderToolHeader } from "../src/tool/presentation.ts";

describe("renderToolHeader", () => {
  it("keeps a subtitle of any length whole, so the caller's layout decides what shows", () => {
    const subtitle = `node scripts/verify.ts ${Arr.join(
      Arr.map(Arr.range(0, 19), (index) => `--include=package-${index}`),
      " ",
    )} --security-check · finished in 399ms`;

    expect(stripAnsi(renderToolHeader({ title: "Background task", subtitle }, plainTheme))).toBe(
      `Background task ${subtitle}`,
    );
  });
});
