import { validateToolArguments } from "@earendil-works/pi-ai";
import { captureRegistrations } from "pi-code-previews/testing";
import { toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import { describe, expect, it } from "vitest";
import { PROFILE_IDS } from "../src/profiles/model.ts";
import { toolDefinitions as supervisorToolDefinitions } from "../src/supervisor/mcp-wire.ts";
import { decodeSubagentProxyRequest } from "../src/tools/proxy-protocol.ts";
import { InvalidSubagentRequestError } from "../src/run/errors.ts";
import {
  claimsOperationError,
  subagentArgumentPreparer,
  SUBAGENT_TOOL_SCHEMAS,
  type SubagentClaimsInput,
} from "../src/tools/schema.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";
import { SUBAGENT_TOOL_NAMES } from "../src/run/tool-policy.ts";

const registeredTools = (nested: boolean) =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("schema-only fixture")),
      ...(nested && { proxyCall: () => Promise.reject(new Error("schema-only fixture")) }),
    }),
  ).tools;

const prepareStart = subagentArgumentPreparer("subagent_start");
const rejection = (prepare: () => void): string => {
  try {
    prepare();
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
  throw new Error("Expected the arguments to be rejected.");
};

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

  it("explains misplaced launch fields and route overrides before schema validation", () => {
    expect(rejection(() => prepareStart({ task: "inspect" }))).toContain("[invalid_start_shape]");
    const taskToolShape = rejection(() =>
      prepareStart({ prompt: "inspect", subagent_type: "Explore" }),
    );
    expect(taskToolShape).toContain("[invalid_start_shape]");
    expect(taskToolShape).toContain('"task" for "prompt"');
    expect(taskToolShape).toContain('"profile" for "subagent_type"');
    expect(
      rejection(() => prepareStart({ agents: [{ task: "inspect", model: "other" }] })),
    ).toContain("[launch_override_not_allowed]");
  });

  it("names the replacement for unknown fields and lists the accepted ones", () => {
    const message = rejection(() =>
      prepareStart({ agents: [{ prompt: "inspect", subagent_type: "Explore", extra: 1 }] }),
    );
    expect(message).toContain("[invalid_arguments]");
    expect(message).toContain('"prompt" (use "task")');
    expect(message).toContain('"subagent_type" (use "profile")');
    expect(message).toContain('"extra"');
    expect(message).toContain("task, name, profile, writes");
    expect(
      rejection(() => subagentArgumentPreparer("subagent_status")({ runId: "agent-1" })),
    ).toContain('"runId" (use "runIds")');
  });

  it("lists the allowed values when an enum value is wrong", () => {
    const message = rejection(() =>
      prepareStart({ agents: [{ task: "inspect", profile: "Explore" }] }),
    );
    expect(message).toContain("agents[0].profile");
    for (const profile of PROFILE_IDS) expect(message).toContain(profile);
    expect(
      rejection(() =>
        subagentArgumentPreparer("subagent_await")({ runIds: ["agent-1"], until: "done" }),
      ),
    ).toContain("all_finished, any_finished");
  });

  it("bounds the arguments it echoes", () => {
    const task = `${"long task ".repeat(20_000)}TASK_TAIL`;
    const message = rejection(() => prepareStart({ agents: [{ task, subagent_type: "x" }] }));
    expect(message).not.toContain("TASK_TAIL");
    expect(message.length).toBeLessThan(2_000);
  });

  it.each([
    ["subagent_start", { agents: [{ task: " \n\t " }] }, "agents[0].task"],
    ["subagent_start", { agents: [{ task: "inspect", name: "  " }] }, "agents[0].name"],
    ["subagent_status", { runIds: ["agent-1", " "] }, "runIds[1]"],
    ["subagent_send", { runIds: ["agent-1"], message: "\n" }, "message"],
    ["subagent_claims", { action: "grant", runId: "agent-1", paths: [" "] }, "paths[0]"],
  ] as const)("rejects blank text in %s at %s", (tool, args, path) => {
    const message = rejection(() => subagentArgumentPreparer(tool)(args));
    expect(message).toContain(`${path} must contain non-whitespace text`);
  });

  it.each([
    ["subagent_start", { agents: [{ task: " " }] }],
    ["subagent_status", { runIds: [" "] }],
    ["subagent_reply", { runId: "agent-1", message: "\t" }],
  ] as const)("rejects blank text in nested %s requests", (tool, args) => {
    expect(
      decodeSubagentProxyRequest({ tool, argumentsJson: JSON.stringify(args) }),
    ).toBeInstanceOf(InvalidSubagentRequestError);
  });

  it.each(SUBAGENT_TOOL_NAMES)("rejects non-object arguments for %s", (tool) => {
    expect(rejection(() => subagentArgumentPreparer(tool)("text"))).toContain(
      "arguments must be a JSON object",
    );
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
