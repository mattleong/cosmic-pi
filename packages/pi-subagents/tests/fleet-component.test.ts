// Behavior-first component tests for the /subagents fleet: selection identity across
// reorder, Esc detail → list → close, the all-layout Enter policy, and pending
// action/prompt clearing on identity change. Assertions use transitions and callbacks,
// never exact copy, colors, or layout.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import type { SubagentRunView } from "../src/run/model.ts";
import { SubagentFleetComponent, type FleetActions } from "../src/ui/fleet.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used here.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView => ({
  id,
  name: id,
  task: "task",
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

const makeFleet = (initial: ReadonlyArray<SubagentRunView>, height = 12) => {
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
});

describe("/subagents Esc chain", () => {
  it("opens the detail pane on Enter in wide layouts and walks detail → list → close on Esc", () => {
    const { component, close } = makeFleet([run("alpha")]);
    component.render(120);
    component.handleInput(ENTER);
    component.handleInput(ESC);
    expect(close).not.toHaveBeenCalled();
    component.handleInput(ESC);
    expect(close).toHaveBeenCalledTimes(1);
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
