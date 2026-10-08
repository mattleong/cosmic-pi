import { describe, expect, it } from "vitest";
import { workflowMemberSpan } from "../src/activity/group-summary.ts";
import {
  activityRow,
  groupedDetailOf as detail,
  memberRow,
  workflowRow,
} from "./support/activity.ts";

const first = activityRow("first", "done", undefined, { startedAt: 100, endedAt: 300 });
const second = activityRow("second", "running", undefined, { startedAt: 200 });

describe("grouped activity detail", () => {
  it("shows the workflow row's own detail, actions and phase progress", () => {
    const workflow = workflowRow("workflow", ["Find", "Verify"], "running", "Verify", {
      startedAt: 0,
      detail: "published-detail",
      actions: [{ id: "stop", label: "Stop workflow" }],
    });
    const rows = [workflow, memberRow("finder", workflow, "Find", "done")];
    const text = detail(rows, (entry) => entry.type === "workflow", "loaded-detail");
    expect(text).toContain("loaded-detail");
    expect(text).not.toContain("published-detail");
    expect(text).toContain("Stop workflow");
    expect(text).toContain(workflow.id);
    expect(text).toContain("Verify");
  });
  it("shows phase guidance without source output or actions", () => {
    const workflow = workflowRow("workflow", [], "running", undefined, {
      phases: [{ title: "Find", detail: "Locate every caller" }],
      actions: [{ id: "stop", label: "Stop workflow" }],
    });
    const member = memberRow("finder", workflow, "Find", "running", {
      startedAt: 0,
      detail: "member-output",
    });
    const text = detail([workflow, member], (entry) => entry.type === "phase", "loaded-output");
    expect(text).toContain("Locate every caller");
    expect(text).not.toContain("loaded-output");
    expect(text).not.toContain("member-output");
    expect(text).not.toContain("Stop workflow");
  });
  it("spans parallel work without summing overlapping lifetimes", () => {
    expect(workflowMemberSpan([first, second], 500)).toBe(400);
    expect(workflowMemberSpan([first, second], 800)).toBe(700);
  });
  it("freezes at the last finished member rather than continuing to age", () => {
    const terminal = activityRow(second.id, "done", undefined, { startedAt: 200, endedAt: 400 });
    for (const now of [500, 10000, undefined])
      expect(workflowMemberSpan([first, terminal], now)).toBe(300);
  });
  it("ignores queued members and never invents elapsed time from missing timestamps", () => {
    const queued = activityRow("queued", "pending");
    expect(workflowMemberSpan([], 500)).toBeUndefined();
    expect(workflowMemberSpan([queued], 500)).toBeUndefined();
    expect(workflowMemberSpan([first, queued], 500)).toBe(200);
    expect(workflowMemberSpan([first, second], undefined)).toBeUndefined();
    expect(
      workflowMemberSpan(
        [first, activityRow(second.id, "done", undefined, { startedAt: 200 })],
        500,
      ),
    ).toBeUndefined();
  });
});
