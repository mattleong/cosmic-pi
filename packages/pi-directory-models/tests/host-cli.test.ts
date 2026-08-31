import process from "node:process";
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

  test("requires an exact flag and a value before the end-of-options marker", () => {
    expect(captureExplicitPreferenceArgument(["--provider", "openai", "prompt"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--models", "sonnet,gpt"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--model-alias", "gpt"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--model=openai/gpt-5.6-sol"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--thinking=high"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--model"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--thinking"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--model", "--"])).toBe(false);
    expect(captureExplicitPreferenceArgument(["--", "--thinking", "high"])).toBe(false);
  });

  test("fails closed when argv resolution or argument scanning throws", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process, "argv");
    if (!descriptor) throw new Error("process.argv descriptor is unavailable");
    Object.defineProperty(process, "argv", {
      configurable: true,
      get() {
        throw new Error("hostile argv getter");
      },
    });
    try {
      expect(captureExplicitPreferenceArgument()).toBe(false);
    } finally {
      Object.defineProperty(process, "argv", descriptor);
    }

    const hostileArguments = new Proxy(["--model", "openai/gpt-5.6-sol"], {
      get() {
        throw new Error("hostile argument access");
      },
    });
    expect(captureExplicitPreferenceArgument(hostileArguments)).toBe(false);
  });
});
