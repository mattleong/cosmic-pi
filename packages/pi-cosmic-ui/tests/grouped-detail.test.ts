import { describe, expect, it } from "vitest";
import { groupedDetail } from "../src/activity/grouped-detail.ts";
import { groupedActivityTree } from "../src/activity/grouped-tree.ts";
import { plainTheme } from "pi-cosmic-core/testing";
import { activityRow } from "./support/activity.ts";

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
});
