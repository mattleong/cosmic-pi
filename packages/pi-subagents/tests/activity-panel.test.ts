import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import type { SubagentRunView, SubagentSessionEvent } from "../src/run/model.ts";
import {
  EMPTY_ACTIVITY_PRESENTATION,
  projectSubagentActivityPanel,
  RECENT_MESSAGE_WINDOW_MS,
  recentRunMessage,
  renderProjectedSubagentActivityPanel,
  runMessageCount,
} from "../src/ui/activity-panel.ts";
import { projectionOf, view } from "./fixtures/run-view.ts";

const render = (
  runs: ReadonlyArray<SubagentRunView>,
  live = EMPTY_ACTIVITY_PRESENTATION,
  width = 120,
) =>
  renderProjectedSubagentActivityPanel(
    projectSubagentActivityPanel(projectionOf(runs), live),
    width,
    plainTheme,
    10_001,
  );

const message = (
  direction: "in" | "out",
  peer: string,
  text: string,
  createdAt: number,
): SubagentSessionEvent => ({
  type: "notice",
  kind: "message",
  direction,
  peer,
  text,
  createdAt,
});

describe("persistent subagent activity panel", () => {
  it.each([8])("sanitizes hostile values and bounds every rendered line at width %i", (width) => {
    const hostile = view({
      id: "hostile",
      name: "bad\nname\u001b]8;;https://example.com\u0007link",
      profile: "scout",
      currentTool: "read\rtool\u001b[31msecret",
    });
    const lines = render([hostile], EMPTY_ACTIVITY_PRESENTATION, width);

    expect(
      lines.every(
        (line) =>
          !line.includes("\n") && !line.includes("https://example.com") && !line.includes("[31m"),
      ),
    ).toBe(true);
    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
  });

  it("shows a run's latest message only within the recent-message window", () => {
    const sentAt = 50_000;
    const pinger = view({
      id: "pinger",
      name: "pinger",
      currentTool: "read src/app.ts",
      lastActivityAt: sentAt,
      sessionEvents: [message("out", "ponger", "hello from pinger", sentAt)],
      messageCount: 1,
    });
    const ponger = view({ id: "ponger", name: "ponger-display" });
    const panel = projectSubagentActivityPanel(projectionOf([pinger, ponger]));

    const within = sentAt + RECENT_MESSAGE_WINDOW_MS - 1;
    expect(recentRunMessage(panel, pinger.id, within)).toMatchObject({
      direction: "out",
      peer: "ponger-display",
      text: "hello from pinger",
    });
    const recentLines = renderProjectedSubagentActivityPanel(panel, 120, plainTheme, within);
    expect(recentLines.some((line) => line.includes("hello from pinger"))).toBe(true);
    expect(recentLines.some((line) => line.includes("read src/app.ts"))).toBe(false);

    const after = sentAt + RECENT_MESSAGE_WINDOW_MS;
    expect(recentRunMessage(panel, pinger.id, after)).toBeUndefined();
    const laterLines = renderProjectedSubagentActivityPanel(panel, 120, plainTheme, after);
    expect(laterLines.some((line) => line.includes("hello from pinger"))).toBe(false);
    expect(laterLines.some((line) => line.includes("read src/app.ts"))).toBe(true);
  });

  it("labels the main agent and evicted peers without resolving them to runs", () => {
    const now = 10_000;
    const receiver = view({
      id: "receiver",
      sessionEvents: [message("in", "main", "check the schema", now)],
      messageCount: 1,
    });
    const sender = view({
      id: "sender",
      sessionEvents: [message("out", "agent-gone-9", "done", now)],
      messageCount: 1,
    });
    const panel = projectSubagentActivityPanel(projectionOf([receiver, sender]));

    expect(recentRunMessage(panel, receiver.id, now)).toMatchObject({
      direction: "in",
      peer: "main",
    });
    expect(recentRunMessage(panel, sender.id, now)?.peer).toBe("agent-gone-9");
  });

  it("counts every message a run sent or received, beyond retained session events", () => {
    const busy = view({
      id: "busy",
      sessionEvents: [message("in", "main", "latest", 1), message("out", "main", "reply", 2)],
      messageCount: 250,
    });
    const quiet = view({ id: "quiet" });
    const panel = projectSubagentActivityPanel(projectionOf([busy, quiet]));

    expect(runMessageCount(panel, busy.id)).toBe(250);
    expect(runMessageCount(panel, quiet.id)).toBe(0);
    expect(
      renderProjectedSubagentActivityPanel(panel, 120, plainTheme, 100_000).join("\n"),
    ).toContain("250");
  });

  it.each([40, 60, 120])("fits a long recent message into a %i-column row", (width) => {
    const now = 5_000;
    const text = `start-marker ${"payload ".repeat(80)}`;
    const run = view({
      id: "talker",
      name: "talker",
      sessionEvents: [message("out", "main", `${text}\u001b[31m\nsecond line`, now)],
      messageCount: 1,
    });
    const lines = renderProjectedSubagentActivityPanel(
      projectSubagentActivityPanel(projectionOf([run])),
      width,
      plainTheme,
      now,
    );

    expect(lines.every((line) => visibleWidth(line) <= width)).toBe(true);
    expect(lines.every((line) => !line.includes("\n") && !line.includes("[31m"))).toBe(true);
    if (width >= 60) expect(lines.some((line) => line.includes("start-marker"))).toBe(true);
  });
});
