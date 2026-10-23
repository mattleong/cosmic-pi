import { initTheme } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import { describe, expect, it, vi } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { FullScreenSelectionKeybindingId } from "pi-cosmic-ui/manager/keymap";
import type { SubagentRunView } from "../src/run/model.ts";
import {
  SubagentFleetComponent,
  type FleetActions,
  type FleetMessageDelivery,
} from "../src/ui/fleet.ts";
import { view } from "./fixtures/run-view.ts";

const run = (id: string, overrides: Partial<SubagentRunView> = {}): SubagentRunView =>
  view({ id, name: id, parentRunId: "root", depth: 1, ...overrides });

const makeFleet = (
  initial: ReadonlyArray<SubagentRunView>,
  options: {
    readonly height?: number;
    readonly matchesKeybinding?: (data: string, id: FullScreenSelectionKeybindingId) => boolean;
    readonly isCurrent?: () => boolean;
  } = {},
) => {
  let runs = initial;
  let height = options.height ?? 12;
  const actions: FleetActions = {
    stop: vi.fn(() => Promise.resolve()),
    interrupt: vi.fn(() => Promise.resolve()),
    resume: vi.fn(() => Promise.resolve()),
    message: vi.fn((): Promise<FleetMessageDelivery> => Promise.resolve("delivered")),
    rename: vi.fn(() => Promise.resolve()),
  };
  const close = vi.fn();
  const component = new SubagentFleetComponent({
    theme: plainTheme,
    getProjection: () => ({ revision: 1, runs }),
    getHeight: () => height,
    getNow: () => 1_000,
    matchesKeybinding: options.matchesKeybinding,
    isCurrent: options.isCurrent,
    requestRender: () => {},
    close,
    actions,
  });
  return {
    component,
    press: (...keys: ReadonlyArray<string>) => {
      for (const key of keys) component.handleInput(key);
    },
    setHeight: (next: number) => {
      height = next;
    },
    actions,
    close,
    setRuns: (next: ReadonlyArray<SubagentRunView>) => {
      runs = next;
    },
  };
};

it("verifies recoverable terminal cleanup but does not automate manual quarantine", () => {
  for (const recovery of ["stop", "manual"] as const) {
    const member = run("cleanup-run", {
      state: "completed",
      finalText: "Accepted report sentinel",
      cleanup: {
        disposition: "quarantined",
        recovery,
        diagnostic: { phase: "process-group", message: "Diagnostic detail sentinel" },
      },
    });
    const { component, press, actions, setRuns } = makeFleet([member], { height: 40 });
    press("x", "x");
    expect(actions.stop).toHaveBeenCalledTimes(recovery === "stop" ? 1 : 0);
    setRuns([{ ...member, cleanup: { disposition: "confirmed" } }]);
    press("x", "x");
    expect(actions.stop).toHaveBeenCalledTimes(recovery === "stop" ? 1 : 0);
    component.dispose();
  }
});

const ESC = "\x1b";
const ENTER = "\r";

describe("/subagents selection identity", () => {
  it("keeps the stop target pinned to the selected identity across reorder", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    press("j");
    setRuns([run("beta"), run("alpha")]);
    press("x", "x");
    expect(actions.stop).toHaveBeenCalledTimes(1);
    expect(actions.stop).toHaveBeenCalledWith(
      "beta",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });
});

describe("/subagents pending state on identity change", () => {
  it("rejects a reply when a later question replaces the question being answered", () => {
    const before = run("alpha", {
      state: "waiting_for_parent",
      question: { requestId: "first", message: "Proceed?" },
    });
    const { press, actions, setRuns } = makeFleet([before]);
    press("m", "y", "e", "s");
    setRuns([{ ...before, question: { requestId: "second", message: "Proceed?" } }]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();
    press(ESC, "m", "n", "o", ENTER);
    expect(actions.message).toHaveBeenCalledWith(
      "alpha",
      "reply",
      "no",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });

  it("requires a new stop confirmation after an assignment rollover", () => {
    const before = run("alpha");
    const { press, actions, setRuns } = makeFleet([before]);
    press("x");
    setRuns([{ ...before, assignmentEpoch: before.assignmentEpoch + 1 }]);
    press(ENTER);
    expect(actions.stop).not.toHaveBeenCalled();
    press("x", ENTER);
    expect(actions.stop).toHaveBeenCalledWith(
      "alpha",
      expect.objectContaining({ assignmentEpoch: 2 }),
    );
  });

  it("refuses retained controls after the fleet has been disposed", () => {
    const { press, actions, component } = makeFleet([run("alpha")]);
    press("m", "h", "i");
    component.dispose();
    press(ENTER, "x", ENTER);
    expect(actions.message).not.toHaveBeenCalled();
    expect(actions.stop).not.toHaveBeenCalled();
  });

  it("closes a replaced activation before a pending action can execute", () => {
    let current = true;
    const { press, actions, close } = makeFleet([run("alpha")], { isCurrent: () => current });
    press("x");
    current = false;
    press(ENTER);
    expect(actions.stop).not.toHaveBeenCalled();
    expect(close).toHaveBeenCalledOnce();
  });

  it("never stops a stale selection after the projection replaces the selected run", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha"), run("beta")]);
    press("x");
    setRuns([run("beta")]);
    press("x");
    expect(actions.stop).not.toHaveBeenCalled();
  });
});

describe("/subagents unresolved guidance delivery", () => {
  for (const steeringDelivery of ["unresolved"] as const) {
    it(`blocks new guidance and interruption while delivery is ${steeringDelivery}`, () => {
      const { press, actions } = makeFleet([run("alpha", { steeringDelivery })]);
      press("m", "z", "z", ENTER, "h", "i");
      expect(actions.message).not.toHaveBeenCalled();
      expect(actions.interrupt).not.toHaveBeenCalled();

      press("x", "x");
      expect(actions.stop).toHaveBeenCalledWith(
        "alpha",
        expect.objectContaining({ assignmentEpoch: 1 }),
      );
    });
  }

  it("never sends a guidance prompt opened before delivery became pending", () => {
    const { press, actions, setRuns } = makeFleet([run("alpha")]);
    press("m", "h", "i");
    setRuns([run("alpha", { steeringDelivery: "pending" })]);
    press(ENTER);
    expect(actions.message).not.toHaveBeenCalled();

    setRuns([run("alpha", { steeringDelivery: "confirmed" })]);
    press(ENTER);
    expect(actions.message).toHaveBeenCalledTimes(1);
    expect(actions.message).toHaveBeenCalledWith(
      "alpha",
      "guidance",
      "hi",
      expect.objectContaining({ assignmentEpoch: 1 }),
    );
  });
});

const assistant = (text: string) => ({ type: "assistant" as const, text, createdAt: 1 });

it("renders the selected run's current task, messages, and report on every frame", () => {
  initTheme("dark", false);
  const member = run("alpha", {
    state: "completed",
    endedAt: 900,
    task: "Review **task one**",
    sessionEvents: [assistant("- interim one")],
    finalText: "## Report one",
  });
  const { component, setRuns } = makeFleet([member], { height: 40 });
  const frame = () => Arr.join(component.render(160), "\n");
  const first = frame();
  for (const text of ["task one", "interim one", "Report one"]) expect(first).toContain(text);
  expect(frame()).toBe(first);

  setRuns([
    {
      ...member,
      task: "Review **task two**",
      sessionEvents: [assistant("- interim two")],
      finalText: "## Report two",
    },
  ]);
  const next = frame();
  for (const text of ["task two", "interim two", "Report two"]) expect(next).toContain(text);
  for (const text of ["task one", "interim one", "Report one"]) expect(next).not.toContain(text);
  component.dispose();
});
