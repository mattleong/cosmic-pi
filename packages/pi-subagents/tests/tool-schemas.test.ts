import { validateToolArguments } from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import {
  claimsOperationError,
  prepareSubagentStartArguments,
  SUBAGENT_TOOL_SCHEMAS,
  type SubagentClaimsInput,
} from "../src/tools/schema.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";

describe("subagent tool parameter schemas", () => {
  it.each(SUBAGENT_TOOL_NAMES)("registers an object-rooted schema for %s", (name) => {
    expect(SUBAGENT_TOOL_SCHEMAS[name].parameters.type).toBe("object");
  });
});

describe("prepareSubagentStartArguments", () => {
  it("returns Pi's coerced arguments, which Pi's own validation accepts unchanged", () => {
    const prepared = prepareSubagentStartArguments({ agents: [{ task: 42, name: null }] });
    expect(prepared).toEqual({ agents: [{ task: "42" }] });
    expect(
      validateToolArguments(
        {
          name: "subagent_start",
          description: "",
          parameters: SUBAGENT_TOOL_SCHEMAS.subagent_start.parameters,
        },
        { type: "toolCall", id: "call", name: "subagent_start", arguments: prepared },
      ),
    ).toEqual(prepared);
  });

  it("rejects invalid arguments with Pi's validation error", () => {
    expect(() => prepareSubagentStartArguments({ agents: [] })).toThrow(
      'Validation failed for tool "subagent_start"',
    );
  });

  it("explains misplaced launch fields and route overrides before schema validation", () => {
    expect(() => prepareSubagentStartArguments({ task: "inspect" })).toThrow(
      "[invalid_start_shape]",
    );
    expect(() =>
      prepareSubagentStartArguments({ agents: [{ task: "inspect", model: "other" }] }),
    ).toThrow("[launch_override_not_allowed]");
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
