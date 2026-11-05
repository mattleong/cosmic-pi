import { describe, expect, it } from "vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { plainTheme } from "pi-cosmic-core/testing";
import { stripAnsi } from "pi-cosmic-core/security";
import { activityElapsed } from "../src/activity/row-line.ts";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityWidgetSections, widgetFailuresExpire } from "../src/activity/widget-projection.ts";
import { activityRow, memberRow, mountActivity } from "./support/activity.ts";

const standalone = [
  activityRow("standalone-agent"),
  activityRow("standalone-task", "running", undefined, { kind: "command" }),
];
const expectParentsFirst = (sections: ReturnType<typeof activityWidgetSections>) => {
  const seen = new Set(Arr.map(sections, (section) => section.heading.id));
  for (const entry of Arr.flatMap(sections, (section) => section.entries)) {
    expect(seen.has(entry.id)).toBe(false);
    if (entry.parentId) expect(seen.has(entry.parentId)).toBe(true);
    seen.add(entry.id);
  }
};

const question = (actions: ReadonlyArray<{ id: string; label: string }>) =>
  activityRow("deploy", "needs-input", undefined, {
    kind: "question",
    title: "Deploy",
    summary: "resume-hint",
    actions,
  });

describe("grouped activity widget", () => {
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
    expect(
      Option.getOrUndefined(Arr.findFirst(full.entries, (entry) => entry.id === loose.key))
        ?.parentId,
    ).toBe(parent.key);
  });

  it("keeps a recent failure visible after the live checklist drops it", () => {
    const live = activityRow("live", "running", undefined, { kind: "command" });
    const failed = activityRow("flaky", "failed", undefined, {
      kind: "command",
      title: "flaky build",
      endedAt: 80_000,
    });
    const recent = Arr.join(renderActivityWidget([live, failed], 80, 8, { now: 90_000 }), "\n");
    expect(recent).toContain("flaky build");
    const stale = Arr.join(renderActivityWidget([live, failed], 80, 8, { now: 3_600_000 }), "\n");
    expect(stale).not.toContain("flaky build");
  });

  it("repaints when a failure line expires even though nothing else changed", () => {
    const failed = activityRow("flaky", "failed", undefined, { kind: "command", endedAt: 0 });
    expect(widgetFailuresExpire([failed], 60_000, 120_000)).toBe(false);
    expect(widgetFailuresExpire([failed], 599_999, 600_001)).toBe(true);
    expect(widgetFailuresExpire([failed], 600_001, 601_000)).toBe(false);
  });

  it("leaves a questionnaire on screen to its dock and shows how to return to a hidden one", () => {
    const live = activityRow("live", "running", undefined, { kind: "command" });
    const open = question([{ id: "cancel", label: "Cancel" }]);
    const docked = Arr.join(
      renderActivityWidget([live, open], 80, 8, { inputDockVisible: true }),
      "\n",
    );
    expect(docked).not.toContain("Deploy");
    expect(Arr.join(renderActivityWidget([live, open], 80, 8), "\n")).toContain("Deploy");
    const hidden = question([
      { id: "resume", label: "Resume" },
      { id: "cancel", label: "Cancel" },
    ]);
    const lines = renderActivityWidget([live, hidden], 80, 8, { inputDockVisible: true });
    expect(Arr.filter(lines, Str.includes("Deploy"))).toHaveLength(1);
    expect(Arr.join(lines, "\n")).toContain("resume-hint");
  });
});

describe("agent identity at narrow widths", () => {
  const model = "claude-bridge/claude-sonnet-5-5";
  const parent = activityRow("audit", "running", undefined, {
    title: "Audit the payment retry pipeline",
    profile: "researcher",
    model,
    modelDetail: "medium",
    startedAt: 0,
  });
  const child = memberRow("lead", parent, "running", {
    title: "Compare idempotency keys",
    profile: "researcher",
    model,
    startedAt: 0,
  });
  const leaf = activityRow("leaf", "running", child.id, {
    title: "Trace webhook replays",
    profile: "planner",
    model,
    startedAt: 0,
  });
  const rows = [parent, child, leaf];

  it("keeps the whole provider/model in the widget at phone width", () => {
    const lines = Arr.map(
      renderActivityWidget(rows, 57, 8, { now: 90_000, theme: plainTheme }),
      stripAnsi,
    );
    expect(Arr.filter(lines, Str.includes(model))).toHaveLength(3);
  });

  it("keeps the whole provider/model and elapsed time in the manager at phone and wide widths", () => {
    for (const width of [57, 100, 140]) {
      const { component } = mountActivity(() => rows, { height: 16 });
      const screen = Arr.map(component.render(width), stripAnsi);
      expect(Arr.filter(screen, Str.includes(model))).toHaveLength(3);
      for (const title of ["Audit", "Compare", "Trace"])
        expect(
          Arr.some(screen, (line) => Str.includes(title)(line) && /\d+m?s? *│/u.test(line)),
        ).toBe(true);
    }
  });
});

describe("waiting rows at narrow widths", () => {
  const parent = activityRow("fanout", "running", undefined, {
    title: "Ad-hoc fan-out",
    profile: "planner",
    model: "claude-bridge/claude-opus-5-5",
    startedAt: 0,
  });
  const waiting = memberRow("asking", parent, "needs-input", {
    title: "Choose a library",
    profile: "researcher",
    model: "claude-bridge/claude-sonnet-5-5",
    startedAt: 10_000,
    inputTarget: "parent",
  });

  it("keeps a waiting row's elapsed time in the widget at phone width", () => {
    for (const width of [57, 80, 120]) {
      const lines = Arr.map(
        renderActivityWidget([parent, waiting], width, 8, { now: 90_000, theme: plainTheme }),
        stripAnsi,
      );
      const row = Arr.findFirst(lines, Str.includes("Choose a lib"));
      expect(Option.getOrElse(row, () => "")).toMatch(/\d+m(?: \d+s)?$/u);
    }
  });

  it("wraps the preview's facts between whole facts, never after a separator", () => {
    for (const width of [72, 90, 100, 120, 160]) {
      const { component } = mountActivity(() => [parent, waiting], { height: 16 });
      component.handleInput("j");
      const panes = Arr.map(component.render(width), (line) => stripAnsi(line));
      for (const line of panes) expect(line).not.toMatch(/ [·→] *│ *$/u);
    }
  });
});

describe("elapsed time", () => {
  const now = Date.UTC(2026, 10, 4);

  it("shows plausible spans and omits spans from a missing start, a skewed clock, or beyond a week", () => {
    const at = (startedAt: number) =>
      activityElapsed(activityRow("work", "running", undefined, { startedAt }), now);
    expect(at(now - 90_000)).not.toBe("");
    expect(at(1)).toBe("");
    expect(at(now + 5_000)).toBe("");
    expect(at(now - 8 * 24 * 60 * 60 * 1_000)).toBe("");
  });
});
