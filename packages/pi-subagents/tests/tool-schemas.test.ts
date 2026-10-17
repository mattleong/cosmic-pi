import { validateToolArguments } from "@earendil-works/pi-ai";
import { captureRegistrations } from "pi-code-previews/testing";
import { toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { toolDefinitions as supervisorToolDefinitions } from "../src/supervisor/mcp-wire.ts";
import {
  claimsOperationError,
  subagentArgumentPreparer,
  SUBAGENT_TOOL_SCHEMAS,
} from "../src/tools/schema.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";

const registeredTools = (nested: boolean) =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("schema-only fixture")),
      ...(nested && { proxyCall: () => Promise.reject(new Error("schema-only fixture")) }),
    }),
  ).tools;

const prepareStart = subagentArgumentPreparer("subagent_start");

describe("model-facing tool schemas", () => {
  it.each([false, true])(
    "declares only provider-portable parameter keywords (nested: %s)",
    (nested) => {
      const tools = registeredTools(nested);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(tool.parameters).toMatchObject({ type: "object" });
        expect(toolSchemaPortabilityProblems(tool.parameters)).toEqual([]);
      }
    },
  );

  it("keeps the supervisor MCP schemas provider-portable", () => {
    for (const tool of supervisorToolDefinitions)
      expect(toolSchemaPortabilityProblems(tool.inputSchema)).toEqual([]);
  });
});

describe("subagent argument preparation", () => {
  it("returns Pi's coerced arguments, which Pi's own validation accepts unchanged", () => {
    const prepared = prepareStart({ agents: [{ task: 42, name: null }] });
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
});

describe("claimsOperationError", () => {
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
