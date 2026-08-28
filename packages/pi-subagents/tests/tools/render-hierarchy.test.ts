import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { makeAwaitDetails, makeCompactToolDetails } from "../../src/tools/details.ts";
import { renderSubagentResult } from "../../src/tools/render.ts";
import { formatAwaitSummary } from "../../src/tools/render-await.ts";
import { renderResponsiveRunRows } from "../../src/tools/render-run-rows.ts";
import { renderStartReceiptComponent } from "../../src/tools/render-start.ts";
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
  it("uses the same one-line await summary and run rows before and after settlement", () => {
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

    expect(awaiting).toEqual(completed);
    expect(awaiting).toHaveLength(details.cards.length + 1);
    expect(awaiting[0]).toContain("1/1 finished");
    expect(awaiting[0]).toContain("30k tokens");
    expect(awaiting[0]).toContain("◎ targets");
    expect(awaiting.slice(1).every((line) => !line.includes("stopped"))).toBe(true);
    expect(awaiting.every((line) => !line.startsWith("Total usage"))).toBe(true);
  });

  it.each([
    [{ cancelled: true }, "Await canceled"],
    [{ timedOut: true }, "Await timed out"],
    [{ attentionRequired: true }, "parent reply required"],
  ] as const)("keeps the %s outcome in the one-line summary", (outcome, expected) => {
    const summary = formatAwaitSummary([target], "all_finished", "12k tokens", outcome);

    expect(summary).toContain(expected);
    expect(summary).toContain("0/1 finished");
    expect(summary).toContain("12k tokens");
    expect(summary).toContain("◎ targets");
    expect(summary).not.toContain("\n");
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
  ])("shows the $label route state on compact start receipts", ({ entry, expected }) => {
    const lines = renderStartReceiptComponent([], [entry], false, theme).render(44);
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
          fastMode: true,
          runId: "agent-r4-14",
        },
      ],
      false,
      theme,
    ).render(72);

    expect(lines.some((line) => line.includes("╰─ reviewer → local/pi"))).toBe(true);
    expect(lines.some((line) => line.includes("openai-codex/gpt-5.6-sol:xhigh ⚡"))).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= 72)).toBe(true);
  });
});
