import { describe, expect, it } from "@effect/vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import { plainTheme } from "pi-cosmic-core/testing";
import { managerArrangement, managerDensity } from "../src/manager/chrome.ts";
import {
  framedBodyWithPrompt,
  framedFill,
  listDetailFrame,
} from "../src/manager/list-detail-shell.ts";
import { activityRow, mountActivity } from "./support/activity.ts";

const DESKTOP = { width: 180, height: 56 };
const PHONE = { width: 57, height: 46 };
const SHORT_PHONE = { width: 57, height: 20 };

const previewed = (size: { readonly width: number; readonly height: number }) => {
  const rows = [
    activityRow("ticker", "running", undefined, { kind: "command" }),
    activityRow("flaky", "failed", undefined, { kind: "command", endedAt: 1 }),
  ];
  const mounted = mountActivity(() => rows, { height: size.height });
  mounted.loads.at(-1)!.deliver("tick 42");
  const screen = () => Arr.join(mounted.component.render(size.width), "\n");
  return { ...mounted, screen };
};

describe("pane arrangement", () => {
  it("arranges panes by width and height while row density follows width alone", () => {
    expect(managerArrangement(DESKTOP.width, DESKTOP.height)).toBe("columns");
    expect(managerArrangement(80, 12)).toBe("stacked");
    expect(managerArrangement(PHONE.width, PHONE.height)).toBe("stacked");
    expect(managerArrangement(SHORT_PHONE.width, SHORT_PHONE.height)).toBe("single");
    expect(managerDensity(PHONE.width)).toBe(managerDensity(SHORT_PHONE.width));
    expect(managerDensity(PHONE.width)).not.toBe(managerDensity(DESKTOP.width));
  });

  it("shows a tall narrow frame's list and preview together, and Enter keeps the list in view", () => {
    const { component, screen } = previewed(PHONE);
    expect(screen()).toContain("ticker");
    expect(screen()).toContain("tick 42");
    component.handleInput("\r");
    expect(component.shell.state.pane).toBe("detail");
    expect(screen()).toContain("flaky");
    expect(screen()).toContain("tick 42");
  });

  it("keeps one pane at a time in a short narrow frame", () => {
    const { component, screen } = previewed(SHORT_PHONE);
    expect(screen()).toContain("ticker");
    expect(screen()).not.toContain("tick 42");
    component.handleInput("\r");
    expect(screen()).toContain("tick 42");
    expect(screen()).not.toContain("flaky");
  });

  it("keeps a selected row in view when narrow rows wrap in a stacked list", () => {
    const long = "a long task title that needs room";
    const rows = Arr.makeBy(30, (index) =>
      activityRow(`task-${index}`, "running", undefined, {
        kind: "agent",
        title: `${long} ${index}`,
        profile: "reviewer",
        model: "claude-bridge/claude-opus-5-5",
      }),
    );
    const { component } = mountActivity(() => rows, { height: PHONE.height });
    for (let step = 0; step < 20; step++) component.handleInput("j");
    const lines = component.render(PHONE.width);
    expect(lines).toHaveLength(PHONE.height);
    expect(Arr.join(lines, "\n")).toContain(`${long} 20`);
    for (const line of lines) expect(visibleWidth(line)).toBeLessThanOrEqual(PHONE.width);
  });
});

describe("prompt band", () => {
  const stop = {
    id: "stop",
    label: "Stop",
    confirmation: 'Stop "ticker" and its process tree?',
    handoff: false,
  };

  it("keeps the list and preview in view above a pending confirmation", () => {
    for (const size of [DESKTOP, PHONE]) {
      const row = activityRow("ticker", "running", undefined, {
        kind: "command",
        actions: [stop],
      });
      const { component, loads } = mountActivity(() => [row], { height: size.height });
      loads.at(-1)!.deliver("tick 42");
      component.render(size.width);
      component.handleInput("x");
      const screen = Arr.join(component.render(size.width), "\n");
      expect(screen).toContain(stop.confirmation);
      expect(screen).toContain("ticker");
      expect(screen).toContain("tick 42");
      component.handleInput("\u001b");
      expect(Arr.join(component.render(size.width), "\n")).not.toContain(stop.confirmation);
    }
  });

  it("gives the prompt the whole body when the frame is too short for both", () => {
    const frame = listDetailFrame(plainTheme);
    const body = (height: number) => framedFill(frame, ["context"], height, 40);
    const prompt = "Stop the selected task and every process it started?";
    const roomy = framedBodyWithPrompt(frame, { height: 10, inner: 40, prompt }, body);
    expect(roomy).toHaveLength(10);
    expect(Arr.join(roomy, "\n")).toContain("context");
    expect(Arr.join(roomy, "\n")).toContain("process it started?");
    const short = framedBodyWithPrompt(frame, { height: 2, inner: 40, prompt }, body);
    expect(short).toHaveLength(2);
    expect(Arr.join(short, "\n")).not.toContain("context");
    expect(Arr.join(short, "\n")).toContain("Stop the selected task");
  });
});
