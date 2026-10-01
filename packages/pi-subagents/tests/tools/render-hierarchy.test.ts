import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  makeAwaitDetails,
  makeCompactToolDetails,
  makeStartDetails,
} from "../../src/tools/details.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderContextFixture } from "pi-code-previews/testing";
import { createSubagentCompactSummary } from "../../src/tools/compact-summary.ts";
import { renderSubagentResult } from "../../src/tools/render.ts";
import { renderResponsiveRunRows } from "../../src/tools/render-run-rows.ts";
import {
  renderStartReceiptComponent,
  renderSubagentStartCall,
} from "../../src/tools/render-start.ts";
import { view } from "./fixtures/tool-harness.ts";

const target = view({ id: "parent", name: "Hierarchy Parent", parentRunId: "root", depth: 1 });
const child = view({
  id: "child",
  name: "Hierarchy Child",
  parentRunId: target.id,
  depth: 2,
});

type HierarchyDetails =
  | ReturnType<typeof makeAwaitDetails>
  | ReturnType<typeof makeCompactToolDetails>
  | ReturnType<typeof makeStartDetails>;
type RenderOptions = {
  readonly partial?: boolean;
  readonly expanded?: boolean;
  readonly width?: number;
  readonly panel?: boolean;
};

const render = (
  details: HierarchyDetails,
  { partial = false, expanded = false, width = 120, panel = false }: RenderOptions = {},
) =>
  renderSubagentResult(
    { content: [], details },
    partial,
    expanded,
    plainTheme,
    ...(panel ? [{ panelOwnsLiveHierarchy: true }] : []),
  ).render(width);
const text = (details: HierarchyDetails, options?: RenderOptions) =>
  render(details, options).join("\n");

describe("hierarchical tool result rendering", () => {
  it("moves from live rows to a settled summary while preserving expanded run data", () => {
    const settledTarget = view({
      id: "settled-target",
      name: "Settled target",
      state: "stopped",
      endedAt: 2,
    });
    const settledChild = view({
      id: "settled-child",
      name: "Settled child",
      state: "stopped",
      parentRunId: settledTarget.id,
      depth: 2,
      endedAt: 2,
    });
    const details = makeAwaitDetails({
      runs: [settledTarget],
      contextRuns: [settledChild],
      awaitedRunIds: [settledTarget.id],
      awaitUntil: "all_finished",
    });

    const awaiting = render(details, { partial: true, width: 160 });
    const completed = render(details, { width: 160 });
    const expanded = render(details, { expanded: true, width: 160 });

    expect(completed.length).toBeLessThan(awaiting.length);
    expect(expanded.join("\n")).toContain(settledTarget.name);
    expect(expanded.join("\n")).toContain(settledChild.name);
  });

  it("omits partial start and await hierarchy when the persistent panel owns it", () => {
    const awaitDetails = makeAwaitDetails({
      runs: [target],
      contextRuns: [child],
      awaitedRunIds: [target.id],
      awaitUntil: "all_finished",
    });
    const hiddenAwait = render(awaitDetails, { partial: true, panel: true });

    const startDetails = makeStartDetails({
      startEntries: [
        {
          index: 0,
          name: "Starting scout",
          profile: "scout",
          status: "pending",
          routeStatus: "resolving",
        },
      ],
    });
    const hiddenStart = render(startDetails, { partial: true, panel: true });

    const replayedAwait = render(awaitDetails, { panel: true });
    const replayedStart = render(startDetails, { panel: true });

    expect(hiddenAwait).toEqual([]);
    expect(hiddenStart).toEqual([]);
    expect(replayedAwait.length).toBeGreaterThan(0);
    expect(replayedStart.length).toBeGreaterThan(0);
  });

  it("keeps final reports collapsed and exposes owned report data when expanded", () => {
    const first = view({
      id: "report-a",
      name: "Report A",
      state: "completed",
      endedAt: 2,
      finalText: "First report body.",
      progress: "Stale completed progress.",
      warning: "Run warning retained.",
      writeIntent: "writer",
      writeClaims: ["src/report.ts"],
    });
    const second = view({
      id: "report-b",
      name: "Report B",
      state: "completed",
      closeOnReport: true,
      reportGeneration: 1,
      endedAt: 3,
      finalText: "Second report body.",
      progress: "Stale finished progress.",
    });
    const details = makeAwaitDetails({
      runs: [first, second],
      awaitedRunIds: [first.id, second.id],
      awaitUntil: "all_finished",
    });

    const collapsed = text(details, { width: 160 });
    const expanded = text(details, { expanded: true, width: 160 });

    expect(collapsed).not.toContain(first.finalText);
    expect(collapsed).not.toContain(second.finalText);
    expect(expanded).toContain(first.finalText);
    expect(expanded).toContain(second.finalText);
    expect(expanded).toContain(first.warning);
    expect(expanded).toContain("src/report.ts");
    expect(expanded).not.toContain(first.progress);
    expect(expanded).not.toContain(second.progress);
  });

  it("distinguishes interrupted await outcomes while preserving expanded run data", () => {
    const active = view({ id: "active", progress: "Still working." });
    const failure = view({
      id: "failure",
      state: "failed",
      endedAt: 3,
      error: "Failure body.",
    });
    const input = {
      runs: [active, failure],
      awaitedRunIds: [active.id, failure.id],
      awaitUntil: "all_finished" as const,
    };
    const summarize = (details: ReturnType<typeof makeAwaitDetails>) =>
      createSubagentCompactSummary("subagent_await")({
        phase: "settled",
        args: { runIds: input.awaitedRunIds, until: input.awaitUntil },
        result: { content: [], details },
        context: renderContextFixture(),
      });
    const signature = (details: ReturnType<typeof makeAwaitDetails>) => {
      const summary = summarize(details);
      return [summary?.outcome, ...(summary?.issues ?? []).map((issue) => issue.code)];
    };
    const ordinary = signature(makeAwaitDetails(input));

    for (const outcome of ["timedOut", "cancelled", "attentionRequired"] as const) {
      const details = makeAwaitDetails({ ...input, [outcome]: true });
      const expanded = text(details, { expanded: true });

      // The summary's issue lines tell the outcomes apart; the body keeps the run data.
      expect(signature(details)).not.toEqual(ordinary);
      expect(expanded).toContain(active.progress);
      expect(expanded).toContain(failure.error);
    }
  });

  it.each([20, 50, 100])("keeps list and await lines within width %i", (width) => {
    const list = render(makeCompactToolDetails({ action: "list", runs: [child, target] }), {
      width,
    });
    const awaitProgress = render(
      makeAwaitDetails({
        runs: [target],
        contextRuns: [child],
        awaitedRunIds: [target.id],
        awaitUntil: "all_finished",
      }),
      { partial: true, width },
    );
    expect([...list, ...awaitProgress].every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([1, 20, 50, 87, 120, 160])(
    "keeps one hierarchy row per run bounded at width %i",
    (width) => {
      const busyTarget = view({
        id: "agent-r1-15",
        name: "React DOM server trace plan",
        parentRunId: "root",
        depth: 1,
      });
      const busyChild = view({
        id: "agent-r1-16",
        name: "Codemirror optimization plan",
        parentRunId: busyTarget.id,
        depth: 2,
      });
      const details = makeAwaitDetails({
        runs: [busyTarget],
        contextRuns: [busyChild],
        awaitedRunIds: [busyTarget.id],
        awaitUntil: "all_finished",
      });
      const rows = renderResponsiveRunRows(details.cards, width, plainTheme, {
        hierarchy: { awaitedRunIds: new Set([busyTarget.id]) },
      });

      expect(rows).toHaveLength(details.cards.length);
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );

  it("reveals hidden start tasks only when expanded", () => {
    const agents = [
      { task: "Inspect the renderer.", name: "Renderer scout", profile: "scout" },
    ] as const;
    const collapsed = renderSubagentStartCall(agents, plainTheme, false).render(120).join("\n");
    const expanded = renderSubagentStartCall(agents, plainTheme, true).render(120).join("\n");

    expect(collapsed).not.toContain(agents[0].task);
    expect(expanded).toContain(agents[0].task);
  });

  it("reveals launch failure details only when expanded", () => {
    const failure = {
      index: 0,
      name: "Unavailable verification",
      code: "unavailable",
      message: "No route was available.",
    };
    const entry = {
      index: 0,
      name: failure.name,
      profile: "reviewer",
      status: "failed" as const,
      routeStatus: "unavailable" as const,
    };
    const collapsed = renderStartReceiptComponent([failure], [entry], false, plainTheme)
      .render(120)
      .join("\n");
    const expanded = renderStartReceiptComponent([failure], [entry], true, plainTheme)
      .render(120)
      .join("\n");

    expect(collapsed).not.toContain(failure.message);
    expect(expanded).toContain(failure.message);
  });

  it("preserves complete action-failure text in expanded results", () => {
    const message = `Failure prefix ${"detail ".repeat(15)}failure tail`;
    const details = makeCompactToolDetails({
      action: "stop",
      runs: [],
      actionFailures: [{ id: "agent-failed", code: "stop_failed", message }],
    });
    const collapsed = text(details, { width: 60 });
    const expanded = text(details, { expanded: true, width: 60 });

    expect(collapsed).not.toContain("failure tail");
    expect(expanded).toContain("failure tail");
  });

  it("preserves truncated fallback output in expanded results", () => {
    const text = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n");
    const collapsed = renderSubagentResult(
      { content: [{ type: "text", text }] },
      false,
      false,
      plainTheme,
    )
      .render(120)
      .join("\n");
    const expanded = renderSubagentResult(
      { content: [{ type: "text", text }] },
      false,
      true,
      plainTheme,
    )
      .render(120)
      .join("\n");

    expect(collapsed).not.toContain("line 13");
    expect(expanded).toContain("line 13");
  });
});
