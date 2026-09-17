import { expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { managerTable } from "../src/manager/table.ts";
import { managerTabs } from "../src/manager/chrome.ts";

it("measures the whole dataset with display widths independent of visible rows", () => {
  const rows = [
    ["短", "ready"],
    ["longer identity", "failed"],
  ];
  const table = managerTable(
    rows,
    [
      { minWidth: 4, priority: 2 },
      { minWidth: 5, priority: 1 },
    ],
    30,
  );
  const first = table.row(rows[0]!);
  const last = table.row(rows[1]!);
  expect(visibleWidth(first.slice(0, first.indexOf("ready")))).toBe(
    visibleWidth(last.slice(0, last.indexOf("failed"))),
  );
  expect(table.row(rows[0]!)).toBe(first);
  expect(visibleWidth(table.row(["\x1b[31m短\x1b[0m", "ready"]))).toBe(visibleWidth(first));
});

it("keeps higher-priority columns when shrinking and restores omitted data when growing", () => {
  const rows = [["identity", "global", "failed"]];
  const columns = [
    { minWidth: 8, priority: 3 },
    { minWidth: 6, priority: 1 },
    { minWidth: 6, priority: 2 },
  ];
  for (const width of [0, 1, 8, 16, 30]) {
    const line = managerTable(rows, columns, width).row(rows[0]!);
    expect(visibleWidth(line)).toBeLessThanOrEqual(width);
    if (width >= 16) expect(line).toContain("failed");
    if (width === 16) expect(line).not.toContain("global");
    if (width === 30) expect(line).toContain("global");
  }
});

it("keeps the active saved tab reachable on narrow screens", () => {
  expect(managerTabs(["Current Session", "Saved profiles"], 1, 20)).toContain("Saved profiles");
  expect(managerTabs(["Current Session", "Saved profiles"], 1, 60)).toContain("Current Session");
});
