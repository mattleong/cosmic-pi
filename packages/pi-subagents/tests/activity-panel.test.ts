import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  EMPTY_ACTIVITY_PRESENTATION,
  projectSubagentActivityPanel,
  renderProjectedSubagentActivityPanel,
} from "../src/ui/activity-panel.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";

const render = (
  runs: ReadonlyArray<SubagentRunView>,
  live = EMPTY_ACTIVITY_PRESENTATION,
  width = 120,
) =>
  renderProjectedSubagentActivityPanel(
    projectSubagentActivityPanel(projectionOf(runs), live),
    width,
    plainTheme,
    10_001,
  );

describe("persistent subagent activity panel", () => {
  it.each([8])("sanitizes hostile values and bounds every rendered line at width %i", (width) => {
    const hostile = view({
      id: "hostile",
      name: "bad\nname\u001b]8;;https://example.com\u0007link",
      profile: "scout",
      currentTool: "read\rtool\u001b[31msecret",
    });
    const lines = render([hostile], EMPTY_ACTIVITY_PRESENTATION, width);

    expect(
      lines.every(
        (line) =>
          !line.includes("\n") && !line.includes("https://example.com") && !line.includes("[31m"),
      ),
    ).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });
});
