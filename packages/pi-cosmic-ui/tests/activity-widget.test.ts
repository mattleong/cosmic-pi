import { describe, expect, it } from "vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityWidgetSections, widgetFailuresExpire } from "../src/activity/widget-projection.ts";
import { activityRow, memberRow } from "./support/activity.ts";

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
