import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { makeAwaitDetails, makeCompactToolDetails } from "../../src/tools/details.ts";
import { renderSubagentResult } from "../../src/tools/render.ts";
import { renderResponsiveRunRows } from "../../src/tools/render-run-rows.ts";
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

  it.each([20, 50, 73, 87])(
    "keeps each compact hierarchy run on one bounded line at width %i",
    (width) => {
      const busyTarget = view({
        id: "agent-r1-15",
        name: "React DOM server trace plan",
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
      expect(rows.every((line) => visibleWidth(line) <= width)).toBe(true);
    },
  );
});
