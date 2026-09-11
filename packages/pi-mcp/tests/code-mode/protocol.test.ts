import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import {
  MCP_CODE_MODE_VERSION,
  McpCodeModeInputSchema,
  mcpCodeModeJsonFits,
  mcpCodeModeHasBinary,
  normalizeMcpCodeModeError,
  normalizeMcpCodeModeQuery,
} from "../../src/code-mode/protocol.ts";
import { boundaryError } from "../../src/client/errors.ts";

describe("MCP Code Mode protocol admission", () => {
  it("rejects management and excess action fields instead of silently stripping authority", () => {
    for (const input of [
      { action: "connect", server: "fixture" },
      { action: "disconnect", server: "fixture" },
      { action: "refresh", server: "fixture" },
      { action: "auth", server: "fixture" },
      { action: "status", token: "secret" },
      { action: "tools.call", server: "fixture", tool: "x", method: "anything" },
    ])
      expect(Option.isNone(Schema.decodeUnknownOption(McpCodeModeInputSchema)(input))).toBe(true);
  });

  it("exempts only exact description schema roots, never embedded action or origin claims", () => {
    for (const literal of [
      { blob: "literal-blob" },
      { base64: "literal-base64" },
      { type: "image", data: "literal-image" },
    ]) {
      for (const key of ["inputSchema", "outputSchema"]) {
        const result = {
          [key]: { const: literal, default: literal, enum: [literal], examples: [literal] },
        };
        expect(mcpCodeModeHasBinary({ result }, "tools.describe")).toBe(false);
        expect(mcpCodeModeHasBinary({ result })).toBe(true);
        for (const action of ["tools.call", "prompts.get", "resources.read", "result.read"]) {
          expect(
            mcpCodeModeHasBinary({ origin: { action: "tools.describe" }, result }, action),
          ).toBe(true);
        }
        for (const data of [
          { result: { structuredContent: { action: "tools.describe", result } } },
          { result: { nested: { origin: { action: "tools.describe" }, result } } },
          { result: [result] },
          [{ result }],
          { [key]: literal },
          { result, other: literal },
        ])
          expect(mcpCodeModeHasBinary(data, "tools.describe")).toBe(true);
        expect(mcpCodeModeHasBinary({ text: JSON.stringify(result) }, "result.read")).toBe(false);
      }
    }
  });

  it("admits exact compact JSON byte fits, including escaping and surrogate pairs", () => {
    for (const value of [
      null,
      true,
      -0,
      1e25,
      '中文😀\ud800\n\u0000"\\',
      { nested: [false, { text: "é" }] },
    ]) {
      const bytes = new TextEncoder().encode(JSON.stringify(value)).length;
      expect(mcpCodeModeJsonFits(value, bytes)).toBe(true);
      expect(mcpCodeModeJsonFits(value, bytes - 1)).toBe(false);
    }
  });

  it("rejects non-JSON, deep and hostile values without reading accessors", () => {
    let getterRead = false;
    const accessor = {
      get data() {
        getterRead = true;
        return "secret";
      },
    };
    interface RecursiveFixture {
      self?: RecursiveFixture;
      child?: RecursiveFixture;
    }
    const cyclic: RecursiveFixture = {};
    cyclic.self = cyclic;
    let deep: RecursiveFixture = {};
    for (let index = 0; index < 70; index += 1) deep = { child: deep };
    for (const value of [
      accessor,
      cyclic,
      deep,
      [undefined],
      [NaN],
      new Map(),
      Object.defineProperty({}, "toJSON", { value: () => "secret" }),
      Array(2),
      { fn: () => 1 },
    ]) {
      expect(mcpCodeModeJsonFits(value, 1_000_000)).toBe(false);
    }
    expect(getterRead).toBe(false);
  });

  it("contains throwing callbacks and rejection coercion, preserving only typed certainty", () => {
    const query = normalizeMcpCodeModeQuery({
      version: MCP_CODE_MODE_VERSION,
      sessionId: "session",
      respond: () => Promise.reject(new Error("secret")),
    });
    expect(() => query?.respond({})).not.toThrow();
    const known = normalizeMcpCodeModeError(boundaryError("output-limit", "completed", "secret"));
    expect(known).toMatchObject({ kind: "output-limit", outcome: "completed" });
    expect(known.message).not.toContain("secret");
    const unknown = normalizeMcpCodeModeError({
      toString: () => {
        throw new Error("secret");
      },
    });
    expect(unknown).toMatchObject({ kind: "transport", outcome: "unknown" });
    expect(unknown.message).not.toContain("secret");
  });
});
