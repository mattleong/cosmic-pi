import { describe, expect, test } from "vitest";
import { hasExplicitModelArgument } from "../src/boundary/host-cli.ts";

describe("explicit model detection", () => {
  test("recognizes only Pi's built-in --model argument", () => {
    expect(hasExplicitModelArgument(["--model", "openai/gpt-5.6-sol"])).toBe(true);
    expect(hasExplicitModelArgument(["--provider", "openai", "prompt"])).toBe(false);
    expect(hasExplicitModelArgument(["--models", "sonnet,gpt"])).toBe(false);
    expect(hasExplicitModelArgument(["--model-alias", "gpt"])).toBe(false);
  });
});
