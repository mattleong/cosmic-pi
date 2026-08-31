import { describe, expect, test } from "vitest";
import { preferenceFilename } from "../src/config/path-key.ts";

describe("directory preference path keys", () => {
  test("sanitizes unsafe basenames", () => {
    expect(preferenceFilename("/work/cern", "  cern: detector / software  ")).toMatch(
      /^cern-detector-software--[a-f0-9]{12}\.json$/,
    );
    expect(preferenceFilename("/work/directory", "...")).toMatch(/^directory--[a-f0-9]{12}\.json$/);
  });

  test("bounds the readable slug", () => {
    expect(preferenceFilename("/work/long", "x".repeat(100))).toMatch(
      new RegExp(`^${"x".repeat(48)}--[a-f0-9]{12}\\.json$`),
    );
  });

  test("appends a stable short hash suffix", () => {
    expect(preferenceFilename("/Users/example/work/CERN", "CERN")).toBe("CERN--3c447ca20025.json");
  });

  test("disambiguates equal basenames at different paths", () => {
    expect(preferenceFilename("/work/a/cern", "cern")).not.toBe(
      preferenceFilename("/work/b/cern", "cern"),
    );
  });
});
