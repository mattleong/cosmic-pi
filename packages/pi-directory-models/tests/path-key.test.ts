import { describe, expect, test } from "vitest";
import { preferenceFilename } from "../src/config/path-key.ts";

describe("directory preference path keys", () => {
  test("sanitizes unsafe basenames", () => {
    expect(preferenceFilename("/work/cern", "  cern: detector / software  ")).toMatch(
      /^cern-detector-software--[a-f0-9]{12}\.json$/,
    );
    expect(preferenceFilename("/work/directory", "...")).toMatch(/^directory--[a-f0-9]{12}\.json$/);
  });

  test("appends a stable short hash suffix", () => {
    expect(preferenceFilename("/Users/example/work/CERN", "CERN")).toBe("CERN--3c447ca20025.json");
  });
});
