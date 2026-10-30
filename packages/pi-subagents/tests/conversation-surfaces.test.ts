import { afterEach, describe, expect, it } from "@effect/vitest";
import type { ExtensionAPI, ToolDefinition } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { getTextContent } from "pi-code-previews";
import {
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
} from "pi-code-previews/testing";
import { stripAnsi } from "pi-cosmic-core";
import { extensionApiFixture, plainTheme } from "pi-cosmic-core/testing";
import { vi } from "vitest";
import {
  registerSubagentMessageRenderers,
  renderAgentMessageEntry,
  renderSubagentMessage,
} from "../src/application/messages.ts";
import { AGENT_MESSAGE_TYPE, agentMessageDetails } from "../src/boundary/host-agent-messages.ts";
import { hostNotifier } from "../src/boundary/host-notifier.ts";
import {
  agentMessageContent,
  runSender,
  startingTargetRefusal,
  type AgentListEntry,
  type AgentReadout,
} from "../src/run/agent-messaging.ts";
import { SubagentService } from "../src/run/service.ts";
import { codedFailure, isSubagentError } from "../src/run/errors.ts";
import { scriptedWriterAdmissionError } from "../src/run/launch-policy.ts";
import { settledFailureMessage } from "../src/run/settlement-outcome.ts";
import { mapWorkspaceError, workspaceBusyError } from "../src/run/workspace-binding.ts";
import { workspaceRefusal } from "../src/boundary/git-worktree-process.ts";
import { WorkspaceError } from "../src/workspace/model.ts";
import { toolFailureDetails } from "../src/tools/failure-details.ts";
import type { SubagentRunView } from "../src/run/model.ts";
import { awaitDetails } from "../src/tools/details.ts";
import { executeAgentActionEffect, scriptedAgentSendRefusal } from "../src/tools/execute-agents.ts";
import type { AgentToolInput } from "../src/tools/schema.ts";
import { registerSubagentTools } from "../src/tools/subagent.ts";
import { view } from "./fixtures/run-view.ts";
import { subagentServiceDouble } from "./tools/fixtures/subagent-service-double.ts";

/** Instructions written for agents, which the user's view never draws. */
const AGENT_PROCEDURES =
  /agent_\w+\(|agent_await again|reply with agent_send|with agent_(?:send|read|list|await)\b|call agent_list|not user authority|agent_worktree apply/iu;

const STYLES = ["compact", "preview"] as const;
let restore = () => {};
afterEach(() => restore());

const question = "Should the seed file get the new column too?";
const report = "Found 3 stale references:\n- docs/auth.md:42\n- README.md:120";
const writer = view({
  id: "agent-7",
  name: "db-migration",
  profile: "worker",
  writeIntent: "writer",
  writerWorkspaceMode: "worktree",
  workspaceId: "ws-1",
  state: "completed",
  finalText: report,
  workspaceOutcome: { status: "proposal", changedFileCount: 2 },
});
const asking = view({
  id: "agent-8",
  name: "schema-check",
  state: "waiting_for_parent",
  question: { requestId: "q-1", message: question },
});
const paused = view({ id: "agent-9", name: "auth-review", state: "paused" });

type SentMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

const renderMessage = (message: SentMessage, expanded: boolean): string => {
  expect(
    captureRegistrations(registerSubagentMessageRenderers).messageRenderers.has(message.customType),
  ).toBe(true);
  const renderer =
    message.customType === AGENT_MESSAGE_TYPE ? renderAgentMessageEntry : renderSubagentMessage;
  const component = renderer(
    { ...message, role: "custom", timestamp: 0, display: true },
    { expanded, outputPad: 0 },
    plainTheme,
  );
  return stripAnsi(Arr.join(component?.render(100) ?? [], "\n"));
};

const notices = (): ReadonlyArray<SentMessage> => {
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const notify = hostNotifier(extensionApiFixture({ sendMessage }));
  notify({
    type: "completed",
    runs: [
      {
        id: writer.id,
        name: writer.name,
        generation: 1,
        outcome: "completed",
        finalText: report,
        workspaceId: "ws-1",
        workspaceOutcome: { status: "proposal", changedFileCount: 2 },
      },
      {
        id: "agent-3",
        name: "api-audit",
        generation: 1,
        outcome: "failed",
        error: "Error: 429 Too Many Requests",
        nextCandidate: { model: "openai/next", effort: "high" },
      },
    ],
  });
  notify({
    type: "question",
    id: asking.id,
    name: asking.name,
    requestId: "q-1",
    generation: 1,
    message: question,
  });
  return Arr.map(sendMessage.mock.calls, ([message]) => message);
};

describe("conversation surfaces", () => {
  it.each(STYLES)("draws notices from their details without agent procedures (%s)", (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
    for (const message of notices()) {
      const before = JSON.stringify(message);
      // The model still reads the procedures in the notice's content.
      expect(JSON.stringify(message.content)).toMatch(/agent_worktree apply|agent_send\(/u);
      for (const expanded of [false, true]) {
        const text = renderMessage(message, expanded);
        expect(text).not.toMatch(AGENT_PROCEDURES);
        // Messages keep agents' words visible collapsed in both styles.
        expect(text).toContain(
          message.customType === "pi-subagents-question" ? question : "docs/auth.md:42",
        );
      }
      expect(JSON.stringify(message)).toBe(before);
    }
  });

  it("falls back to the notice's content when saved details carry no display copy", () => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const [completion] = notices();
    if (completion === undefined) throw new Error("No completion notice was sent.");
    const historical = {
      ...completion,
      details: { version: 1, kind: "completed", total: 2, failed: 1, warnings: 0 },
    };
    expect(renderMessage(historical, false)).not.toContain("docs/auth.md:42");
    expect(renderMessage(historical, true)).toContain("docs/auth.md:42");
  });

  it("frames an agent message for the model and shows only its words to the user", () => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const words = "The fixtures moved.\nI kept re-exports.";
    const content = agentMessageContent(runSender(asking), words);
    const details = agentMessageDetails({
      messageId: "message-1",
      from: asking.id,
      fromName: asking.name,
      to: "main",
      content,
      text: words,
    });
    expect(details).toMatchObject({ text: words });
    const message = { customType: AGENT_MESSAGE_TYPE, content, display: true, details };
    for (const expanded of [false, true]) {
      const text = renderMessage(message, expanded);
      // Its line breaks stay.
      expect(text).toMatch(/The fixtures moved\.\s*\n\s*I kept re-exports\./u);
      expect(text).not.toMatch(AGENT_PROCEDURES);
    }
    const { text: _words, ...historical } = details;
    // Without a display copy, expansion shows the message as the main agent received it.
    expect(renderMessage({ ...message, details: historical }, true)).toContain("Reply with");
  });
});

const tools = () =>
  captureRegistrations((pi) =>
    registerSubagentTools(pi, {
      environment: { cwd: "/project", projectTrusted: false },
      run: () => Promise.reject(new Error("render-only fixture")),
      startUiTicker: () => () => undefined,
    }),
  ).tools;

const toolNamed = (name: string): ToolDefinition =>
  Option.getOrThrow(Arr.findFirst(tools(), (tool) => tool.name === name));

const listEntry = (run: SubagentRunView): AgentListEntry => ({
  id: run.id,
  name: run.name,
  kind: "run",
  state: run.state,
  parentId: "main",
  depth: 1,
  task: run.task,
  self: false,
  run,
});

const readout = (run: SubagentRunView, text: string): AgentReadout => ({
  kind: "run",
  id: run.id,
  name: run.name,
  state: run.state,
  textStatus: "text",
  text,
  truncated: false,
  source: "assistant",
  reportGeneration: 1,
  run,
});

const executed = (input: AgentToolInput) =>
  executeAgentActionEffect(input, { kind: "main" }).pipe(
    Effect.provideService(
      SubagentService,
      subagentServiceDouble({
        agentList: () =>
          Effect.succeed({
            agents: Arr.map([writer, asking, paused], listEntry),
            missingIds: ["agent-gone"],
          }),
        agentRead: () =>
          Effect.succeed({
            agents: [readout(asking, "Which seed file?"), readout(paused, "Halfway there.")],
            missingIds: ["agent-gone"],
          }),
        agentSend: (_caller, to) =>
          Effect.succeed({
            messageId: "message-1",
            to,
            name: asking.name,
            disposition: "answered",
          }),
      }),
    ),
  );

describe("tool results", () => {
  it.effect.each(STYLES)("draw agent tools from their details without procedures (%s)", (style) =>
    Effect.gen(function* () {
      restore = applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
      const inputs: ReadonlyArray<AgentToolInput> = [
        { tool: "agent_list", args: { agentIds: [writer.id, "agent-gone"] } },
        { tool: "agent_read", args: { agentIds: [asking.id, paused.id, "agent-gone"] } },
        { tool: "agent_send", args: { to: asking.id, message: "Yes, extend it." } },
      ];
      for (const input of inputs) {
        const result = yield* executed(input);
        const before = structuredClone(result);
        const frames = createToolPresentationHarness(toolNamed(input.tool), { width: 120 }).cycle(
          input.args,
          result,
          { states: [false, true] },
        );
        for (const { expanded, text } of frames) {
          const plain = stripAnsi(text);
          expect(plain, input.tool).not.toMatch(AGENT_PROCEDURES);
          if (input.tool === "agent_read" && (style === "preview" || expanded))
            expect(plain).toContain("Which seed file?");
          if (input.tool === "agent_send" && style === "preview")
            expect(plain).toContain(asking.name);
        }
        expect(result).toEqual(before);
      }
    }),
  );

  it.each(STYLES)("draws a wait that needs the parent without procedures (%s)", (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
    const result = {
      content: [{ type: "text" as const, text: 'Answer with agent_send({ to: "agent-8" })' }],
      details: awaitDetails({
        runs: [writer, asking, paused],
        awaitUntil: "all_finished",
        attentionRequired: true,
      }),
    };
    const frames = createToolPresentationHarness(toolNamed("agent_await"), { width: 120 }).cycle(
      { runIds: [writer.id, asking.id, paused.id] },
      result,
      { states: [false, true] },
    );
    for (const { expanded, text } of frames) {
      const plain = stripAnsi(text);
      expect(plain).not.toMatch(AGENT_PROCEDURES);
      if (style === "preview" || expanded) expect(plain).toContain("README.md:120");
    }
  });

  it("falls back to the result's text for agent_read details saved without display copies", () => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: "preview" });
    const frames = createToolPresentationHarness(toolNamed("agent_read"), { width: 120 }).cycle(
      { agentIds: [asking.id] },
      {
        content: [{ type: "text", text: "HISTORICAL_READ_TEXT" }],
        details: {
          version: 1,
          action: "agent_read",
          agents: [
            {
              id: asking.id,
              name: asking.name,
              state: asking.state,
              textStatus: "text",
              truncated: false,
            },
          ],
          missingIds: [],
        },
      },
      { states: [true] },
    );
    for (const { text } of frames) expect(text).toContain("HISTORICAL_READ_TEXT");
  });
});

/** Procedures a failure's model copy may add, which its user copy leaves out. */
const FAILURE_PROCEDURES =
  /(?:with|call|from) agent_\w+|agent_\w+\(|\b[Rr]etry\b|Remedy:|main agent can start/u;

const provider = settledFailureMessage({
  stopReason: "error",
  errorMessage: "429 Too Many Requests: rate limit exceeded",
  text: "Migrated two tables.",
});
const failedRun = view({
  id: "agent-5",
  name: "migration-review",
  state: "failed",
  error: provider.message,
  userError: provider.userMessage,
});

const occurrences = (text: string, part: string): number => Str.split(text, part).length - 1;

describe("failures", () => {
  it("keep the model's text while their user copy leaves the procedure out", () => {
    const rebase = workspaceRefusal("rebase", "The session directory has no files.", {
      path: "src",
      rule: "the rebuilt worker must still hold the session directory",
      remedy: "Revise without rebase, or discard this workspace.",
      agentRemedy: true,
    });
    const cases: ReadonlyArray<
      readonly [{ message: string; userMessage?: string | undefined }, string]
    > = [
      [
        startingTargetRefusal("agent-4"),
        "Agent agent-4 is still starting after a few seconds; check it with agent_list and send once it runs.",
      ],
      [
        scriptedWriterAdmissionError(),
        "Agents started by a codemode script can only launch read-only agents\n\nThe main agent can start separate writer work outside this script's agents.",
      ],
      [
        scriptedAgentSendRefusal(),
        "[scripted_agent_send_not_supported] Codemode scripts can't send agent messages. End the script and send the message with agent_send directly.",
      ],
      [
        workspaceBusyError(),
        "Another operation on this workspace is still running. Retry once it finishes.",
      ],
      [
        mapWorkspaceError(rebase),
        'The session directory has no files.\nPath: "src"\nRule: the rebuilt worker must still hold the session directory\nRemedy: Revise without rebase, or discard this workspace.',
      ],
      [
        provider,
        "Final provider error: 429 Too Many Requests: rate limit exceeded Work and writes may already exist; inspect them before an explicit retry. Partial output before the failure: Migrated two tables.",
      ],
    ];
    for (const [failure, modelText] of cases) {
      expect(failure.message).toBe(modelText);
      expect(failure.userMessage, modelText).toBeDefined();
      expect(failure.userMessage).not.toMatch(/agent_\w+|\b[Rr]etry\b|Remedy:|main agent/u);
      // The details of a rejected call carry the user copy, without the code the text leads with.
      if (isSubagentError(failure))
        expect(toolFailureDetails(codedFailure(failure))?.message).toBe(failure.userMessage);
    }
  });

  it.each(STYLES)("show a failed run's words once, without procedures (%s)", (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
    const shown = "429 Too Many Requests: rate limit exceeded";
    const awaited = createToolPresentationHarness(toolNamed("agent_await"), { width: 120 }).cycle(
      { runIds: [failedRun.id] },
      {
        content: [{ type: "text", text: provider.message }],
        details: awaitDetails({ runs: [failedRun], awaitUntil: "all_finished" }),
      },
      { states: [false, true] },
    );
    for (const { expanded, text } of awaited) {
      const plain = stripAnsi(text);
      expect(plain).not.toMatch(FAILURE_PROCEDURES);
      // The run's block shows its failure; its issue names it without repeating it.
      if (style === "preview" || expanded) expect(occurrences(plain, shown)).toBe(1);
    }
  });

  it.effect.each(STYLES)("read a failed run's failure once, without procedures (%s)", (style) =>
    Effect.gen(function* () {
      restore = applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
      const result = yield* executeAgentActionEffect(
        { tool: "agent_read", args: { agentIds: [failedRun.id] } },
        { kind: "main" },
      ).pipe(
        Effect.provideService(
          SubagentService,
          subagentServiceDouble({
            agentRead: () =>
              Effect.succeed({
                agents: [{ ...readout(failedRun, provider.message), source: "error" as const }],
                missingIds: [],
              }),
          }),
        ),
      );
      // The model still reads the procedure.
      expect(getTextContent(result.content)).toContain("explicit retry");
      const frames = createToolPresentationHarness(toolNamed("agent_read"), { width: 120 }).cycle(
        { agentIds: [failedRun.id] },
        result,
        { states: [true] },
      );
      for (const { text } of frames) {
        const plain = stripAnsi(text);
        expect(plain).not.toMatch(FAILURE_PROCEDURES);
        expect(occurrences(plain, "Migrated two tables.")).toBe(1);
      }
    }),
  );

  it.each(STYLES)("notify a failed run without procedures (%s)", (style) => {
    restore = applyPresentationSettings({ toolCallCollapsedStyle: style });
    const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
    hostNotifier(extensionApiFixture({ sendMessage }))({
      type: "completed",
      runs: [
        {
          id: failedRun.id,
          name: failedRun.name,
          generation: 1,
          outcome: "failed",
          error: provider.message,
          userError: provider.userMessage,
        },
      ],
    });
    const message = sendMessage.mock.calls[0]?.[0];
    if (message === undefined) throw new Error("No completion notice was sent.");
    expect(JSON.stringify(message.content)).toContain("explicit retry");
    for (const expanded of [false, true]) {
      const text = renderMessage(message, expanded);
      expect(text).not.toMatch(FAILURE_PROCEDURES);
      expect(text).toContain("Migrated two tables.");
    }
  });

  it.each(STYLES)(
    "show a rejected worktree call's failure once, without its remedy (%s)",
    (style) => {
      restore = applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false });
      const refusal = mapWorkspaceError(
        WorkspaceError.make({
          operation: "rebase",
          code: "workspace_rebase_refused",
          message: "The previous changes can't be reapplied to the parent's current files.",
          detail: 'Unmergeable: "src/db/legacy.ts"',
          remedy: "revise without rebase, or apply the proposal and start a new writer.",
        }),
      );
      const frames = createToolPresentationHarness(toolNamed("agent_worktree"), {
        width: 120,
      }).cycle(
        { action: "revise", workspaceId: "ws-1", message: "Try again.", rebase: true },
        {
          content: [{ type: "text", text: codedFailure(refusal).message }],
          details: toolFailureDetails(codedFailure(refusal)),
        },
        { states: [false, true], overrides: () => ({ isError: true, isPartial: false }) },
      );
      for (const { expanded, text } of frames) {
        const plain = stripAnsi(text);
        expect(plain).not.toMatch(FAILURE_PROCEDURES);
        if (expanded) expect(occurrences(plain, "src/db/legacy.ts")).toBe(1);
      }
    },
  );
});
