import { describe, expect, it } from "vitest";
import {
  claimsOperationError,
  SUBAGENT_TOOL_SCHEMAS,
  type SubagentClaimsInput,
} from "../src/tools/schema.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";

/**
 * Pi's tool-call pipeline drops arguments for tools whose advertised schema has no root
 * `type: "object"` (a pure anyOf union at the root). Every registered subagent tool must
 * therefore keep an object-rooted parameter schema; per-action field requirements live in
 * runtime validation, never in a root Type.Union.
 */
describe("subagent tool parameter schemas", () => {
  it.each(SUBAGENT_TOOL_NAMES)("registers an object-rooted schema for %s", (name) => {
    expect(SUBAGENT_TOOL_SCHEMAS[name].parameters.type).toBe("object");
  });
});

describe("claimsOperationError", () => {
  const valid: ReadonlyArray<SubagentClaimsInput> = [
    { action: "list", runIds: ["agent-1"] },
    { action: "grant", runId: "agent-1", paths: ["src/a.ts"] },
    { action: "revoke", runId: "agent-1", paths: ["src/a.ts"] },
    { action: "resume_admission", runId: "agent-1" },
  ];

  it.each(valid)("accepts $action operations", (operation) => {
    expect(claimsOperationError(operation)).toBeUndefined();
  });

  it("names the missing field for each action", () => {
    expect(claimsOperationError({ action: "list" })).toContain("runIds");
    expect(claimsOperationError({ action: "grant", paths: ["src/a.ts"] })).toContain("runId");
    expect(claimsOperationError({ action: "revoke", runId: "agent-1" })).toContain("paths");
    expect(claimsOperationError({ action: "resume_admission" })).toContain("runId");
  });

  it("rejects cross-field combinations the previous union rejected", () => {
    expect(claimsOperationError({ action: "list", runIds: ["a"], runId: "a" })).toEqual(
      expect.any(String),
    );
    expect(
      claimsOperationError({ action: "grant", runId: "a", paths: ["p"], runIds: ["a"] }),
    ).toEqual(expect.any(String));
    expect(claimsOperationError({ action: "resume_admission", runId: "a", paths: ["p"] })).toEqual(
      expect.any(String),
    );
  });
});
