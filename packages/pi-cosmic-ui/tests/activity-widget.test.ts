import { describe, expect, it } from "vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { plainTheme } from "pi-cosmic-core/testing";
import { stripAnsi } from "pi-cosmic-core/security";
import { freshActivityPresentation } from "../src/activity/component.ts";
import type { ActivityRow } from "../src/activity/model.ts";
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

const line = (lines: readonly string[], title: string) =>
  Option.getOrElse(Arr.findFirst(lines, Str.includes(title)), () => "");
const failedTask = (id: string) =>
  activityRow(id, "failed", undefined, { kind: "command", title: id, endedAt: 1_000 });

describe("state words beside a row's glyph", () => {
  const model = "openai-codex/gpt-6-sol";
  const lead = activityRow("lead", "running", undefined, {
    title: "Lead",
    profile: "planner",
    model,
    startedAt: 0,
  });
  const queued = memberRow("queued", lead, "pending", { title: "Password reset", model });
  const paused = memberRow("paused", lead, "paused", { title: "Auth review", model, startedAt: 0 });
  const failed = memberRow("failed", lead, "failed", {
    title: "Unit tests",
    model,
    startedAt: 0,
    endedAt: 28_000,
  });
  const blocked = memberRow("blocked", lead, "blocked", {
    title: "Writes",
    blockedReason: "file-access",
    startedAt: 0,
  });
  const asking = memberRow("asking", lead, "needs-input", {
    title: "Choose",
    inputTarget: "parent",
    startedAt: 0,
  });
  const rows = [lead, queued, paused, failed, blocked, asking];
  const surfaces = (width: number) => {
    const { component } = mountActivity(() => rows, { height: 16 });
    return {
      widget: Arr.map(
        renderActivityWidget(rows, width, 12, { now: 29_000, theme: plainTheme }),
        stripAnsi,
      ),
      // The list pane alone: a wide manager previews the selected parent's children beside it.
      manager: Arr.map(component.render(width), (rendered) =>
        Arr.join(Str.split(stripAnsi(rendered), "│").slice(0, 2), "│"),
      ),
    };
  };

  it("leaves out the state its glyph says and keeps a failed row's run time", () => {
    for (const width of [57, 140]) {
      const { widget, manager } = surfaces(width);
      for (const lines of [widget, manager]) {
        expect(line(lines, "Password reset")).not.toMatch(/queued/u);
        expect(line(lines, "Auth review")).not.toMatch(/paused/u);
        expect(line(lines, "Unit tests")).not.toMatch(/failed/u);
      }
      expect(line(manager, "Unit tests")).toMatch(/28s/u);
    }
  });

  it("keeps the words of glyphs that don't say the state, and a folded branch's counts", () => {
    const { widget, manager } = surfaces(140);
    for (const lines of [widget, manager]) {
      expect(line(lines, "Writes")).toMatch(/waiting for file access/u);
      expect(line(lines, "Choose")).toMatch(/waiting for reply/u);
    }
    const presentation = freshActivityPresentation();
    presentation.collapsed.add(lead.key);
    const { component } = mountActivity(() => rows, { height: 16, presentation });
    expect(line(Arr.map(component.render(140), stripAnsi), "Lead")).toMatch(/1 failed/u);
  });

  it("names one hidden failure by its glyph and counts several", () => {
    const live = activityRow("live", "running", undefined, { kind: "command" });
    const banner = (failures: readonly ActivityRow[]) =>
      stripAnsi(renderActivityWidget([live, ...failures], 57, 2, { now: 2_000 }).at(-1) ?? "");
    expect(banner([failedTask("flaky build")])).toMatch(/^✗ flaky build · \/activity$/u);
    expect(banner([failedTask("one"), failedTask("two")])).toMatch(/2 failed/u);
  });

  it("drops a task's kind under the manager's Tasks heading and keeps it in the widget", () => {
    const task = activityRow("build", "running", undefined, {
      kind: "command",
      title: "Development server",
      startedAt: 0,
    });
    const manager = Arr.map(mountActivity(() => [task]).component.render(100), stripAnsi);
    expect(Arr.some(manager, Str.includes("Tasks"))).toBe(true);
    expect(line(manager, "Development server")).not.toMatch(/· task/u);
    const widget = Arr.map(renderActivityWidget([task], 100, 8, { now: 9_000 }), stripAnsi);
    expect(line(widget, "Development server")).toMatch(/· task/u);
  });
});
