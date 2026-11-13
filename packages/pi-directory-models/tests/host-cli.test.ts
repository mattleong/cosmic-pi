import { describe, expect, test } from "vitest";
import { captureExplicitPreferenceArgument } from "../src/boundary/host-cli.ts";

describe("explicit CLI preference detection", () => {
  test("recognizes paired model and thinking arguments before the end-of-options marker", () => {
    expect(captureExplicitPreferenceArgument(["--model", "openai/gpt-5.6-sol"])).toBe(true);
    expect(captureExplicitPreferenceArgument(["--thinking", "high"])).toBe(true);
    expect(
      captureExplicitPreferenceArgument(["--thinking", "low", "--", "--model", "prompt"]),
    ).toBe(true);
  });

  test("ignores arguments after the end-of-options marker and a trailing flag without a value", () => {
    expect(captureExplicitPreferenceArgument(["--", "--model", "x"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--model"])).toBe(false);
  });
});
