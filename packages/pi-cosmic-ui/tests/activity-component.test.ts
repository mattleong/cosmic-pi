import { describe, expect, it } from "@effect/vitest";
import * as Arr from "effect/Array";
import type { ActivityRow } from "../src/activity/model.ts";
import { activityRow, memberRow, mountActivity } from "./support/activity.ts";
import { activitySectionId } from "../src/activity/grouped-tree.ts";
import type { ActivityActionRequest } from "../src/activity/service.ts";

describe("activity presentation", () => {
  it("accepts only the latest detail refresh even for the same revision", () => {
    const { component, loads } = mountActivity(() => [activityRow("work")], { height: 16 });
    component.render(120);
    component.handleInput("\r");
    loads[0]!.deliver("baseline-log");
    component.handleInput("r");
    component.handleInput("r");
    loads[1]!.deliver("obsolete-log");
    expect(Arr.join(component.render(120), "\n")).toContain("baseline-log");
    loads[2]!.deliver("latest-log");
    loads[1]!.deliver("obsolete-log");
    const text = Arr.join(component.render(120), "\n");
    expect(text).toContain("latest-log");
    expect(text).not.toContain("obsolete-log");
  });
  it("keeps selection identity when live rows reorder and dispatches only explicit actions", () => {
    let rows = [
      activityRow("a"),
      { ...activityRow("b"), actions: [{ id: "open", label: "Open" }] },
    ];
    const { component, closed } = mountActivity(() => rows);
    component.render(80);
    component.handleInput("j");
    rows = [rows[1]!, rows[0]!];
    component.render(80);
    expect(component.shell.state.selectedId).toBe(activityRow("b").key);
    component.handleInput("1");
    expect(closed[0]).toMatchObject({ key: activityRow("b").key, revision: "1", actionId: "open" });
  });
  it("dispatches the displayed capability rather than a changed action occupying its key", () => {
    let current = { ...activityRow("a"), actions: [{ id: "open", label: "Open" }] };
    const { component, closed } = mountActivity(() => [current]);
    component.render(80);
    current = { ...current, revision: "2", actions: [{ id: "stop", label: "Stop" }] };
    component.handleInput("1");
    expect(closed[0]).toMatchObject({ revision: "1", actionId: "open" });
  });
  it("requires a separate confirmation and retains the displayed destructive scope", () => {
    const stop = {
      id: "stop",
      label: "Stop branch",
      confirmation: "Stop this branch and its two descendants?",
      handoff: false,
    };
    let current = { ...activityRow("a"), actions: [stop] };
    const invoked: ActivityActionRequest[] = [];
    const { component, closed } = mountActivity(() => [current], {
      matchesKeybinding: (data, id) => data === "accept" && id === "tui.select.confirm",
      invoke: (request) => {
        invoked.push(request);
      },
    });
    component.render(80);
    component.handleInput("1");
    component.handleInput("1");
    expect(invoked).toEqual([]);
    current = { ...current, revision: "2", summary: "still running" };
    component.handleInput("accept");
    expect(invoked[0]).toMatchObject({ revision: "2", actionId: "stop" });
    component.render(80);
    component.handleInput("1");
    current = {
      ...current,
      revision: "3",
      actions: [{ ...stop, confirmation: "Stop this branch and its three descendants?" }],
    };
    component.handleInput("accept");
    expect(invoked[1]).toMatchObject({ revision: "2", actionId: "stop" });
    expect(closed).toEqual([]);
  });
});

// A task parent keeps nested subagents out of the subagents section, so initial
// section selection has to reveal them rather than pick the parent.
const reviewParent = (overrides: Partial<ActivityRow> = {}) =>
  activityRow("review", "running", undefined, { kind: "command", ...overrides });
const mountGrouped = (
  snapshot: () => readonly ActivityRow[],
  options: Parameters<typeof mountActivity>[1] = {},
) => mountActivity(snapshot, { height: 24, ...options });

describe("grouped activity interaction", () => {
  it("reveals urgent owned questions across collapsed parent and section headings", () => {
    const parent = reviewParent();
    const findMember = memberRow("owner", parent);
    const human = activityRow("human", "needs-input", findMember.id, { kind: "question" });
    const { component } = mountGrouped(() => [parent, findMember, human]);
    component.render(120);
    component.presentation.collapsed.add(parent.key);
    component.presentation.collapsed.add(activitySectionId("tasks"));
    component.handleInput("w");
    expect(component.shell.state.selectedId).toBe(human.key);
    expect(component.presentation.collapsed.has(parent.key)).toBe(false);
    expect(component.presentation.collapsed.has(activitySectionId("tasks"))).toBe(false);
  });
  it("cancels source loads when selection moves to the parent and never revives a stale callback", () => {
    const parent = reviewParent();
    const member = memberRow("member", parent);
    const { component, loads, cancels } = mountGrouped(() => [parent, member], {
      initialSection: "subagents",
    });
    component.render(120);
    component.handleInput("\r");
    component.handleInput("f");
    component.handleInput("h");
    component.handleInput("h");
    expect(cancels()).toBeGreaterThan(0);
    expect(component.shell.state.selectedId).toBe(parent.key);
    component.handleInput("j");
    loads[1]!.deliver("revoked-log");
    expect(Arr.join(component.render(120), "\n")).not.toContain("revoked-log");
    component.handleInput("q");
    loads[0]!.deliver("closed-log");
    expect(Arr.join(component.render(120), "\n")).not.toContain("closed-log");
  });
  it("never dispatches an old source generation after provider replacement", () => {
    let row = activityRow("same", "running", undefined, {
      actions: [{ id: "stop", label: "Stop" }],
    });
    const { component, closed } = mountGrouped(() => [row], { initialSection: "subagents" });
    component.render(120);
    row = { ...row, generation: 2 };
    component.handleInput("x");
    component.handleInput("1");
    expect(closed).toEqual([]);
    component.render(120);
    component.handleInput("x");
    expect(closed[0]).toMatchObject({ generation: 2 });
  });
  it("keeps retained member evidence non-executable even if it still advertises actions", () => {
    const parent = reviewParent({ status: "done" });
    const row = {
      ...memberRow("old", parent, "done", { actions: [{ id: "clear", label: "Clear" }] }),
      retained: true as const,
    };
    const { component, closed, loads } = mountGrouped(() => [parent, row], {
      initialSection: "subagents",
    });
    component.render(120);
    expect(component.shell.state.selectedId).toBe(row.key);
    for (const key of ["\r", "1", "c", "r", "f"]) component.handleInput(key);
    expect(loads).toEqual([]);
    expect(closed).toEqual([]);
  });
});
