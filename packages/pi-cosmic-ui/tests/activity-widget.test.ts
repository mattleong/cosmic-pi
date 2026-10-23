import { describe, expect, it } from "vitest";
import * as Arr from "effect/Array";
import * as Option from "effect/Option";
import { renderActivityWidget } from "../src/activity/widget.ts";
import { activityWidgetSections } from "../src/activity/widget-projection.ts";
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
});
