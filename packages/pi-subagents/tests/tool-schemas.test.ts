import { validateToolArguments } from "@earendil-works/pi-ai";
import { captureRegistrations } from "pi-code-previews/testing";
import { toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { WRITER_WORKSPACE_MODES } from "../src/config/schema.ts";
import { toolDefinitions as supervisorToolDefinitions } from "../src/supervisor/mcp-wire.ts";
import {
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

const prepareStart = subagentArgumentPreparer("agent_start");

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
          name: "agent_start",
          description: "",
          parameters: SUBAGENT_TOOL_SCHEMAS.agent_start.parameters,
        },
        { type: "toolCall", id: "call", name: "agent_start", arguments: prepared },
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

  it("rejects an unknown start-entry key and names it", () => {
    const rejected = () =>
      prepareStart({ agents: [{ task: "Edit", profile: "worker", writes: ["src/a.ts"] }] });
    expect(rejected).toThrow(/\[invalid_arguments\]/u);
    expect(rejected).toThrow(/writes/u);
  });

  it("suggests isolation for workspace-style start keys", () => {
    const accepted = Object.keys(
      SUBAGENT_TOOL_SCHEMAS.agent_start.parameters.properties.agents.items.properties,
    );
    for (const key of ["workspace", "worktree", "workspace_mode", "writerWorkspaceMode"])
      expect(replacementField(key, accepted)).toBe("isolation");
  });
});

describe("workspace apply arguments", () => {
  const prepareWorkspace = subagentArgumentPreparer("agent_worktree");

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

describe("lifecycle arguments", () => {
  const prepareLifecycle = subagentArgumentPreparer("agent_lifecycle");

  it("rejects resume, which is a message to the run, and accepts the other actions", () => {
    expect(() => prepareLifecycle({ action: "resume", runIds: ["agent-1"] })).toThrow(
      /\[invalid_arguments\][\s\S]*action/u,
    );
    expect(() =>
      prepareLifecycle({ action: "stop", runIds: ["agent-1"], message: "Continue." }),
    ).toThrow(/\[invalid_arguments\]/u);
    for (const action of ["interrupt", "stop"] as const)
      expect(prepareLifecycle({ action, runIds: ["agent-1"] })).toEqual({
        action,
        runIds: ["agent-1"],
      });
  });
});
