import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Str from "effect/String";
import { stripAnsi } from "pi-cosmic-core";
import { plainTheme } from "pi-cosmic-core/testing";
import { applyPresentationSettings, createToolPresentationHarness } from "pi-code-previews/testing";
import { beforeEach, describe, expect, it } from "vitest";
import { SubagentService } from "../../src/run/service.ts";
import { decodeOutcomeDetails } from "../../src/tools/details-decode.ts";
import { awaitDetails, compactToolDetails } from "../../src/tools/details.ts";
import { executeWorkspaceAction } from "../../src/tools/execute-workspace.ts";
import {
  rememberRunNames,
  renderRequestedRuns,
  type RequestedRowState,
} from "../../src/tools/render.ts";
import { subagentServiceDouble } from "./fixtures/subagent-service-double.ts";
import { effectTest } from "../support/effect-test.ts";
import { renderOnlyTool, view } from "./fixtures/tool-harness.ts";

const requested = (
  ids: ReadonlyArray<string>,
  row: RequestedRowState,
  wait: Parameters<typeof renderRequestedRuns>[1] = { until: "all_finished" },
  tool = "agent_lifecycle",
) => stripAnsi(Arr.join(renderRequestedRuns(ids, wait, tool, plainTheme, row).render(100), "\n"));

const stopped = compactToolDetails({
  action: "stop",
  runs: [view({ id: "agent-1", name: "auth-review", state: "stopped" })],
});

describe("requested runs beside their result", () => {
  it("names the runs the result resolved and keeps unknown ids as typed", () => {
    const row: RequestedRowState = {};
    expect(requested(["agent-1", "agent-12"], row)).toContain("agent-1");
    rememberRunNames(row, decodeOutcomeDetails(stopped));
    const named = requested(["agent-1", "agent-12"], row);
    expect(named).toContain("auth-review");
    expect(named).not.toContain("agent-1,");
    expect(named).toContain("agent-12");
    // Another row's result never renames this one.
    expect(requested(["agent-1"], {})).toContain("agent-1");
  });

  it("leaves out runs a shown result names and keeps unknown ids and the wait's terms", () => {
    const row: RequestedRowState = {};
    rememberRunNames(row, decodeOutcomeDetails(stopped), true);
    expect(requested(["agent-1"], row)).toBe("");
    const unknown = requested(["agent-1", "agent-12"], row);
    expect(unknown).toContain("agent-12");
    expect(unknown).not.toContain("auth-review");
    const terms = requested(
      ["agent-1"],
      row,
      { until: "any_finished", timeoutSeconds: 30 },
      "agent_await",
    );
    expect(terms).not.toContain("auth-review");
    expect(terms).toContain("30s");
  });

  it("leaves out a target a shown stop's Details name as not stopped", () => {
    const row: RequestedRowState = {};
    const partial = compactToolDetails({
      action: "stop",
      runs: [view({ id: "agent-1", name: "auth-review", state: "stopped" })],
      actionFailures: [{ id: "agent-12", code: "not_found", message: "Run not found." }],
    });
    rememberRunNames(row, decodeOutcomeDetails(partial), true);
    const left = requested(["agent-1", "agent-12", "agent-99"], row);
    expect(left).toContain("agent-99");
    expect(left).not.toContain("agent-1");
    // A body that isn't drawn names none of them.
    rememberRunNames(row, decodeOutcomeDetails(partial), false);
    expect(requested(["agent-12"], row)).toContain("agent-12");
  });

  it("forgets what an earlier result named once a later one names nothing", () => {
    const row: RequestedRowState = {};
    rememberRunNames(row, decodeOutcomeDetails(stopped), true);
    rememberRunNames(row, undefined);
    expect(requested(["agent-1"], row)).toContain("agent-1");
  });
});

const occurrences = (text: string, part: string | RegExp): number =>
  Str.split(text, part).length - 1;

const expandedText = (harness: { render(width?: number): string[] }) =>
  stripAnsi(Arr.join(harness.render(100), "\n"));

describe.each(["compact", "preview"] as const)("requested line in %s rows", (style) => {
  beforeEach(() =>
    applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallTiming: false }),
  );

  it("leaves out agents a read's result names and the ones its not-found issue names", () => {
    const harness = createToolPresentationHarness(renderOnlyTool("agent_read"));
    harness.call({ agentIds: ["agent-1", "agent-12"] }, { expanded: true });
    const typed = expandedText(harness);
    expect(occurrences(typed, /agent-1\b/u)).toBe(1);
    expect(occurrences(typed, "agent-12")).toBe(1);
    harness.result(
      {
        content: [{ type: "text", text: "Read one agent." }],
        details: {
          version: 1,
          action: "agent_read",
          agents: [
            {
              id: "agent-1",
              name: "api-scout",
              state: "completed",
              textStatus: "text",
              truncated: false,
              source: "report",
              facts: ["agent-1 · scout → openai-codex/gpt-5.6-sol:low"],
            },
          ],
          missingIds: ["agent-12"],
        },
      },
      { expanded: true },
    );
    // The requested line repeats neither: the missing agent's ID shows once, in its issue.
    const settled = expandedText(harness);
    expect(occurrences(settled, /agent-1\b/u)).toBe(0);
    expect(occurrences(settled, "agent-12")).toBe(1);
  });

  it("leaves out agents a list's not-found issue names", () => {
    const harness = createToolPresentationHarness(renderOnlyTool("agent_list"));
    harness.call({ agentIds: ["agent-7"] }, { expanded: true });
    expect(occurrences(expandedText(harness), "agent-7")).toBe(1);
    harness.result(
      {
        content: [{ type: "text", text: "No agents found." }],
        details: {
          version: 1,
          action: "agent_list",
          agentCount: 0,
          states: [],
          entries: [],
          missingIds: ["agent-7"],
        },
      },
      { expanded: true },
    );
    expect(occurrences(expandedText(harness), "agent-7")).toBe(1);
  });

  it("keeps a found agent's ID requested when the read shows no Details with it", () => {
    const harness = createToolPresentationHarness(renderOnlyTool("agent_read"));
    harness.call({ agentIds: ["agent-only-id"] }, { expanded: true });
    harness.result(
      {
        content: [{ type: "text", text: "Read one agent." }],
        details: {
          version: 1,
          action: "agent_read",
          agents: [
            {
              id: "agent-only-id",
              name: "schema-check",
              state: "running",
              textStatus: "none",
              truncated: false,
            },
          ],
          missingIds: [],
        },
      },
      { expanded: true },
    );
    const settled = expandedText(harness);
    expect(settled).toContain("schema-check");
    expect(settled).toContain("agent-only-id");
  });

  it("names a running wait's runs in its progress tree, not again on its requested line", () => {
    const harness = createToolPresentationHarness(renderOnlyTool("agent_await"));
    const args = { runIds: ["agent-1", "agent-12"], timeoutSeconds: 30 };
    harness.call(args, { expanded: true, executionStarted: true });
    harness.result(
      {
        content: [{ type: "text", text: "Waiting." }],
        details: awaitDetails({
          runs: [view({ id: "agent-1", name: "auth-review", state: "running" })],
          awaitedRunIds: ["agent-1", "agent-12"],
          awaitUntil: "all_finished",
        }),
      },
      { expanded: true, isPartial: true },
    );
    const running = expandedText(harness);
    expect(running).toContain("auth-review");
    expect(occurrences(running, /agent-1\b/u)).toBe(0);
    expect(occurrences(running, "agent-12")).toBe(1);
    expect(running).toContain("30s");
  });

  effectTest(
    "keeps a failed worktree call's IDs after an earlier result on the row named them",
    function* () {
      const args = { action: "apply", workspaceId: "ws-1" } as const;
      const applied = yield* executeWorkspaceAction(args, "parent").pipe(
        Effect.provideService(
          SubagentService,
          subagentServiceDouble({
            workspaceApply: () =>
              Effect.succeed({
                revisionId: "rev-1",
                preparationId: "prep-1",
                preparedCwd: "/agent/ws-1/prepared",
                changedPaths: ["src/a.ts"],
                changedPathCount: 1,
                leftOutPaths: [],
                workerRoot: "/agent/ws-1/worker",
                untouchedDriftPaths: [],
                treeRemovalFailed: false,
                leaseReleaseUnconfirmed: false,
                testing: "untested",
              }),
          }),
        ),
        Effect.orDie,
      );
      const harness = createToolPresentationHarness(renderOnlyTool("agent_worktree"));
      harness.call(args, { expanded: true });
      harness.result(applied, { expanded: true });
      expect(expandedText(harness)).not.toContain("Requested worktree ws-1");
      harness.result(
        {
          content: [{ type: "text", text: "Worktree ws-1 has unresolved children." }],
          details: undefined,
        },
        { expanded: true, isError: true },
      );
      expect(expandedText(harness)).toContain("Requested worktree ws-1");
      // A row of its own never borrows another's result.
      const fresh = createToolPresentationHarness(renderOnlyTool("agent_worktree"));
      fresh.call(args, { expanded: true, isError: true });
      fresh.result(
        { content: [{ type: "text", text: "Refused." }], details: undefined },
        { expanded: true, isError: true },
      );
      expect(expandedText(fresh)).toContain("Requested worktree ws-1");
    },
  );
});
