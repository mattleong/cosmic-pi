// Behavior-first component tests for the /ps manager: two-press stop, stale-selection
// safety, sticky unfollow, narrow-only Enter policy, and selection reconciliation.
// Assertions use transitions, callbacks, and coarse content markers — never exact
// copy, colors, or layout.
import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "@effect/vitest";
import type { BackgroundJobView, BackgroundLogEvent } from "../src/job/model.ts";
import { ProcessManagerComponent } from "../src/ui/manager.ts";

// SAFETY: This locally constructed test fixture satisfies the declared contract used here.
const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as Theme;

const logEvents = (count: number): BackgroundLogEvent[] =>
  Array.from({ length: count }, (_, index) => ({
    cursor: index + 1,
    stream: "stdout",
    text: `line-${index + 1}\n`,
    timestamp: 0,
    bytes: 1,
  }));

const job = (id: string, overrides: Partial<BackgroundJobView> = {}): BackgroundJobView => ({
  id,
  name: id,
  command: `${id}-command`,
  cwd: "/tmp",
  state: "running",
  startedAt: 0,
  logCursor: 0,
  droppedLogBytes: 0,
  logs: [],
  ...overrides,
});

const makeManager = (initial: ReadonlyArray<BackgroundJobView>, height = 8) => {
  let jobs = initial;
  const stop = vi.fn();
  const clear = vi.fn();
  const close = vi.fn();
  const component = new ProcessManagerComponent({
    theme,
    getProjection: () => ({ jobs }),
    getHeight: () => height,
    getNow: () => 1_000,
    requestRender: () => {},
    close,
    stop,
    clear,
  });
  return {
    component,
    stop,
    clear,
    close,
    setJobs: (next: ReadonlyArray<BackgroundJobView>) => {
      jobs = next;
    },
  };
};

const ESC = "\x1b";
const ENTER = "\r";

describe("/ps stop confirmation", () => {
  it("stops a job only on the second x press", () => {
    const { component, stop } = makeManager([job("a")]);
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledWith("a");
  });

  it("cancels a pending stop on Esc without closing the manager", () => {
    const { component, stop, close } = makeManager([job("a")]);
    component.handleInput("x");
    component.handleInput(ESC);
    expect(stop).not.toHaveBeenCalled();
    expect(close).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
    component.handleInput("x");
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("never stops a stale selection after the projection replaces the selected job", () => {
    const { component, stop, setJobs } = makeManager([job("a"), job("b")]);
    component.handleInput("x");
    setJobs([job("b")]);
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
  });

  it("drops a pending stop when the selected job leaves an active state", () => {
    const { component, stop, setJobs } = makeManager([job("a")]);
    component.handleInput("x");
    setJobs([job("a", { state: "exited", endedAt: 5 })]);
    component.handleInput("x");
    expect(stop).not.toHaveBeenCalled();
  });
});

describe("/ps follow", () => {
  it("keeps the viewed slice sticky after unfollow and returns to the newest on refollow", () => {
    const { component, setJobs } = makeManager([job("a", { logs: logEvents(20) })]);
    expect(component.render(120).join("\n")).toContain("line-20");

    component.handleInput("f");
    setJobs([job("a", { logs: logEvents(25) })]);
    const anchored = component.render(120).join("\n");
    expect(anchored).toContain("line-20");
    expect(anchored).not.toContain("line-25");

    component.handleInput("f");
    expect(component.render(120).join("\n")).toContain("line-25");
  });
});

describe("/ps narrow layout", () => {
  it("opens the inspector on Enter, returns on Esc, and closes on the next Esc", () => {
    const { component, close } = makeManager([job("a", { logs: logEvents(3) })]);
    expect(component.render(50).join("\n")).not.toContain("line-3");

    component.handleInput(ENTER);
    expect(component.render(50).join("\n")).toContain("line-3");

    component.handleInput(ESC);
    expect(close).not.toHaveBeenCalled();
    expect(component.render(50).join("\n")).not.toContain("line-3");

    component.handleInput(ESC);
    expect(close).toHaveBeenCalledTimes(1);
  });

  it("keeps Enter inert outside the narrow layout while pane focus still uses h/l", () => {
    const focus = makeManager([job("a")]);
    focus.component.render(120);
    focus.component.handleInput("l");
    focus.component.handleInput(ESC);
    expect(focus.close).not.toHaveBeenCalled();

    const inert = makeManager([job("a")]);
    inert.component.render(120);
    inert.component.handleInput(ENTER);
    inert.component.handleInput(ESC);
    expect(inert.close).toHaveBeenCalledTimes(1);
  });
});
