import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityMark } from "../src/activity/row-line.ts";
import { activityStatus } from "../src/activity/attention.ts";
import { activityWidgetHeight, activityWidgetSections } from "../src/activity/widget-projection.ts";
import type { ActivityRow } from "../src/activity/model.ts";
import { SPINNER_FRAME_MS } from "../src/manager/chrome.ts";
import { activityRow, memberRow } from "./support/activity.ts";

const standalone = [
  activityRow("standalone-agent"),
  activityRow("standalone-task", "running", undefined, { kind: "command" }),
];
const parents = Array.from({ length: 20 }, (_, index) =>
  activityRow(`parent-${index}`, "running", undefined, { title: `Parent ${index}` }),
);
const children = parents.map((parent, index) => memberRow(`child-${index}`, parent));
const failures = (awaited: boolean) =>
  Array.from({ length: 12 }, (_, index) =>
    activityRow(`failed-${index}`, "failed", undefined, { awaited }),
  );
const expectParentsFirst = (sections: ReturnType<typeof activityWidgetSections>) => {
  const seen = new Set(sections.map((section) => section.heading.id));
  for (const entry of sections.flatMap((section) => section.entries)) {
    expect(seen.has(entry.id)).toBe(false);
    if (entry.parentId) expect(seen.has(entry.parentId)).toBe(true);
    seen.add(entry.id);
  }
};

describe("grouped activity widget", () => {
  it("grows for awaited failures within terminal bounds, without enlarging for archived ones", () => {
    const rows = [...failures(true), ...standalone];
    expect(activityWidgetHeight(rows, 60)).toBeGreaterThan(8);
    expect(activityWidgetHeight(rows, 20)).toBeLessThanOrEqual(10);
    expect(activityWidgetHeight([...failures(false), ...standalone], 60)).toBe(8);
  });
  it("never admits nested work without its owning ancestors", () => {
    const parent = activityRow("parent");
    const owner = memberRow("owner", parent);
    const child = activityRow("child", "running", owner.id);
    const task = activityRow("nested-task", "running", child.id, { kind: "command" });
    const loose = memberRow("loose", parent);
    const other = memberRow("other", parent);
    const rows = [task, other, child, owner, loose, parent, ...standalone];
    for (let budget = 1; budget <= 12; budget++) {
      const sections = activityWidgetSections(rows, budget);
      expectParentsFirst(sections);
      expect(renderActivityWidget(rows, 80, budget).length).toBeLessThanOrEqual(budget);
    }
    const full = activityWidgetSections(rows, 20)[0]!;
    expect(full.entries.find((entry) => entry.id === loose.key)?.parentId).toBe(parent.key);
  });
  it("spends the full fitting budget on work rows, not category headings", () => {
    for (const count of [1, 4]) {
      const parent = parents[0]!;
      const work = Array.from({ length: count }, (_, index) => memberRow(`work-${index}`, parent));
      const rows = [parent, ...work, ...standalone];
      const budget = rows.length;
      const sections = activityWidgetSections(rows, budget);
      expect(sections.every((section) => section.omittedRows === 0)).toBe(true);
      const rendered = renderActivityWidget(rows, 80, budget);
      expect(rendered).toHaveLength(budget);
      for (const row of rows) expect(rendered.some((line) => line.includes(row.title))).toBe(true);
    }
  });
  it("reserves task rows before spending the budget on crowded subagents", () => {
    const sections = activityWidgetSections([...parents, ...children, ...standalone], 8);
    expect(sections.map((section) => section.heading.section)).toEqual(["subagents", "tasks"]);
    const task = standalone[1]!;
    expect(
      sections.flatMap((section) => section.entries).some((entry) => entry.id === task.key),
    ).toBe(true);
    expect(sections[0]!.omittedRows).toBeGreaterThan(0);
    expect(
      sections.reduce(
        (sum, section) => sum + section.entries.length + Number(section.omittedRows > 0),
        0,
      ),
    ).toBeLessThanOrEqual(8);
  });
  it("preserves running and source-specific attention counts when collapsed and clipped", () => {
    const owner = children[0]!;
    const human = activityRow("human", "needs-input", owner.id, { kind: "question" });
    const parent = activityRow("parent", "needs-input", owner.id, {
      kind: "question",
      inputTarget: "parent",
    });
    const rows = [...parents, ...children, ...standalone, human, parent];
    for (const collapsed of [new Set<string>(), new Set([parents[0]!.key])]) {
      const sections = activityWidgetSections(rows, 8, { collapsed });
      expect(sections[0]!.heading.summary).toMatchObject({
        running: 41,
        attention: { user: 1, parent: 1, blocked: 0, failed: 0 },
      });
      expect(sections[0]!.omittedRows).toBeGreaterThan(0);
      const ids = sections.flatMap((section) => section.entries.map((entry) => entry.id));
      expect(new Set(ids).size).toBe(ids.length);
    }
  });
  it("keeps every attention count and omitted-work count in the rendered overview", () => {
    const crowd = activityRow("crowd");
    const work = Array.from({ length: 17 }, (_, i) => memberRow(`blocked-${i}`, crowd, "blocked"));
    const questions = (
      [
        ["user", 11],
        ["parent", 13],
      ] as const
    ).flatMap(([inputTarget, count]) =>
      Array.from({ length: count }, (_, i) =>
        activityRow(`${inputTarget}-${i}`, "needs-input", "blocked-0", {
          kind: "question",
          inputTarget,
        }),
      ),
    );
    const rows = [crowd, ...work, ...standalone, ...questions];
    for (const [width, height] of [
      [60, 1],
      [60, 2],
      [80, 1],
      [80, 2],
      [80, 8],
    ] as const) {
      const sections = activityWidgetSections(rows, height);
      const rendered = renderActivityWidget(rows, width, height);
      expect(rendered.length).toBeLessThanOrEqual(height);
      expect(rendered.every((line) => visibleWidth(line) <= width)).toBe(true);
      const hidden =
        height === 8
          ? sections[0]!.omittedRows
          : sections.reduce(
              (sum, section) => sum + section.omittedRows + section.entries.length,
              0,
            );
      const evidence = [11, 13, 17, hidden].map((count) => new RegExp(`\\b${count}\\b`, "u"));
      expect(
        rendered.some(
          (line) =>
            evidence.every((pattern) => pattern.test(line)) ||
            (/\b41\b/u.test(line) && new RegExp(`\\b${hidden}\\b`, "u").test(line)),
        ),
      ).toBe(true);
    }
  });
  it("animates a live parent and renders queued work as not yet started", () => {
    const parent = activityRow("parent", "running", undefined, { startedAt: 0 });
    const queued = memberRow("queued", parent, "pending");
    const starting = memberRow("starting", parent, "pending", { startedAt: 0 });
    const rows = [parent, queued];
    expect(renderActivityWidget(rows, 100, 8, { now: 0 })).not.toEqual(
      renderActivityWidget(rows, 100, 8, { now: SPINNER_FRAME_MS }),
    );
    expect(activityMark(queued, 0)).toEqual(activityMark(queued, SPINNER_FRAME_MS));
    expect(activityMark(starting, 0)).not.toEqual(activityMark(starting, SPINNER_FRAME_MS));
    expect(activityStatus(queued)).not.toBe(activityStatus(starting));
  });
  it("does not hide standalone queued questions or misclassify them as tasks", () => {
    const question = activityRow("queued", "pending", undefined, { kind: "question" });
    const sections = activityWidgetSections([question]);
    expect(sections.map((section) => section.heading.section)).toEqual(["attention"]);
    expect(sections[0]?.entries.map((entry) => entry.id)).toEqual([question.key]);
  });
  it("bounds every row across narrow sizes", () => {
    const question = activityRow("urgent", "needs-input", undefined, { kind: "question" });
    const rows: readonly ActivityRow[] = [...parents, ...children, ...standalone, question];
    for (const width of [0, 1, 2, 8, 21, 40, 80, 160])
      for (const maxRows of [0, 1, 2, 4, 8]) {
        const rendered = renderActivityWidget(rows, width, maxRows);
        expect(rendered.length).toBeLessThanOrEqual(maxRows);
        for (const line of rendered) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
      }
  });
});
