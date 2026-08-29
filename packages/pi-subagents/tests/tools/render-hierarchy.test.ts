import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
  makeAwaitDetails,
  makeCompactToolDetails,
  makeStartDetails,
} from "../../src/tools/details.ts";
import { renderSubagentResult } from "../../src/tools/render.ts";
import { formatAwaitSummary } from "../../src/tools/render-await.ts";
import { renderResponsiveRunRows } from "../../src/tools/render-run-rows.ts";
import {
  renderStartReceiptComponent,
  renderSubagentStartCall,
} from "../../src/tools/render-start.ts";
import { view } from "./fixtures/tool-harness.ts";

// SAFETY: This fixture implements the Theme methods consumed by semantic result rendering.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const target = view({ id: "parent", name: "Hierarchy Parent", parentRunId: "root", depth: 1 });
const child = view({
  id: "child",
  name: "Hierarchy Child",
  parentRunId: target.id,
  depth: 2,
});

type HierarchyDetails =
  | ReturnType<typeof makeAwaitDetails>
  | ReturnType<typeof makeCompactToolDetails>;

const render = (details: HierarchyDetails, partial: boolean, width: number) =>
  renderSubagentResult({ content: [], details }, partial, false, theme).render(width);

describe("hierarchical tool result rendering", () => {
  it("keeps live fallback rows partial and settles to a compact durable summary", () => {
    const settledTarget = view({
      id: "settled-target",
      name: "Settled target",
      state: "stopped",
      endedAt: 2,
      usage: {
        input: 20_000,
        output: 10_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 30_000,
        cost: 0.002,
      },
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

    const awaiting = render(details, true, 160);
    const completed = render(details, false, 160);

    expect(awaiting).toHaveLength(details.cards.length + 1);
    expect(awaiting[0]).toContain("Waiting for subagents");
    expect(completed).toHaveLength(1);
    expect(completed[0]).toContain("✓ 1/1 finished");
    expect(completed[0]).toContain("30k tok");
    expect(completed[0]).toContain("1 descendant");
    expect(completed[0]).not.toContain("Waiting for subagents");
    expect(completed[0]).not.toContain("◎1 target");
    expect(awaiting[0]).toContain("1/1");
    expect(awaiting[0]).toContain("30k tok");
    expect(awaiting[0]).toContain("◎1 target");
    expect(awaiting[0]).toContain("1 descendant");
    expect(awaiting[0]).not.toContain("finished");
    expect(awaiting.slice(1).every((line) => !line.includes("stopped"))).toBe(true);
    expect(awaiting.every((line) => !line.startsWith("Total usage"))).toBe(true);

    const expanded = renderSubagentResult({ content: [], details }, false, true, theme).render(160);
    expect(expanded.join("\n")).toContain("Settled target");
    expect(expanded.join("\n")).toContain("Settled child");
  });

  it("omits partial start and await hierarchy when the persistent panel owns it", () => {
    const awaitDetails = makeAwaitDetails({
      runs: [target],
      contextRuns: [child],
      awaitedRunIds: [target.id],
      awaitUntil: "all_finished",
    });
    const hiddenAwait = renderSubagentResult(
      { content: [], details: awaitDetails },
      true,
      false,
      theme,
      { panelOwnsLiveHierarchy: true },
    ).render(120);

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
    const hiddenStart = renderSubagentResult(
      { content: [], details: startDetails },
      true,
      false,
      theme,
      { panelOwnsLiveHierarchy: true },
    ).render(120);

    const replayedAwait = renderSubagentResult(
      { content: [], details: awaitDetails },
      false,
      false,
      theme,
      { panelOwnsLiveHierarchy: true },
    ).render(120);
    const replayedStart = renderSubagentResult(
      { content: [], details: startDetails },
      false,
      false,
      theme,
      { panelOwnsLiveHierarchy: true },
    ).render(120);

    expect(hiddenAwait).toEqual([]);
    expect(hiddenStart).toEqual([]);
    expect(replayedAwait).not.toEqual([]);
    expect(replayedStart).not.toEqual([]);
  });

  it("uses an outcome-first settled wait-for-first summary", () => {
    const first = view({
      id: "first",
      name: "First scout",
      state: "completed",
      endedAt: 2,
    });
    const other = view({ id: "other", name: "Other scout", state: "running" });

    const summary = formatAwaitSummary([other, first], "any_finished", "12k tok", {
      settled: true,
      targetCount: 2,
    });

    expect(summary).toContain("✓ First scout finished first · 1/2");
    expect(summary).toContain("1 running");
    expect(summary).not.toContain("Waiting for first subagent");
    expect(summary).not.toContain("◎2 targets");
  });

  it.each([
    [{ cancelled: true }, "Await canceled"],
    [{ timedOut: true }, "Await timed out"],
    [{ attentionRequired: true }, "Parent reply required"],
  ] as const)("keeps the %s outcome in the one-line summary", (outcome, expected) => {
    const summary = formatAwaitSummary([target], "all_finished", "12k tok", outcome);

    expect(summary).toContain(expected);
    expect(summary).toContain("0/1");
    expect(summary).toContain("12k tok");
    expect(summary).toContain("◎1 target");
    expect(summary).not.toContain("finished");
    expect(summary).not.toContain("\n");
  });

  it("collapses completed report previews into one counted affordance", () => {
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
      selection: {
        source: "profile-candidate",
        reason: "Selected fallback candidate.",
        candidateIndex: 1,
        skippedCandidates: [
          {
            candidateIndex: 0,
            candidate: "local/pi/first-model",
            code: "unavailable",
            reason: "First candidate unavailable.",
          },
        ],
        warning: "Selection warning retained.",
      },
    });
    const second = view({
      id: "report-b",
      name: "Report B",
      state: "reported",
      closeOnReport: false,
      reportGeneration: 1,
      endedAt: 3,
      finalText: "Second report body.",
      progress: "Stale reported progress.",
    });
    const details = makeAwaitDetails({
      runs: [first, second],
      awaitedRunIds: [first.id, second.id],
      awaitUntil: "all_finished",
    });

    const collapsed = render(details, false, 160);
    const expanded = renderSubagentResult({ content: [], details }, false, true, theme).render(160);

    expect(
      collapsed.filter((line) => line.includes("▸ 2 final reports · ctrl+o to expand")),
    ).toHaveLength(1);
    expect(collapsed.join("\n")).not.toContain("First report body.");
    expect(collapsed.join("\n")).not.toContain("Second report body.");
    const expandedText = expanded.join("\n");
    expect(expandedText).toContain("1/2 · Report A");
    expect(expandedText).toContain("2/2 · Report B");
    expect(expandedText).toContain("First report body.");
    expect(expandedText).toContain("Second report body.");
    expect(expandedText).toContain("Run outcomes");
    expect(expandedText.indexOf("First report body.")).toBeLessThan(
      expandedText.indexOf("Run outcomes"),
    );
    expect(expandedText).toContain("Writer claims · src/report.ts");
    expect(expandedText).toContain("Run warning retained.");
    expect(expandedText).toContain("skipped local/pi/first-model");
    expect(expandedText).toContain("Selection warning retained.");
    expect(expandedText).toContain("retain backend · assignment 1");
    expect(expandedText).toContain("Report B is retained");
    expect(expandedText).not.toContain("Stale completed progress.");
    expect(expandedText).not.toContain("Stale reported progress.");
    expect(expandedText).not.toContain("ID:");
    expect(expandedText).not.toContain("context=");
    expect(expandedText).not.toContain("capabilities=");
    expect(expandedText).not.toContain("close after report");
    expect(expandedText).not.toContain("Report 1 of 2");
    expect(expandedText).not.toContain("ctrl+o to expand");
  });

  it("keeps active progress in expanded await cards", () => {
    const active = view({ id: "active", name: "Active", progress: "Still working." });
    const details = makeAwaitDetails({
      runs: [active],
      awaitedRunIds: [active.id],
      awaitUntil: "all_finished",
      timedOut: true,
    });
    const expanded = renderSubagentResult({ content: [], details }, false, true, theme).render(120);

    expect(expanded.join("\n")).toContain("Progress: Still working.");
  });

  it("retains routine diagnostics for expanded non-await cards", () => {
    const status = makeCompactToolDetails({ action: "status", runs: [target] });
    const expanded = renderSubagentResult(
      { content: [], details: status },
      false,
      true,
      theme,
    ).render(160);
    const text = expanded.join("\n");

    expect(text).toContain("ID: parent");
    expect(text).toContain("profile-candidate");
    expect(text).toContain("context=fresh");
    expect(text).toContain("close after report");
    expect(text).toContain("capabilities=");
  });

  it("keeps failure labels in shortened expanded section headings", () => {
    const report = view({
      id: "mixed-report",
      name: "Mixed report",
      state: "completed",
      endedAt: 2,
      finalText: "Report body.",
    });
    const failure = view({
      id: "mixed-failure",
      name: "Mixed failure",
      state: "failed",
      endedAt: 3,
      error: "Failure body.",
    });
    const details = makeAwaitDetails({
      runs: [report, failure],
      awaitedRunIds: [report.id, failure.id],
      awaitUntil: "all_finished",
    });
    const expanded = renderSubagentResult({ content: [], details }, false, true, theme).render(160);
    const text = expanded.join("\n");

    expect(text).toContain("1/2 · Mixed report");
    expect(text).toContain("Failure 2/2 · Mixed failure");
    expect(text).toContain("Report body.");
    expect(text).toContain("Failure body.");
  });

  it("counts targets and visible descendants in the compact await header", () => {
    const firstTarget = view({
      id: "target-a",
      name: "Target A",
      usage: {
        input: 60_000,
        output: 40_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 100_000,
        cost: 0.0091,
      },
    });
    const secondTarget = view({
      id: "target-b",
      name: "Target B",
      usage: {
        input: 30_000,
        output: 24_000,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 54_000,
      },
    });
    const descendants = [
      view({ id: "child-a1", name: "Child A1", parentRunId: firstTarget.id, depth: 2 }),
      view({ id: "child-a2", name: "Child A2", parentRunId: firstTarget.id, depth: 2 }),
      view({ id: "child-b1", name: "Child B1", parentRunId: secondTarget.id, depth: 2 }),
      view({ id: "child-b2", name: "Child B2", parentRunId: secondTarget.id, depth: 2 }),
    ];
    const details = makeAwaitDetails({
      runs: [firstTarget, secondTarget],
      contextRuns: descendants,
      awaitedRunIds: [firstTarget.id, secondTarget.id],
      awaitUntil: "all_finished",
    });
    const lines = render(details, true, 240);

    expect(lines[0]).toContain("0/2");
    expect(lines[0]).toContain("154k tok");
    expect(lines[0]).toContain("≥$0.0091");
    expect(lines[0]).toContain("◎2 targets");
    expect(lines[0]).toContain("4 descendants");
  });

  it.each([20, 50, 100])("keeps list and await lines within width %i", (width) => {
    const list = render(
      makeCompactToolDetails({ action: "list", runs: [child, target] }),
      false,
      width,
    );
    const awaitProgress = render(
      makeAwaitDetails({
        runs: [target],
        contextRuns: [child],
        awaitedRunIds: [target.id],
        awaitUntil: "all_finished",
      }),
      true,
      width,
    );
    expect([...list, ...awaitProgress].every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it.each([1, 20, 50, 87, 120, 160])(
    "keeps one hierarchy row per run bounded at width %i",
    (width) => {
      const busyTarget = view({
        id: "agent-r1-15",
        name: "React DOM server trace plan",
        profile: "reviewer",
        parentRunId: "root",
        depth: 1,
        usage: {
          input: 25_000,
          output: 25_000,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 50_000,
          cost: 0,
        },
      });
      const busyChild = view({
        id: "agent-r1-16",
        name: "Codemirror optimization plan",
        profile: "scout",
        parentRunId: busyTarget.id,
        depth: 2,
      });
      const details = makeAwaitDetails({
        runs: [busyTarget],
        contextRuns: [busyChild],
        awaitedRunIds: [busyTarget.id],
        awaitUntil: "all_finished",
      });
      const rows = renderResponsiveRunRows(details.cards, width, theme, {
        hierarchy: { awaitedRunIds: new Set([busyTarget.id]) },
      });

      expect(rows).toHaveLength(details.cards.length);
      expect(rows.every((line) => !line.includes("running"))).toBe(true);
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
      if (width >= 120) {
        expect(rows.some((line) => line.includes("reviewer → local/pi"))).toBe(true);
        expect(rows.some((line) => line.includes("openai-codex/gpt-5.6-sol:high"))).toBe(true);
      }
    },
  );

  it("preserves deep ancestor branches in narrow one-line rows", () => {
    const root = view({
      id: "root-run",
      name: "Root reviewer",
      profile: "reviewer",
      parentRunId: "root",
      depth: 1,
    });
    const child = view({
      id: "child-run",
      name: "Child planner",
      profile: "planner",
      parentRunId: root.id,
      depth: 2,
    });
    const grandchild = view({
      id: "grandchild-run",
      name: "Grandchild scout",
      profile: "scout",
      parentRunId: child.id,
      depth: 3,
    });
    const sibling = view({
      id: "sibling-run",
      name: "Sibling reviewer",
      profile: "reviewer",
      parentRunId: "root",
      depth: 1,
    });
    const details = makeCompactToolDetails({
      action: "list",
      runs: [grandchild, child, root, sibling],
    });
    if (details.action === "models") throw new Error("Expected list details.");
    const rows = renderResponsiveRunRows(details.cards, 20, theme, { hierarchy: {} });

    expect(rows).toHaveLength(details.cards.length);
    expect(rows.some((line) => line.startsWith("│"))).toBe(true);
    expect(rows.every((line) => visibleWidth(line) <= 20)).toBe(true);
  });

  it("retains every model character when a compact route wraps", () => {
    const run = view({ profile: "reviewer" });
    const details = makeCompactToolDetails({ action: "status", runs: [run] });
    if (details.action === "models") throw new Error("Expected status details.");
    const rows = renderResponsiveRunRows(details.cards, 20, theme);
    const route = rows
      .slice(1)
      .map((line) => (line.startsWith("  ╰─ ") || line.startsWith("     ") ? line.slice(5) : line))
      .join("");

    expect(route).toContain(run.model);
    expect(rows.every((line) => visibleWidth(line) <= 20)).toBe(true);
  });

  it("keeps a fitting selected model inline on wide rows", () => {
    const run = view({ profile: "reviewer" });
    const details = makeCompactToolDetails({ action: "status", runs: [run] });
    if (details.action === "models") throw new Error("Expected status details.");
    const rows = renderResponsiveRunRows(details.cards, 160, theme);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toContain("reviewer → local/pi · openai-codex/gpt-5.6-sol:high");
    expect(visibleWidth(rows[0] ?? "")).toBeLessThanOrEqual(160);
  });

  it("keeps a sole parent and child on one line each", () => {
    const parent = view({
      id: "only-parent",
      name: "Only parent",
      profile: "reviewer",
      parentRunId: "root",
      depth: 1,
    });
    const nested = view({
      id: "only-child",
      name: "Only child",
      profile: "scout",
      parentRunId: parent.id,
      depth: 2,
    });
    const details = makeCompactToolDetails({ action: "list", runs: [nested, parent] });
    if (details.action === "models") throw new Error("Expected list details.");
    const rows = renderResponsiveRunRows(details.cards, 80, theme, { hierarchy: {} });

    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatch(/^└── .*Only parent/);
    expect(rows[1]).toMatch(/^    └── .*Only child/);
    expect(rows.every((line) => !line.includes("running"))).toBe(true);
  });

  it("preserves ancestor branches across sibling rows", () => {
    const first = view({
      id: "first",
      name: "First reviewer",
      profile: "reviewer",
      parentRunId: "root",
      depth: 1,
    });
    const nested = view({
      id: "nested",
      name: "Nested scout",
      profile: "scout",
      parentRunId: first.id,
      depth: 2,
    });
    const second = view({
      id: "second",
      name: "Second reviewer",
      profile: "reviewer",
      parentRunId: "root",
      depth: 1,
    });
    const details = makeCompactToolDetails({ action: "list", runs: [nested, first, second] });
    if (details.action === "models") throw new Error("Expected list details.");
    const rows = renderResponsiveRunRows(details.cards, 80, theme, { hierarchy: {} });

    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatch(/^├── .*First reviewer/);
    expect(rows[1]).toMatch(/^│   └── .*Nested scout/);
    expect(rows[2]).toMatch(/^└── .*Second reviewer/);
  });

  it("advertises hidden start tasks with the shared expansion affordance", () => {
    const agents = [
      { task: "Inspect the renderer.", name: "Renderer scout", profile: "scout" },
    ] as const;
    const collapsed = renderSubagentStartCall(agents, theme, false).render(120).join("\n");
    const expanded = renderSubagentStartCall(agents, theme, true).render(120).join("\n");

    expect(collapsed).toContain("▸ tasks & launch details · ctrl+o to expand");
    expect(expanded).toContain("Task: Inspect the renderer.");
    expect(expanded).not.toContain("ctrl+o to expand");
  });

  it("keeps successful start receipts outcome-focused", () => {
    const collapsed = renderStartReceiptComponent(
      [],
      [
        {
          index: 0,
          name: "Successful scout",
          profile: "scout",
          status: "started",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-luna",
          effort: "medium",
          openaiFastMode: false,
          runId: "agent-r1-1",
        },
      ],
      false,
      theme,
    )
      .render(120)
      .join("\n");

    expect(collapsed).toContain("✓ 1 started");
    expect(collapsed).not.toContain("Started 1 subagent");
    expect(collapsed).not.toContain("launch details");
  });

  it("uses the shared expansion affordance for hidden launch failures", () => {
    const failure = {
      index: 0,
      name: "Unavailable verification",
      code: "unavailable",
      message: "No route was available.",
    };
    const entry = {
      index: 0,
      name: "Unavailable verification",
      profile: "reviewer",
      status: "failed" as const,
      routeStatus: "unavailable" as const,
    };
    const collapsed = renderStartReceiptComponent([failure], [entry], false, theme)
      .render(120)
      .join("\n");
    const expanded = renderStartReceiptComponent([failure], [entry], true, theme)
      .render(120)
      .join("\n");

    expect(collapsed).toContain("▸ launch details · ctrl+o to expand");
    expect(expanded).not.toContain("ctrl+o to expand");
  });

  it("marks truncated action-failure text as expandable", () => {
    const message = `Failure prefix ${"detail ".repeat(15)}failure tail`;
    const details = makeCompactToolDetails({
      action: "stop",
      runs: [],
      actionFailures: [{ id: "agent-failed", code: "stop_failed", message }],
    });
    const collapsed = renderSubagentResult({ content: [], details }, false, false, theme)
      .render(60)
      .join("\n");
    const expanded = renderSubagentResult({ content: [], details }, false, true, theme)
      .render(60)
      .join("\n");

    expect(collapsed).toContain("▸ failure text · ctrl+o to expand");
    expect(collapsed).not.toContain("failure tail");
    expect(expanded).toContain("failure tail");
    expect(expanded).not.toContain("ctrl+o to expand");
  });

  it("points truncated fallback output to ctrl+o", () => {
    const text = Array.from({ length: 13 }, (_, index) => `line ${index + 1}`).join("\n");
    const collapsed = renderSubagentResult(
      { content: [{ type: "text", text }] },
      false,
      false,
      theme,
    )
      .render(120)
      .join("\n");

    expect(collapsed).toContain("2 more lines · ctrl+o to expand");
    expect(collapsed).not.toContain("expand to view");
  });

  it.each([
    {
      label: "pending",
      entry: {
        index: 0,
        name: "Pending verification",
        profile: "reviewer",
        status: "pending" as const,
        routeStatus: "resolving" as const,
      },
      expected: "reviewer → resolving route/model",
    },
    {
      label: "unavailable",
      entry: {
        index: 0,
        name: "Unavailable verification",
        profile: "reviewer",
        status: "failed" as const,
        routeStatus: "unavailable" as const,
      },
      expected: "reviewer → no eligible route/model",
    },
  ])("shows the $label route state in expanded start receipts", ({ entry, expected }) => {
    const lines = renderStartReceiptComponent([], [entry], true, theme).render(44);
    expect(lines.some((line) => line.includes(expected))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 44)).toBe(true);
  });

  it("shows the selected model on a compact start receipt", () => {
    const lines = renderStartReceiptComponent(
      [],
      [
        {
          index: 0,
          name: "Fix verification",
          profile: "reviewer",
          status: "started",
          routeStatus: "selected",
          host: "local",
          runtime: "pi",
          model: "openai-codex/gpt-5.6-sol",
          effort: "xhigh",
          openaiFastMode: true,
          runId: "agent-r4-14",
        },
      ],
      true,
      theme,
    ).render(72);

    expect(lines.some((line) => line.includes("╰─ reviewer → local/pi"))).toBe(true);
    expect(lines.some((line) => line.includes("openai-codex/gpt-5.6-sol:xhigh ⚡"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });
});
