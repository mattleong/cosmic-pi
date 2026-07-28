import { describe, expect, test } from "vitest";
import {
  preferenceFilename,
  readableDirectorySlug,
  shortPathHash,
} from "../src/boundary/path-key.ts";

describe("directory preference path keys", () => {
  test("keeps a recognizable basename and a stable short hash", () => {
    expect(preferenceFilename("/Users/example/work/CERN", "CERN")).toMatch(
      /^CERN--[a-f0-9]{12}\.json$/,
    );
    expect(shortPathHash("/Users/example/work/CERN")).toHaveLength(12);
  });

  test("sanitizes unsafe and unusually long basenames", () => {
    expect(readableDirectorySlug("  cern: detector / software  ")).toBe("cern-detector-software");
    expect(readableDirectorySlug("...")).toBe("directory");
    expect(readableDirectorySlug("x".repeat(100))).toHaveLength(48);
  });

  test("disambiguates equal basenames at different paths", () => {
    expect(preferenceFilename("/work/a/cern", "cern")).not.toBe(
      preferenceFilename("/work/b/cern", "cern"),
    );
  });
});
