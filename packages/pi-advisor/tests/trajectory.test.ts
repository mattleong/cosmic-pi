import { describe, expect, test } from "vitest";
import {
  advisorActiveToolCount,
  emptyAdvisorToolTrajectoryDetector,
  emptyAdvisorTrajectoryDetector,
  endAdvisorToolTrajectory,
  isMateriallyNovelAdvisorTerminal,
  markConcreteAdvisorProgress,
  pushAdvisorTrajectory,
  startAdvisorToolTrajectory,
  type AdvisorToolTrajectoryDetectorState,
  type AdvisorTrajectoryDetectorState,
  type TrajectoryChannel,
  type TrajectorySignal,
  type ToolTrajectorySignal,
} from "../src/review/trajectory.ts";

const repeatedParagraph =
  "I am reconsidering the same implementation approach while checking the identical constraints and reaching the same conclusion without taking a concrete action.";

describe("advisor stream trajectory state", () => {
  const push = (
    state: AdvisorTrajectoryDetectorState,
    channel: TrajectoryChannel,
    delta: string,
  ): { state: AdvisorTrajectoryDetectorState; signal?: TrajectorySignal | undefined } =>
    pushAdvisorTrajectory(state, channel, delta);

  test("detects a long verbatim streamed repetition", () => {
    const unit = "repeat-this-unit";
    const result = push(emptyAdvisorTrajectoryDetector(), "thinking", unit.repeat(12));
    expect(result.signal).toMatchObject({ channel: "thinking" });
  });

  test("detects a cluster of highly similar substantial segments", () => {
    let state = emptyAdvisorTrajectoryDetector();
    let signal: TrajectorySignal | undefined;
    for (let index = 0; index < 5; index += 1) {
      const result = push(
        state,
        "thinking",
        `${repeatedParagraph} Iteration ${index} considers the same facts again.\n\n`,
      );
      state = result.state;
      signal = result.signal;
    }

    expect(signal).toMatchObject({ channel: "thinking" });
    expect(signal?.reason).toContain("near-duplicate");
  });

  test("does not flag varied concrete progress", () => {
    let state = emptyAdvisorTrajectoryDetector();
    const segments = [
      "Inspecting src/config.ts revealed the normalization boundary and the exact default values used by the settings controller.",
      "The extension tests now show how turn_end is detached from the provider request and how stale generations are rejected.",
      "Implementing trajectory.ts adds a bounded stream detector while preserving session cleanup and model cancellation behavior.",
      "Running the focused Vitest suite verifies prompt modes, tool checkpoints, renderer actions, and timer cleanup independently.",
      "The final validation step checks TypeScript, lint, formatting, every package test, and the workspace build output.",
    ];

    for (const segment of segments) {
      const result = push(state, "text", `${segment}\n\n`);
      state = result.state;
      expect(result.signal).toBeUndefined();
    }
  });

  test("keeps reasoning and visible prose histories separate and resets", () => {
    let state = emptyAdvisorTrajectoryDetector();
    for (let index = 0; index < 3; index += 1) {
      const result = push(state, "thinking", `${repeatedParagraph}\n\n`);
      state = result.state;
      expect(result.signal).toBeUndefined();
    }
    const text = push(state, "text", `${repeatedParagraph}\n\n`);
    state = text.state;
    expect(text.signal).toBeUndefined();

    // A fresh empty state is the reset; the prior history no longer contributes.
    const fresh = push(emptyAdvisorTrajectoryDetector(), "thinking", `${repeatedParagraph}\n\n`);
    expect(fresh.signal).toBeUndefined();
  });
});

describe("advisor tool trajectory state", () => {
  type ToolState = AdvisorToolTrajectoryDetectorState;
  const end = <Args, Result>(
    state: ToolState,
    id: string,
    args: Args,
    result: Result,
    isError = false,
    toolName = "read",
  ): { state: ToolState; signal?: ToolTrajectorySignal | undefined } =>
    endAdvisorToolTrajectory(startAdvisorToolTrajectory(state, id), {
      parentTurnId: 7,
      toolCallId: id,
      toolName,
      args,
      result,
      isError,
    });

  test("detects repeated identical calls/results with bounded redacted evidence", () => {
    let state = emptyAdvisorToolTrajectoryDetector();
    const first = end(state, "1", { path: "src/a.ts", token: "sk-secretsecretsecret" }, "same");
    state = first.state;
    expect(first.signal).toBeUndefined();
    const second = end(state, "2", { token: "different", path: "src/a.ts" }, "same");
    state = second.state;
    expect(second.signal).toBeUndefined();
    const third = end(state, "3", { path: "src/a.ts", token: "third" }, "same");
    expect(third.signal).toMatchObject({
      kind: "repeated-inspection",
      confidence: "strong",
      abortSafe: true,
    });
    expect(third.signal?.evidence.length).toBeLessThan(200);
    expect(third.signal?.evidence).not.toContain("secret");
  });

  test("detects repeated failures", () => {
    let state = emptyAdvisorToolTrajectoryDetector();
    state = end(state, "1", { path: "missing" }, "ENOENT", true).state;
    state = end(state, "2", { path: "missing" }, "ENOENT", true).state;
    expect(end(state, "3", { path: "missing" }, "ENOENT", true).signal).toMatchObject({
      kind: "repeated-error",
    });
  });

  test("detects A/B oscillation", () => {
    let state = emptyAdvisorToolTrajectoryDetector();
    for (let index = 0; index < 5; index += 1) {
      const side = index % 2 === 0 ? "a" : "b";
      const result = end(state, String(index), { path: side }, side);
      state = result.state;
      expect(result.signal).toBeUndefined();
    }
    expect(end(state, "5", { path: "b" }, "b").signal).toMatchObject({ kind: "oscillation" });
  });

  test("changed results and concrete progress reset suspicion", () => {
    let state = emptyAdvisorToolTrajectoryDetector();
    state = end(state, "1", { path: "a" }, "v1").state;
    state = end(state, "2", { path: "a" }, "v2").state;
    const varied = end(state, "3", { path: "a" }, "v3");
    state = varied.state;
    expect(varied.signal).toBeUndefined();
    state = end(state, "4", { path: "a" }, "same").state;
    state = end(state, "5", { path: "a" }, "same").state;
    state = markConcreteAdvisorProgress(state);
    expect(end(state, "6", { path: "a" }, "same").signal).toBeUndefined();
  });

  test("recognizes novel successful terminal evidence only after a confirmed loop", () => {
    let state = emptyAdvisorToolTrajectoryDetector();
    const input = {
      parentTurnId: 7,
      toolCallId: "novel",
      toolName: "read",
      args: { path: "new" },
      result: "new evidence",
      isError: false,
    };
    expect(isMateriallyNovelAdvisorTerminal(state, input)).toBe(false);
    state = end(state, "1", { path: "a" }, "same").state;
    state = end(state, "2", { path: "a" }, "same").state;
    state = end(state, "3", { path: "a" }, "same").state;
    expect(isMateriallyNovelAdvisorTerminal(state, input)).toBe(true);
    state = markConcreteAdvisorProgress(state);
    expect(isMateriallyNovelAdvisorTerminal(state, input)).toBe(false);
  });

  test("an active concurrent tool makes abort unsafe until its matching terminal event", () => {
    let state = emptyAdvisorToolTrajectoryDetector();
    state = end(state, "1", { path: "a" }, "same").state;
    state = end(state, "2", { path: "a" }, "same").state;
    state = startAdvisorToolTrajectory(state, "concurrent");
    state = startAdvisorToolTrajectory(state, "3");
    const looped = endAdvisorToolTrajectory(state, {
      parentTurnId: 7,
      toolCallId: "3",
      toolName: "read",
      args: { path: "a" },
      result: "same",
      isError: false,
    });
    state = looped.state;
    expect(looped.signal).toMatchObject({ abortSafe: false });
    expect(advisorActiveToolCount(state)).toBe(1);
    state = endAdvisorToolTrajectory(state, {
      parentTurnId: 7,
      toolCallId: "concurrent",
      toolName: "grep",
      args: { pattern: "x" },
      result: "new",
      isError: false,
    }).state;
    expect(advisorActiveToolCount(state)).toBe(0);
  });
});
