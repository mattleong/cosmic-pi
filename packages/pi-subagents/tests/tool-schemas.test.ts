import {
  fauxAssistantMessage,
  fauxToolCall,
  validateToolArguments,
  type ToolResultMessage,
} from "@earendil-works/pi-ai";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { captureRegistrations } from "pi-code-previews/testing";
import { temporaryDirectory, toolSchemaPortabilityProblems } from "pi-cosmic-core/testing";
import {
  fauxModels,
  quietLoader,
  quietSettings,
  scopedPrintSession,
} from "pi-cosmic-core/testing/sdk";
import { WRITER_WORKSPACE_MODES } from "../src/config/schema.ts";
import { toolDefinitions as supervisorToolDefinitions } from "../src/supervisor/mcp-wire.ts";
import {
  startToolParameters,
  subagentArgumentPreparer,
  SUBAGENT_FIELD_ALIASES,
  SUBAGENT_TOOL_SCHEMAS,
  workspaceOperationError,
} from "../src/tools/schema.ts";
import { replacementField } from "pi-cosmic-core/tool-arguments";
import { registerSubagentTools } from "../src/tools/subagent.ts";

const registeredTools = (nested: boolean) =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("schema-only fixture")),
      ...(nested && { proxyCall: () => Promise.reject(new Error("schema-only fixture")) }),
    }),
  ).tools;

// The shared start schema is the nested one; the root registers its own.
const prepareStart = subagentArgumentPreparer("agent_start");
const rootStartParameters = startToolParameters([]);
const prepareRootStart = subagentArgumentPreparer("agent_start", rootStartParameters);

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

  it("accepts a display name longer than the bound runs keep, which launch cuts", () => {
    const name = "n".repeat(500);
    expect(prepareStart({ agents: [{ task: "Map", name }] })).toEqual({
      agents: [{ task: "Map", name }],
    });
  });

  it("drops blank optional text and still rejects blank required text", () => {
    expect(prepareStart({ agents: [{ task: "Map", name: "  ", profile: "", agent: "" }] })).toEqual(
      { agents: [{ task: "Map" }] },
    );
    expect(() => prepareStart({ agents: [{ task: " ", name: "Map" }] })).toThrow(
      /\[invalid_arguments\][\s\S]*agents\[0\]\.task/u,
    );
  });

  it.live("leaves malformed tool-call JSON to Pi, which shows the model the parse error", () =>
    Effect.gen(function* () {
      const directory = yield* temporaryDirectory("pi-tool-arguments-");
      const { fake, models } = yield* fauxModels("subagent-tool-arguments-test");
      const settings = quietSettings();
      const loader = yield* quietLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: settings,
        noExtensions: true,
        extensionFactories: [
          (pi) =>
            pi.registerTool({
              name: "agent_start",
              label: "agent_start",
              description: "agent_start",
              parameters: SUBAGENT_TOOL_SCHEMAS.agent_start.parameters,
              prepareArguments: prepareStart,
              execute: () => Promise.reject(new Error("malformed arguments must not execute")),
            }),
        ],
      });
      const session = yield* scopedPrintSession({
        cwd: directory,
        agentDir: directory,
        model: fake.getModel(),
        modelRuntime: models,
        settingsManager: settings,
        sessionManager: SessionManager.inMemory(directory),
        resourceLoader: loader,
        tools: ["agent_start"],
      });
      const parseError =
        'Unterminated string in JSON\n\nReceived arguments:\n{"agents":[{"task":"Map';
      fake.setResponses([
        fauxAssistantMessage(
          { ...fauxToolCall("agent_start", {}), argumentsError: parseError },
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("resent"),
      ]);
      yield* Effect.promise(() => session.prompt("start a scout"));
      expect(fake.getPendingResponseCount()).toBe(0);
      const result = session.messages.find(
        (message): message is ToolResultMessage => message.role === "toolResult",
      );
      expect(result).toMatchObject({ toolName: "agent_start", isError: true });
      const shown = result?.content.flatMap((part) => (part.type === "text" ? [part.text] : []));
      expect(shown?.join("\n")).toContain(parseError);
      expect(shown?.join("\n")).not.toContain("[invalid_arguments]");
    }),
  );

  it("rejects an unknown isolation value and names the allowed modes", () => {
    const rejected = () => prepareRootStart({ agents: [{ task: "Edit", isolation: "sandbox" }] });
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
    const accepted = Object.keys(rootStartParameters.properties.agents.items.properties);
    for (const key of ["workspace", "worktree", "workspace_mode", "writerWorkspaceMode"])
      expect(replacementField(key, accepted, SUBAGENT_FIELD_ALIASES)).toBe("isolation");
  });

  it("rejects isolation from a nested child, which can't start worktree writers", () => {
    expect(() =>
      prepareStart({ agents: [{ task: "Edit", profile: "worker", isolation: "worktree" }] }),
    ).toThrow(/\[invalid_arguments\][\s\S]*isolation/u);
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

  it("rejects a missing workspace and real values in fields that belong to other actions", () => {
    expect(() => prepareWorkspace({ action: "apply", workspaceId: "ws-1", force: true })).toThrow(
      /\[invalid_arguments\]/u,
    );
    for (const args of [
      { action: "apply" },
      { action: "revise", workspaceId: "ws-1", message: " " },
      { action: "list", offset: 8 },
      { action: "apply", workspaceId: "ws-1", message: "Ship it." },
      { action: "discard", workspaceId: "ws-1", revisionId: "rev-1" },
      { action: "review", workspaceId: "ws-1", rebase: true },
    ] as const)
      expect(workspaceOperationError(args)).toEqual(expect.any(String));
  });

  it("ignores blank, false, and zero placeholders in fields an action doesn't use", () => {
    for (const args of [
      { action: "list", workspaceId: "ws-1" },
      { action: "list", rebase: false, offset: 0 },
      { action: "review", workspaceId: "ws-1", rebase: false },
      { action: "prepare", workspaceId: "ws-1", revisionId: "rev-1", offset: 0 },
      { action: "apply", workspaceId: "ws-1", rebase: false, offset: 0, message: "" },
      { action: "revise", workspaceId: "ws-1", message: "Fix the test.", offset: 0 },
    ] as const)
      expect(workspaceOperationError(args), args.action).toBeUndefined();
  });
});

describe("await arguments", () => {
  const prepareAwait = subagentArgumentPreparer("agent_await");

  it("accepts a wait without until and leaves an out-of-range timeout to the tool", () => {
    expect(prepareAwait({ runIds: ["agent-1"] })).toEqual({ runIds: ["agent-1"] });
    for (const timeoutSeconds of [0, 2.5, 86_400])
      expect(prepareAwait({ runIds: ["agent-1"], timeoutSeconds })).toEqual({
        runIds: ["agent-1"],
        timeoutSeconds,
      });
  });
});

const ids = (count: number) => Array.from({ length: count }, (_, index) => `agent-${index}`);

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

  it("takes as many targets as one start batch launches", () => {
    expect(prepareLifecycle({ action: "stop", runIds: ids(32) })).toEqual({
      action: "stop",
      runIds: ids(32),
    });
    expect(() => prepareLifecycle({ action: "stop", runIds: ids(33) })).toThrow(
      /\[invalid_arguments\][\s\S]*runIds/u,
    );
  });
});
