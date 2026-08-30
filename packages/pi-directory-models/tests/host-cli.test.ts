import process from "node:process";
import { describe, expect, test } from "vitest";
import { captureExplicitModelArgument } from "../src/boundary/host-cli.ts";

describe("explicit model detection", () => {
  test("recognizes only Pi's built-in --model argument", () => {
    expect(captureExplicitModelArgument(["--model", "openai/gpt-5.6-sol"])).toBe(true);
    expect(captureExplicitModelArgument(["--provider", "openai", "prompt"])).toBe(false);
    expect(captureExplicitModelArgument(["--models", "sonnet,gpt"])).toBe(false);
    expect(captureExplicitModelArgument(["--model-alias", "gpt"])).toBe(false);
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
      expect(captureExplicitModelArgument()).toBe(false);
    } finally {
      Object.defineProperty(process, "argv", descriptor);
    }

    const hostileArguments = new Proxy(["--model"], {
      get() {
        throw new Error("hostile argument access");
      },
    });
    expect(captureExplicitModelArgument(hostileArguments)).toBe(false);
  });
});
