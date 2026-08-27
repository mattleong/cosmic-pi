import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { makeAwaitDetails, makeCompactToolDetails } from "../../src/tools/details.ts";
import { renderSubagentResult } from "../../src/tools/render.ts";
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
});
