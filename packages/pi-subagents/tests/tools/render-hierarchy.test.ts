import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { awaitDetails, compactToolDetails, startDetails } from "../../src/tools/details.ts";
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
  | ReturnType<typeof awaitDetails>
  | ReturnType<typeof compactToolDetails>
  | ReturnType<typeof startDetails>;
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
    const details = awaitDetails({
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
    const awaitCard = awaitDetails({
      runs: [target],
      contextRuns: [child],
      awaitedRunIds: [target.id],
      awaitUntil: "all_finished",
    });
    const hiddenAwait = render(awaitCard, { partial: true, panel: true });

    const startCard = startDetails({
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
    const hiddenStart = render(startCard, { partial: true, panel: true });

    const replayedAwait = render(awaitCard, { panel: true });
    const replayedStart = render(startCard, { panel: true });

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
    const details = awaitDetails({
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
    const summarize = (details: ReturnType<typeof awaitDetails>) =>
      createSubagentCompactSummary("subagent_await")({
        phase: "settled",
        args: { runIds: input.awaitedRunIds, until: input.awaitUntil },
        result: { content: [], details },
        context: renderContextFixture(),
      });
    const signature = (details: ReturnType<typeof awaitDetails>) => {
      const summary = summarize(details);
      return [summary?.outcome, ...(summary?.issues ?? []).map((issue) => issue.code)];
    };
    const ordinary = signature(awaitDetails(input));

    for (const outcome of ["cancelled", "attentionRequired"] as const) {
      const details = awaitDetails({ ...input, [outcome]: true });
      const expanded = text(details, { expanded: true });

      expect(signature(details)).not.toEqual(ordinary);
      expect(expanded).toContain(active.progress);
      expect(expanded).toContain(failure.error);
    }
  });

  it.each([20, 50, 100])("keeps list and await lines within width %i", (width) => {
    const list = render(compactToolDetails({ action: "list", runs: [child, target] }), {
      width,
    });
    const awaitProgress = render(
      awaitDetails({
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
      const details = awaitDetails({
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
    const receipt = { startEntries: [entry], startFailures: [failure] };
    const collapsed = renderStartReceiptComponent(receipt, false, plainTheme)
      .render(120)
      .join("\n");
    const expanded = renderStartReceiptComponent(receipt, true, plainTheme).render(120).join("\n");

    expect(collapsed).not.toContain(failure.message);
    expect(expanded).toContain(failure.message);
  });

  it("preserves complete action-failure text in expanded results", () => {
    const message = `Failure prefix ${"detail ".repeat(15)}failure tail`;
    const details = compactToolDetails({
      action: "stop",
      runs: [],
      actionFailures: [{ id: "agent-failed", code: "stop_failed", message }],
    });
    const collapsed = text(details, { width: 60 });
    const expanded = text(details, { expanded: true, width: 60 });

    expect(collapsed).not.toContain("failure tail");
    expect(expanded).toContain("failure tail");
  });

  it("lists pending delivery under its own expanded section, never under failed targets", () => {
    const lines = render(
      compactToolDetails({
        action: "send",
        runs: [],
        actionFailures: [
          {
            id: "pending-target",
            code: "steer_outcome_uncertain",
            message: "Acknowledgement is pending.",
            pendingDelivery: true,
          },
          { id: "failed-target", code: "not_running", message: "Not running." },
        ],
      }),
      { expanded: true },
    );
    const sectionOf = (id: string) => {
      const row = lines.findIndex((line) => line.includes(id));
      return lines.slice(0, row).findLast((line) => /^ {2}\S/u.test(line));
    };
    expect(sectionOf("pending-target")).not.toMatch(/fail/i);
    expect(sectionOf("failed-target")).toMatch(/fail/i);
  });

  it("preserves truncated fallback output in expanded results", () => {
    const output = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n");
    const collapsed = renderSubagentResult(
      { content: [{ type: "text", text: output }] },
      false,
      false,
      plainTheme,
    )
      .render(120)
      .join("\n");
    const expanded = renderSubagentResult(
      { content: [{ type: "text", text: output }] },
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
