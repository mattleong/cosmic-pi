// Behavior-first component tests for the /subagents fleet: expandable hierarchy,
// selection identity across reorder, Esc detail → list → close, and pending action/prompt
// clearing on identity change. Assertions use transitions and callbacks, not exact chrome.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  SubagentFleetComponent,
  type FleetActions,
  type FleetKeybindingId,
} from "../src/ui/fleet.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used here.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id,
  name: id,
  task: "task",
  parentRunId: "root",
  depth: 1,
  selection: {
    source: "profile-candidate",
    reason: "Selected in configured order.",
    skippedCandidates: [],
  },
  cwd: "/tmp",
  state: "running",
  context: "fresh",
  writeIntent: "read-only",
  fastMode: false,
  host: "herdr",
  runtime: "claude",
  closeOnReport: false,
  reportGeneration: 0,
  capabilities: ["steer", "interrupt", "resume", "rename-display", "parent-contact"],
  model: "provider/model",
  effort: "high",
  startedAt: 1,
  lastActivityAt: 2,
  sessionEvents: [],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0 },
  ...overrides,
});

const makeFleet = (
  initial: ReadonlyArray<SubagentRunView>,
  height = 12,
  matchesKeybinding?: (data: string, id: FleetKeybindingId) => boolean,
) => {
  let runs = initial;
  const actions: FleetActions = {
    stop: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    message: vi.fn(() => Promise.resolve()),
    rename: vi.fn(() => Promise.resolve()),
  };
  const close = vi.fn();
  const component = new SubagentFleetComponent({
    theme,
    getProjection: () => ({ revision: 1, runs }),
    getHeight: () => height,
    getNow: () => 1_000,
    matchesKeybinding,
    requestRender: () => {},
    close,
    actions,
  });
  return {
    component,
    actions,
    close,
    setRuns: (next: ReadonlyArray<SubagentRunView>) => {
      runs = next;
    },
  };
};

const ESC = "\x1b";
const ENTER = "\r";
const LEFT = "\x1b[D";
const RIGHT = "\x1b[C";

describe("/subagents selection identity", () => {
  it("keeps the stop target pinned to the selected identity across reorder", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    component.handleInput("j");
    setRuns([run("beta"), run("alpha")]);
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledWith("beta");
  });

  it("targets a selected descendant rather than its rendered parent", () => {
    const { component, actions } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
    ]);
    component.handleInput("j");
    component.handleInput("x");
    component.handleInput("x");
    expect(actions.stop).toHaveBeenCalledWith("beta");
  });
});

describe("/subagents tree navigation", () => {
  it("renders descendants in one parent-before-child hierarchy by default", () => {
    const { component } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
      run("gamma"),
    ]);
    const rendered = component.render(120).join("\n");
    expect(rendered.indexOf("alpha")).toBeLessThan(rendered.indexOf("beta"));
    expect(rendered.indexOf("beta")).toBeLessThan(rendered.indexOf("gamma"));
  });

  it("collapses and expands the selected subtree with Left and Right", () => {
    const { component } = makeFleet([
      run("alpha"),
      run("beta", { parentRunId: "alpha", depth: 2 }),
      run("gamma", { parentRunId: "beta", depth: 3 }),
    ]);
    expect(component.render(120).join("\n")).toContain("gamma");

    component.handleInput(LEFT);
    expect(component.render(120).join("\n")).not.toContain("beta");
    component.handleInput(RIGHT);
    expect(component.render(120).join("\n")).toContain("gamma");
  });

  it.each(["h", LEFT])(
    "keeps the fixed tree key %j authoritative over configured selection bindings",
    (treeKey) => {
      const { component } = makeFleet(
        [run("alpha"), run("beta", { parentRunId: "alpha", depth: 2 })],
        12,
        (data, id) => data === treeKey && id === "tui.select.down",
      );
      component.handleInput(treeKey);
      expect(component.render(120).join("\n")).not.toContain("beta");
    },
  );

  it.each([50, 80, 120])(
    "uses Enter for inspection and Esc returns to the tree before closing at width %i",
    (width) => {
      const { component, close } = makeFleet([
        run("alpha"),
        run("beta", { parentRunId: "alpha", depth: 2 }),
      ]);
      component.render(width);
      component.handleInput(ENTER);
      component.handleInput(ESC);
      expect(close).not.toHaveBeenCalled();
      expect(component.render(width).join("\n")).toContain("beta");

      component.handleInput(ESC);
      expect(close).toHaveBeenCalledTimes(1);
    },
  );

  it("renders only descendants of a nested visibility root", () => {
    const root = run("alpha");
    const child = run("beta", { parentRunId: "alpha", depth: 2 });
    const grandchild = run("gamma", { parentRunId: "beta", depth: 3 });
    const outsider = run("outside");
    const runs = [root, child, grandchild, outsider];
    const component = new SubagentFleetComponent({
      theme,
      visibilityRootId: "alpha",
      getProjection: () => ({ revision: 1, runs }),
      getHeight: () => 12,
      getNow: () => 1_000,
      requestRender: () => {},
      close: vi.fn(),
      actions: {
        stop: vi.fn(() => Promise.resolve()),
        interrupt: vi.fn(() => Promise.resolve()),
        resume: vi.fn(() => Promise.resolve()),
        message: vi.fn(() => Promise.resolve()),
        rename: vi.fn(() => Promise.resolve()),
      },
    });
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("beta");
    expect(rendered).toContain("gamma");
    expect(rendered).not.toContain("alpha");
    expect(rendered).not.toContain("outside");
  });

  it("never renders the authenticated visibility root when malformed ancestry cycles to it", () => {
    const root = run("alpha", { parentRunId: "beta" });
    const child = run("beta", { parentRunId: "alpha", depth: 2 });
    const runs = [root, child];
    const component = new SubagentFleetComponent({
      theme,
      visibilityRootId: "alpha",
      getProjection: () => ({ revision: 1, runs }),
      getHeight: () => 12,
      getNow: () => 1_000,
      requestRender: () => {},
      close: vi.fn(),
      actions: {
        stop: vi.fn(() => Promise.resolve()),
        interrupt: vi.fn(() => Promise.resolve()),
        resume: vi.fn(() => Promise.resolve()),
        message: vi.fn(() => Promise.resolve()),
        rename: vi.fn(() => Promise.resolve()),
      },
    });
    const rendered = component.render(120).join("\n");
    expect(rendered).toContain("beta");
    expect(rendered).not.toContain("alpha");
  });
});

describe("/subagents pending state on identity change", () => {
  it("never stops a stale selection after the projection replaces the selected run", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    component.handleInput("x");
    setRuns([run("beta")]);
    component.handleInput("x");
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it("drops an open prompt when the selected run identity changes", () => {
    const { component, actions, setRuns } = makeFleet([run("alpha")]);
    component.handleInput("m");
    setRuns([run("other")]);
    component.handleInput(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
  });

  it("still submits a prompt for a stable selection", () => {
    const { component, actions } = makeFleet([run("alpha")]);
    component.handleInput("m");
    component.handleInput("h");
    component.handleInput("i");
    component.handleInput(ENTER);
    expect(actions.message).toHaveBeenCalledTimes(1);
    expect(actions.message).toHaveBeenCalledWith("alpha", "guidance", "hi");
  });
});
