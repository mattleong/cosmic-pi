import { validateToolArguments } from "@earendil-works/pi-ai";
import { captureRegistrations } from "pi-code-previews/testing";
import { toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { WRITER_WORKSPACE_MODES } from "../src/config/schema.ts";
import { toolDefinitions as supervisorToolDefinitions } from "../src/supervisor/mcp-wire.ts";
import {
  statusOperationError,
  subagentArgumentPreparer,
  SUBAGENT_TOOL_SCHEMAS,
  workspaceOperationError,
} from "../src/tools/schema.ts";
import { replacementField } from "../src/tools/arguments.ts";
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

  it("rejects an unknown isolation value and names the allowed modes", () => {
    const rejected = () => prepareStart({ agents: [{ task: "Edit", isolation: "sandbox" }] });
    expect(rejected).toThrow(/\[invalid_arguments\]/u);
    expect(rejected).toThrow(
      new RegExp(`isolation[^\\n]*${WRITER_WORKSPACE_MODES.join(", ")}`, "u"),
    );
  });

  it("rejects retired write claims on a start entry", () => {
    const rejected = () =>
      prepareStart({ agents: [{ task: "Edit", profile: "worker", writes: ["src/a.ts"] }] });
    expect(rejected).toThrow(/\[invalid_arguments\]/u);
    expect(rejected).toThrow(/writes/u);
  });

  it("suggests isolation for workspace-style start keys", () => {
    const accepted = Object.keys(
      SUBAGENT_TOOL_SCHEMAS.subagent_start.parameters.properties.agents.items.properties,
    );
    for (const key of ["workspace", "worktree", "workspace_mode", "writerWorkspaceMode"])
      expect(replacementField(key, accepted)).toBe("isolation");
  });
});

describe("workspace apply arguments", () => {
  const prepareWorkspace = subagentArgumentPreparer("subagent_workspace");

  it("accepts a workspace with an optional revision pin", () => {
    for (const args of [
      { action: "apply", workspaceId: "ws-1" },
      { action: "apply", workspaceId: "ws-1", revisionId: "rev-1" },
    ] as const) {
      expect(prepareWorkspace(args)).toEqual(args);
      expect(workspaceOperationError(args)).toBeUndefined();
    }
  });

  it("rejects a missing workspace and fields that belong to other actions", () => {
    expect(() => prepareWorkspace({ action: "apply", workspaceId: "ws-1", force: true })).toThrow(
      /\[invalid_arguments\]/u,
    );
    for (const args of [
      { action: "apply" },
      { action: "apply", workspaceId: "ws-1", preparationId: "prep-1" },
      { action: "apply", workspaceId: "ws-1", message: "Ship it." },
    ] as const)
      expect(workspaceOperationError(args)).toEqual(expect.any(String));
  });
});

describe("statusOperationError", () => {
  it("rereads delivered reports only for named runs", () => {
    expect(statusOperationError({ includeDeliveredReports: true })).toEqual(expect.any(String));
    expect(statusOperationError({ runIds: ["a"], includeDeliveredReports: true })).toBeUndefined();
    expect(statusOperationError({})).toBeUndefined();
  });
});
