import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { stripAnsi } from "pi-cosmic-core";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAIN_AGENT_ID, runListEntry, type AgentReadout } from "../../src/run/agent-messaging.ts";
import type { SubagentRunView } from "../../src/run/model.ts";
import { listDetails, readDetails } from "../../src/tools/agent-details.ts";
import { awaitDetails, startDetails } from "../../src/tools/details.ts";
import { runIdFixture, view } from "../fixtures/run-view.ts";
import { renderOnlyTool } from "./fixtures/tool-harness.ts";

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

const tool = (name: string, panel = false) => renderOnlyTool(name, { panel });

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
    expect(question).toContain(QUESTION);
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
        details: listDetails(
          { agents: Arr.map(listed, (run) => runListEntry(run, MAIN_AGENT_ID)), missingIds: [] },
          0,
        ),
      },
    );
    expect(collapsed).toHaveLength(1);
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
