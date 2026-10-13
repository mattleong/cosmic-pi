import { describe, expect, it } from "vitest";
import { groupedDetail } from "../src/activity/grouped-detail.ts";
import { groupedActivityTree } from "../src/activity/grouped-tree.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import { activityRow, groupedDetailOf as detail, memberRow } from "./support/activity.ts";

describe("grouped activity detail", () => {
  it("sanitizes technical identifiers for display without rewriting their identity", () => {
    const row = activityRow("item\u001b]52;c;payload\u0007", "running", undefined, {
      title: "Work",
      providerId: "provider\u001b[2J",
      revision: "revision\r\ntoken=private-value",
    });
    const text = groupedDetail({
      selected: groupedActivityTree([row]).find((entry) => entry.type === "member"),
      theme: plainTheme,
      focused: false,
      now: undefined,
      loaded: undefined,
      actionPage: 0,
      technical: true,
    });
    expect(text).not.toContain("\u001b");
    expect(text).not.toContain("\u0007");
    expect(text).not.toContain("\r");
    expect(text).not.toContain("private-value");
    expect(row.id).toBe("item\u001b]52;c;payload\u0007");
    expect(row.revision).toBe("revision\r\ntoken=private-value");
  });
  it("shows a parent row's loaded detail and actions instead of its published detail", () => {
    const parent = activityRow("parent", "running", undefined, {
      startedAt: 0,
      detail: "published-detail",
      actions: [{ id: "stop", label: "Stop agent" }],
    });
    const rows = [parent, memberRow("finder", parent, "done")];
    const text = detail(rows, (entry) => entry.id === parent.key, "loaded-detail");
    expect(text).toContain("loaded-detail");
    expect(text).not.toContain("published-detail");
    expect(text).toContain("Stop agent");
    expect(text).toContain(parent.id);
  });
});
