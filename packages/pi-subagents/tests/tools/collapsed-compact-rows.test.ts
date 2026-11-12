import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { stripAnsi } from "pi-cosmic-core";
import { extensionApiFixture, keybindingHintsFixture, plainTheme } from "pi-cosmic-core/testing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderAgentMessageEntry, renderSubagentMessage } from "../../src/application/messages.ts";
import { agentMessageDetails, AGENT_MESSAGE_TYPE } from "../../src/boundary/host-agent-messages.ts";
import { hostNotifier } from "../../src/boundary/host-notifier.ts";
import {
  agentMessageContent,
  runSender,
  type AgentReadout,
} from "../../src/run/agent-messaging.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { listDetails, readDetails } from "../../src/tools/agent-details.ts";
import { awaitDetails, startDetails } from "../../src/tools/details.ts";
import { runIdFixture, view } from "../fixtures/run-view.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { captureSubagentTools } from "./fixtures/tool-harness.ts";

/**
 * Compact style's collapsed rule: a row is its heading, then one line per error, warning, or
 * pending question, and everything else waits for expansion, which shows each fact once.
 */

const REPORT = "REPORT_SENTINEL: three stale references\n- docs/auth.md:42";
const FAILURE = "Disk is full on the build host\nSTACK_SENTINEL at writeFile (fs.js:1)";
const QUESTION = "Should the seed file get the new column too?";

let restore = () => {};
beforeEach(() => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "compact", toolCallTiming: false });
});
afterEach(() => restore());

const tools = (panel = false) =>
  captureSubagentTools(subagentServiceDouble({}), {
    environment: { cwd: "/project", projectTrusted: false },
    startUiTicker: () => () => undefined,
    toolPresentation: {
      beginStart: () => () => undefined,
      beginAwait: () => () => undefined,
      isLiveHierarchyAvailable: () => panel,
    },
  });

const tool = (name: string, panel = false) => tools(panel).get(name)!;

const finished = view({
  id: runIdFixture(1),
  name: "auth-review",
  state: "completed",
  finalText: REPORT,
  startedAt: 1,
  endedAt: 2,
});
const failed = view({
  id: runIdFixture(2),
  name: "db-migration",
  state: "failed",
  error: FAILURE,
  startedAt: 1,
  endedAt: 2,
});
const running = (id: number, name: string): SubagentRunView =>
  view({ id: runIdFixture(id), name, state: "running", startedAt: 1 });

const entry = (run: SubagentRunView) => ({
  id: run.id,
  name: run.name,
  kind: "run" as const,
  state: run.state,
  self: false,
  run,
});

const occurrences = (text: string, part: string): number => Str.split(text, part).length - 1;

interface Frames {
  readonly collapsed: ReadonlyArray<string>;
  readonly expanded: string;
}

/** A settled row drawn collapsed, then expanded, as plain rows. */
type RowResult = Parameters<ReturnType<typeof createToolPresentationHarness>["result"]>[0];

const settledRow = (
  name: string,
  args: Parameters<ReturnType<typeof createToolPresentationHarness>["call"]>[0],
  result: RowResult,
  isError = false,
): Frames => {
  const harness = createToolPresentationHarness(tool(name), { width: 140 });
  const draw = (expanded: boolean) => {
    harness.call(args, { expanded, isError });
    harness.result(result, { expanded, isError, isPartial: false });
    return Arr.map(harness.render(140), (row) => stripAnsi(row));
  };
  const collapsed = draw(false);
  return { collapsed, expanded: Arr.join(draw(true), "\n") };
};

const text = (value: string): RowResult["content"] => [{ type: "text", text: value }];

/** The rows beneath a collapsed heading, each led by a problem's glyph. */
const problemLines = (rows: ReadonlyArray<string>): ReadonlyArray<string> =>
  Arr.map(rows.slice(1), (row) => Str.trim(row));

describe("collapsed compact tool rows", () => {
  it("settle a wait to one row and one line per failed or asking run, its reports behind expansion", () => {
    const asking = view({
      id: runIdFixture(3),
      name: "schema-check",
      state: "waiting_for_parent",
      question: { requestId: "q-1", message: QUESTION },
    });
    const runs = [finished, failed, asking];
    const { collapsed, expanded } = settledRow(
      "agent_await",
      { runIds: Arr.map(runs, (run) => run.id) },
      {
        content: text("await output"),
        details: awaitDetails({
          runs,
          awaitedRunIds: Arr.map(runs, (run) => run.id),
          awaitUntil: "all_finished",
          attentionRequired: true,
        }),
      },
    );
    expect(collapsed).toHaveLength(3);
    const [failure, question] = problemLines(collapsed);
    expect(failure).toContain("Disk is full");
    expect(question).toContain(`schema-check asks: ${QUESTION}`);
    expect(Arr.join(collapsed, "\n")).not.toContain("REPORT_SENTINEL");
    expect(Arr.join(collapsed, "\n")).not.toContain("STACK_SENTINEL");
    // Expanded, the failure is its issue alone, and every report, failure, and question shows once.
    expect(occurrences(expanded, "REPORT_SENTINEL")).toBe(1);
    expect(occurrences(expanded, "Disk is full")).toBe(1);
    expect(occurrences(expanded, "STACK_SENTINEL")).toBe(1);
    expect(occurrences(expanded, QUESTION)).toBe(1);
  });

  it("show a wait's live run tree only while it waits, unless the Activity panel draws it", () => {
    const runs = [running(1, "auth-review"), running(2, "db-migration")];
    const args = { runIds: Arr.map(runs, (run) => run.id) };
    const progress = (panel: boolean, state: "running" | "completed") => {
      const harness = createToolPresentationHarness(tool("agent_await", panel), { width: 140 });
      const shown = Arr.map(runs, (run) =>
        state === "completed" ? { ...run, state, finalText: "Done.", endedAt: 2 } : run,
      );
      harness.call(args, { executionStarted: true });
      harness.result(
        {
          content: text("Waiting."),
          details: awaitDetails({
            runs: shown,
            awaitedRunIds: args.runIds,
            awaitUntil: "all_finished",
          }),
        },
        { isPartial: state === "running" },
      );
      return Arr.map(harness.render(140), (row) => stripAnsi(row));
    };
    const live = progress(false, "running");
    expect(live.length).toBeGreaterThan(1);
    expect(Arr.join(live.slice(1), "\n")).toContain("auth-review");
    expect(Arr.join(live.slice(1), "\n")).toContain("db-migration");
    expect(progress(true, "running")).toHaveLength(1);
    expect(progress(false, "completed")).toHaveLength(1);
  });

  it("keep a read neutral, adding no problem line for the failure of the run it read", () => {
    const readout: AgentReadout = {
      kind: "run",
      id: failed.id,
      name: failed.name,
      state: "failed",
      textStatus: "text",
      text: FAILURE,
      truncated: false,
      source: "error",
      reportGeneration: 1,
      run: failed,
    };
    const { collapsed, expanded } = settledRow(
      "agent_read",
      { agentIds: [failed.id] },
      {
        content: text("read output"),
        details: readDetails({ agents: [readout], missingIds: [] }, () => FAILURE, 0),
      },
    );
    expect(collapsed).toHaveLength(1);
    const [heading = ""] = collapsed;
    expect(heading).toContain("failed");
    expect(heading).not.toMatch(/[✗⚠]/u);
    expect(occurrences(expanded, "Disk is full")).toBe(1);
    expect(occurrences(expanded, "STACK_SENTINEL")).toBe(1);
  });

  it("list agents as one row and expand them as one list", () => {
    const listed = [finished, failed, running(4, "docs-sweep")];
    const { collapsed, expanded } = settledRow(
      "agent_list",
      {},
      {
        content: text("list output"),
        details: listDetails({ agents: Arr.map(listed, entry), missingIds: [] }, 0),
      },
    );
    expect(collapsed).toHaveLength(1);
    expect(collapsed[0]).not.toMatch(/[✓✗⚠]/u);
    for (const run of listed) {
      expect(Arr.join(collapsed, "\n")).not.toContain(run.name);
      expect(occurrences(expanded, run.name)).toBeGreaterThan(0);
    }
  });

  it("keep a failed launch's cause as its problem line beside the launches that started", () => {
    const started = {
      index: 0,
      name: "auth-review",
      profile: "scout",
      status: "started" as const,
      routeStatus: "selected" as const,
      model: "openai-codex/gpt-6-luna",
      effort: "high" as const,
      openaiFastMode: false,
      candidateIndex: 1,
      runId: runIdFixture(1),
    };
    const { runId: _runId, ...selected } = { ...started, index: 1, name: "db-migration" };
    const { collapsed, expanded } = settledRow(
      "agent_start",
      {
        agents: [
          { name: "auth-review", profile: "scout", task: "TASK_ONE" },
          { name: "db-migration", profile: "scout", task: "TASK_TWO" },
        ],
      },
      {
        content: text("start output"),
        details: startDetails({
          startEntries: [started, { ...selected, status: "failed" }],
          startFailures: [{ index: 1, name: "db-migration", message: FAILURE, code: "spawn" }],
        }),
      },
    );
    expect(collapsed).toHaveLength(2);
    expect(problemLines(collapsed)[0]).toContain("Disk is full");
    expect(Arr.join(collapsed, "\n")).not.toContain("TASK_ONE");
    for (const task of ["TASK_ONE", "TASK_TWO"]) expect(occurrences(expanded, task)).toBe(1);
  });
});

type SentMessage = Parameters<ExtensionAPI["sendMessage"]>[0];

const drawMessage = (message: SentMessage, expanded: boolean): ReadonlyArray<string> => {
  const renderer =
    message.customType === AGENT_MESSAGE_TYPE ? renderAgentMessageEntry : renderSubagentMessage;
  const component = renderer(
    { ...message, role: "custom", timestamp: 0, display: true },
    { ...keybindingHintsFixture, expanded, outputPad: 0 },
    plainTheme,
  );
  return Arr.map(component?.render(140) ?? [], (row) => stripAnsi(row));
};

const notices = (): ReadonlyArray<SentMessage> => {
  const sendMessage = vi.fn<ExtensionAPI["sendMessage"]>();
  const notify = hostNotifier(extensionApiFixture({ sendMessage }));
  notify({
    type: "completed",
    runs: [
      {
        id: finished.id,
        name: "auth-review",
        generation: 1,
        outcome: "completed",
        finalText: REPORT,
      },
    ],
  });
  notify({
    type: "completed",
    runs: [
      { id: failed.id, name: "db-migration", generation: 1, outcome: "failed", error: FAILURE },
    ],
  });
  notify({
    type: "question",
    id: runIdFixture(3),
    name: "schema-check",
    requestId: "q-1",
    generation: 1,
    message: QUESTION,
  });
  return Arr.map(sendMessage.mock.calls, ([message]) => message);
};

describe("collapsed compact messages", () => {
  it("show a report notice as one row and its report only expanded", () => {
    const [report, failure] = notices();
    const collapsed = drawMessage(report!, false);
    expect(collapsed).toHaveLength(1);
    expect(Arr.join(collapsed, "\n")).not.toContain("REPORT_SENTINEL");
    expect(occurrences(Arr.join(drawMessage(report!, true), "\n"), "REPORT_SENTINEL")).toBe(1);

    const failedRows = drawMessage(failure!, false);
    expect(failedRows).toHaveLength(2);
    expect(problemLines(failedRows)[0]).toContain("Disk is full");
    const failedExpanded = Arr.join(drawMessage(failure!, true), "\n");
    expect(occurrences(failedExpanded, "Disk is full")).toBe(1);
    expect(occurrences(failedExpanded, "STACK_SENTINEL")).toBe(1);
  });

  it("raise a pending question as its problem line, quoted once expanded", () => {
    const [, , question] = notices();
    if (question === undefined) throw new Error("No question notice was sent");
    const collapsed = drawMessage(question, false);
    expect(collapsed).toHaveLength(2);
    expect(problemLines(collapsed)[0]).toContain(`schema-check asks: ${QUESTION}`);
    expect(occurrences(Arr.join(drawMessage(question, true), "\n"), QUESTION)).toBe(1);
  });

  it("keep an agent message's words behind expansion", () => {
    const content = agentMessageContent(runSender(failed), "MESSAGE_SENTINEL");
    const message: SentMessage = {
      customType: AGENT_MESSAGE_TYPE,
      content,
      details: agentMessageDetails({
        messageId: "message-1",
        from: failed.id,
        fromName: failed.name,
        to: "main",
        content,
        text: "MESSAGE_SENTINEL",
      }),
      display: true,
    };
    expect(drawMessage(message, false)).toHaveLength(1);
    expect(Arr.join(drawMessage(message, false), "\n")).not.toContain("MESSAGE_SENTINEL");
    expect(occurrences(Arr.join(drawMessage(message, true), "\n"), "MESSAGE_SENTINEL")).toBe(1);
  });
});
