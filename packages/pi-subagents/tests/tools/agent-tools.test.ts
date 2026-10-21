import { beforeEach, describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "pi-code-previews/testing";
import {
  MAIN_AGENT_ID,
  type AgentCaller,
  type AgentReadResult,
} from "../../src/run/agent-messaging.ts";
import { AGENT_MESSAGE_REFUSAL_CODES, agentMessageRefusal } from "../../src/run/errors.ts";
import { agentFailureIssues } from "../../src/tools/compact-action-failures.ts";
import { createAgentCompactSummary } from "../../src/tools/compact-agent-summary.ts";
import { stringContaining } from "../support/matchers.ts";
import { decodeSubagentContract } from "../../src/tools/contract-schema.ts";
import { executeAgentActionEffect } from "../../src/tools/execute-agents.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { SubagentService } from "../../src/run/service.ts";
import { registerAgentTools } from "../../src/tools/agent.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { nativeCodemodeSession } from "../support/native-codemode-session.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools, executeTool, view } from "./fixtures/tool-harness.ts";
import { nodeFilePlatformLayer } from "pi-cosmic-core";

beforeEach(() =>
  applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false }),
);

const scout = view({ id: "agent-1", name: "api-scout", profile: "scout", state: "running" });
const finishedScout = view({
  ...scout,
  state: "completed",
  parentRunId: "root",
  depth: 1,
  pid: 4242,
  childWarning: "Schema drift is likely.",
});

const READ: AgentReadResult = {
  agents: [
    {
      kind: "main",
      id: MAIN_AGENT_ID,
      name: MAIN_AGENT_ID,
      state: "busy",
      textStatus: "text",
      text: `Main is planning.\n${"context ".repeat(40)}\nMAIN_TAIL_SENTINEL`,
      truncated: false,
    },
    {
      kind: "run",
      id: scout.id,
      name: scout.name,
      state: "completed",
      textStatus: "text",
      text: "Found the schema in src/api.ts.",
      truncated: true,
      source: "report",
      reportGeneration: 1,
      run: finishedScout,
    },
  ],
  missingIds: ["agent-gone"],
};

const readout = (run: SubagentRunView) => ({
  kind: "run" as const,
  id: run.id,
  name: run.name,
  state: run.state,
  textStatus: "none" as const,
  truncated: false,
  reportGeneration: 0,
  run,
});

const callers: AgentCaller[] = [];
const agentService = () =>
  subagentServiceDouble({
    agentList: (caller, ids) =>
      Effect.sync(() => {
        callers.push(caller);
        return {
          agents: [
            { id: MAIN_AGENT_ID, name: MAIN_AGENT_ID, kind: "main", state: "idle", self: true },
            {
              id: scout.id,
              name: scout.name,
              kind: "run",
              state: "running",
              parentId: MAIN_AGENT_ID,
              depth: 1,
              runtime: "pi",
              profile: "scout",
              task: "Map the API",
              self: false,
              run: view({
                ...scout,
                parentRunId: "root",
                writeIntent: "writer",
                writerWorkspaceMode: "worktree",
                workspaceId: "ws-1",
                question: { requestId: "q-1", message: "Which API?" },
                state: "waiting_for_parent",
              }),
            },
          ],
          missingIds: ids?.filter((id) => id !== MAIN_AGENT_ID && id !== scout.id) ?? [],
        };
      }),
    agentSend: (caller, to) => {
      if (to === "agent-slow")
        return Effect.succeed({
          messageId: "message-2",
          to,
          name: scout.name,
          disposition: "guided" as const,
          confirmed: false,
        });
      if (to === "agent-busy")
        return Effect.fail(
          agentMessageRefusal(
            "agent_unavailable",
            "Agent agent-busy is starting; try again once it is running.",
          ),
        );
      return Effect.sync(() => {
        callers.push(caller);
        return {
          messageId: "message-1",
          to,
          name: scout.name,
          disposition: "guided" as const,
          confirmed: true,
        };
      });
    },
    agentRead: () => Effect.succeed(READ),
  });

const registered = () =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("render-only fixture")),
    }),
  ).tools;

const registeredTool = (name: string) => registered().find((tool) => tool.name === name)!;

const namespaceOf = (nested: boolean) =>
  captureRegistrations((pi) =>
    registerAgentTools(pi, {
      execute: () => Promise.reject(new Error("render-only fixture")),
      nested,
    }),
  ).tools.find((tool) => tool.name === "agent_list")?.namespace;

describe("agent tools", () => {
  it.effect("lists, messages, and reads agents as the main agent with structured results", () =>
    Effect.gen(function* () {
      callers.length = 0;
      const tools = captureSubagentTools(agentService());

      const listed = yield* Effect.promise(() =>
        executeTool(tools.get("agent_list")!, { agentIds: ["main", "agent-1", "agent-gone"] }),
      );
      expect(listed.content[0]?.text).toContain('agent-1 "api-scout"');
      expect(listed.content[0]?.text).toContain("agent-gone");
      expect(decodeSubagentContract("agent_list")(listed.structuredContent)).toMatchObject({
        tool: "agent_list",
        agents: [
          { id: "main", kind: "main", state: "idle", self: true },
          {
            id: "agent-1",
            parentId: "main",
            profile: "scout",
            task: "Map the API",
            model: "pi/openai-codex/gpt-5.6-sol:high",
            writeIntent: "writer",
            worktree: { workspaceId: "ws-1", status: "open" },
            attention: { kind: "question", message: "Which API?" },
          },
        ],
        missingIds: ["agent-gone"],
      });
      expect(listed.content[0]?.text).toContain("ws-1");

      const sent = yield* Effect.promise(() =>
        executeTool(tools.get("agent_send")!, { to: "agent-1", message: "Check the schema." }),
      );
      expect(sent.details).toMatchObject({ action: "agent_send", disposition: "guided" });

      const pending = yield* Effect.promise(() =>
        executeTool(tools.get("agent_send")!, { to: "agent-slow", message: "Check again." }),
      );
      expect(pending.details).toMatchObject({
        action: "agent_send",
        disposition: "guided",
        confirmed: false,
      });

      const read = yield* Effect.promise(() =>
        executeTool(tools.get("agent_read")!, { agentIds: ["main", "agent-1", "agent-gone"] }),
      );
      const readText = read.content[0]?.text ?? "";
      expect(readText).toContain("MAIN_TAIL_SENTINEL");
      expect(readText).toContain("Found the schema");
      // Each run's status card comes before its message.
      expect(readText).toContain("Schema drift is likely.");
      expect(readText).not.toContain("pid 4242");
      expect(decodeSubagentContract("agent_read")(read.structuredContent)).toMatchObject({
        agents: [
          { kind: "main", state: "busy", textStatus: "text" },
          {
            kind: "run",
            source: "report",
            truncated: true,
            reportGeneration: 1,
            status: { runId: "agent-1", state: "completed", report: { status: "unknown" } },
          },
        ],
        missingIds: ["agent-gone"],
      });

      const verbose = yield* Effect.promise(() =>
        executeTool(tools.get("agent_read")!, { agentIds: ["agent-1"], verbose: true }),
      );
      expect(verbose.content[0]?.text).toContain("pid 4242");
      expect(callers).toEqual([{ kind: "main" }, { kind: "main" }]);
    }),
  );

  it.effect("rejects refused sends with their code for the model and the presentation", () =>
    Effect.gen(function* () {
      const tool = captureSubagentTools(agentService()).get("agent_send")!;
      const error = yield* Effect.promise(() =>
        executeTool(tool, { to: "agent-busy", message: "Again?" }).then(
          () => undefined,
          (cause: unknown) => cause,
        ),
      );
      expect(error).toBeInstanceOf(Error);
      const text = error instanceof Error ? error.message : "";
      expect(text).toMatch(/^\[agent_unavailable\] /u);

      const [issue] = agentFailureIssues(text, "send", "The agent");
      expect(issue?.code).toBe("agent:agent_unavailable");
      const harness = createToolPresentationHarness(registeredTool("agent_send"));
      for (const expanded of [false, true]) {
        harness.call({ to: "agent-busy", message: "Again?" }, { expanded, isError: true });
        harness.result(
          { content: [{ type: "text", text }], details: {} },
          { expanded, isError: true },
        );
        const rendered = harness.render(100).join("\n");
        expect(rendered).toContain(issue?.message);
        // The refusal's procedure belongs to expansion.
        expect(rendered.includes("Check the agent's state with agent_list")).toBe(expanded);
      }
    }),
  );

  it("presents every refusal code as a short issue with its recovery expanded", () => {
    const codes = [
      ...AGENT_MESSAGE_REFUSAL_CODES,
      "too_many_targets",
      "agent_ids_required",
      "scripted_agent_send_not_supported",
    ];
    for (const code of codes) {
      const [issue] = agentFailureIssues(
        `[${code}] Agent agent-r1-7 refused.`,
        "send",
        "The agent",
      );
      expect(issue?.code).toBe(`agent:${code}`);
      expect(issue?.detail).toContain("agent-r1-7");
      expect(
        issueMessageStyleProblems(issue?.message ?? "", { forbidden: ["agent-r1-7"] }),
        code,
      ).toEqual([]);
    }
  });

  it.effect("raises each read run's status issues without failing the read", () =>
    Effect.gen(function* () {
      const asking = view({
        id: "agent-1",
        name: "auth-review",
        state: "waiting_for_parent",
        warning: "Credentials were exposed",
        question: { requestId: "q-1", message: "May I continue?" },
      });
      const failed = view({
        id: "agent-2",
        name: "fixer",
        state: "failed",
        error: "Tests failed.",
      });
      const tools = captureSubagentTools(
        subagentServiceDouble({
          agentRead: () =>
            Effect.succeed({ agents: [readout(asking), readout(failed)], missingIds: [] }),
        }),
      );
      const args = { agentIds: [asking.id, failed.id] };
      const read = yield* Effect.promise(() => executeTool(tools.get("agent_read")!, args));
      const summary = createAgentCompactSummary("agent_read")({
        phase: "settled",
        args,
        result: {
          content: [{ type: "text", text: read.content[0]?.text ?? "" }],
          details: read.details,
        },
        context: renderContextFixture({}),
      });
      expect(summary?.outcome).toBe("warning");
      const issues = summary?.issues ?? [];
      expect(issues.map((issue) => issue.message)).toEqual(
        expect.arrayContaining([
          stringContaining("May I continue?"),
          stringContaining("Credentials were exposed"),
          stringContaining("Tests failed"),
        ]),
      );
      expect(issues.filter((issue) => issue.severity === "error")).toEqual([]);
      expect(issues.flatMap((issue) => issueMessageStyleProblems(issue.message))).toEqual([]);
    }),
  );

  it("shows every argument once a call is expanded", () => {
    const harness = createToolPresentationHarness(registeredTool("agent_read"));
    const agentIds = ["agent-r1-1", "agent-r1-2", "agent-r1-3", "agent-r1-4"];
    harness.call({ agentIds }, { expanded: true });
    harness.result(
      {
        content: [{ type: "text", text: "Read four agents." }],
        details: { version: 1, action: "agent_read", agents: [], missingIds: [] },
      },
      { expanded: true },
    );
    const rendered = harness.render(100).join("\n");
    for (const id of agentIds) expect(rendered).toContain(id);

    const send = createToolPresentationHarness(registeredTool("agent_send"));
    send.call({ to: "agent-r1-9", message: "Ship it." }, { expanded: true, isError: true });
    send.result(
      {
        content: [{ type: "text", text: "[agent_unavailable] The agent is stopping." }],
        details: {},
      },
      { expanded: true, isError: true },
    );
    const failed = send.render(100).join("\n");
    expect([failed.includes("agent-r1-9"), failed.includes("Ship it.")]).toEqual([true, true]);
  });

  it("describes a subagent's script namespace apart from the root's", () => {
    const root = namespaceOf(false);
    const nested = namespaceOf(true);
    expect(nested?.name).toBe(root?.name);
    expect(nested?.description).not.toBe(root?.description);
    expect(root?.description).toBe(
      registered().find((tool) => tool.name === "agent_start")?.namespace?.description,
    );
  });

  it("keeps the main agent's full read text for expansion", () => {
    const harness = createToolPresentationHarness(registeredTool("agent_read"));
    const text = [
      `the main agent (busy), latest assistant message:\n${READ.agents[0]?.text ?? ""}`,
      `agent-1 "api-scout" (completed, report 1), report (truncated):\nFound the schema in src/api.ts.`,
    ].join("\n\n");
    const details = {
      version: 1,
      action: "agent_read",
      agents: [
        { id: "main", name: "main", state: "busy", textStatus: "text", truncated: false },
        {
          id: "agent-1",
          name: "api-scout",
          state: "completed",
          textStatus: "text",
          truncated: true,
          source: "report",
        },
      ],
      missingIds: [],
    };
    for (const expanded of [false, true, false]) {
      harness.call({ agentIds: ["main", "agent-1"] }, { expanded });
      harness.result({ content: [{ type: "text", text }], details }, { expanded });
      const rendered = harness.render(100).join("\n");
      expect(rendered.includes("MAIN_TAIL_SENTINEL")).toBe(expanded);
    }
  });

  it.live(
    "lets scripts list and read agents but never send",
    () =>
      Effect.gen(function* () {
        const h = yield* nativeCodemodeSession(agentService());
        expect(h.session.getCallableToolNames()).toEqual(
          expect.arrayContaining(["agent_list", "agent_read"]),
        );
        expect(h.session.getCallableToolNames()).not.toContain("agent_send");
        expect(h.session.getActiveToolNames()).toContain("agent_send");
        const result = yield* h.run(`
          const listed = await tools.agent_list({});
          let refused = false;
          try { await tools.agent_send({ to: "agent-1", message: "From a script" }); }
          catch { refused = true; }
          text('WORKFLOW_RESULT ' + JSON.stringify({ tool: listed.tool, count: listed.agents.length, refused }));
        `);
        expect(result.text).toContain(
          'WORKFLOW_RESULT {"tool":"agent_list","count":2,"refused":true}',
        );
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );

  it.effect("refuses scripted sends that reach the executor", () =>
    Effect.gen(function* () {
      const error = yield* executeAgentActionEffect(
        { tool: "agent_send", args: { to: "agent-1", message: "From a script" } },
        { kind: "main" },
        true,
      ).pipe(Effect.provideService(SubagentService, agentService()), Effect.flip);
      expect(error.message).toMatch(/^\[scripted_agent_send_not_supported\] /u);
    }),
  );
});
