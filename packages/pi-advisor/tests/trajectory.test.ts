import { describe, expect, test } from "vitest";
import {
  AdvisorToolTrajectoryDetector,
  AdvisorTrajectoryDetector,
} from "../src/review/trajectory.ts";

const repeatedParagraph =
  "I am reconsidering the same implementation approach while checking the identical constraints and reaching the same conclusion without taking a concrete action.";

describe("AdvisorTrajectoryDetector", () => {
  test("detects a long verbatim streamed repetition", () => {
    const detector = new AdvisorTrajectoryDetector();
    const unit = "repeat-this-unit";

    expect(detector.push("thinking", unit.repeat(12))).toMatchObject({
      channel: "thinking",
    });
  });

  test("detects a cluster of highly similar substantial segments", () => {
    const detector = new AdvisorTrajectoryDetector();
    let signal;
    for (let index = 0; index < 5; index += 1) {
      signal = detector.push(
        "thinking",
        `${repeatedParagraph} Iteration ${index} considers the same facts again.\n\n`,
      );
    }

    expect(signal).toMatchObject({ channel: "thinking" });
    expect(signal?.reason).toContain("near-duplicate");
  });

  test("does not flag varied concrete progress", () => {
    const detector = new AdvisorTrajectoryDetector();
    const segments = [
      "Inspecting src/config.ts revealed the normalization boundary and the exact default values used by the settings controller.",
      "The extension tests now show how turn_end is detached from the provider request and how stale generations are rejected.",
      "Implementing trajectory.ts adds a bounded stream detector while preserving session cleanup and model cancellation behavior.",
      "Running the focused Vitest suite verifies prompt modes, tool checkpoints, renderer actions, and timer cleanup independently.",
      "The final validation step checks TypeScript, lint, formatting, every package test, and the workspace build output.",
    ];

    for (const segment of segments) {
      expect(detector.push("text", `${segment}\n\n`)).toBeUndefined();
    }
  });

  test("keeps reasoning and visible prose histories separate and resets", () => {
    const detector = new AdvisorTrajectoryDetector();
    for (let index = 0; index < 3; index += 1) {
      expect(detector.push("thinking", `${repeatedParagraph}\n\n`)).toBeUndefined();
    }
    expect(detector.push("text", `${repeatedParagraph}\n\n`)).toBeUndefined();

    detector.reset();
    expect(detector.push("thinking", `${repeatedParagraph}\n\n`)).toBeUndefined();
  });
});

describe("AdvisorToolTrajectoryDetector", () => {
  const end = (
    detector: AdvisorToolTrajectoryDetector,
    id: string,
    args: unknown,
    result: unknown,
    isError = false,
    toolName = "read",
  ) => {
    detector.start(id);
    return detector.end({
      parentTurnId: 7,
      toolCallId: id,
      toolName,
      args,
      result,
      isError,
    });
  };

  test("detects repeated identical calls/results with bounded redacted evidence", () => {
    const detector = new AdvisorToolTrajectoryDetector();
    expect(
      end(detector, "1", { path: "src/a.ts", token: "sk-secretsecretsecret" }, "same"),
    ).toBeUndefined();
    expect(end(detector, "2", { token: "different", path: "src/a.ts" }, "same")).toBeUndefined();
    const signal = end(detector, "3", { path: "src/a.ts", token: "third" }, "same");
    expect(signal).toMatchObject({
      kind: "repeated-inspection",
      confidence: "strong",
      abortSafe: true,
    });
    expect(signal?.evidence.length).toBeLessThan(200);
    expect(signal?.evidence).not.toContain("secret");
  });

  test("detects repeated failures", () => {
    const detector = new AdvisorToolTrajectoryDetector();
    end(detector, "1", { path: "missing" }, "ENOENT", true);
    end(detector, "2", { path: "missing" }, "ENOENT", true);
    expect(end(detector, "3", { path: "missing" }, "ENOENT", true)).toMatchObject({
      kind: "repeated-error",
    });
  });

  test("detects A/B oscillation", () => {
    const detector = new AdvisorToolTrajectoryDetector();
    for (let index = 0; index < 5; index += 1) {
      const side = index % 2 === 0 ? "a" : "b";
      expect(end(detector, String(index), { path: side }, side)).toBeUndefined();
    }
    expect(end(detector, "5", { path: "b" }, "b")).toMatchObject({ kind: "oscillation" });
  });

  test("changed results and concrete progress reset suspicion", () => {
    const detector = new AdvisorToolTrajectoryDetector();
    end(detector, "1", { path: "a" }, "v1");
    end(detector, "2", { path: "a" }, "v2");
    expect(end(detector, "3", { path: "a" }, "v3")).toBeUndefined();
    end(detector, "4", { path: "a" }, "same");
    end(detector, "5", { path: "a" }, "same");
    detector.markConcreteProgress();
    expect(end(detector, "6", { path: "a" }, "same")).toBeUndefined();
  });

  test("recognizes novel successful terminal evidence only after a confirmed loop", () => {
    const detector = new AdvisorToolTrajectoryDetector();
    const input = {
      parentTurnId: 7,
      toolCallId: "novel",
      toolName: "read",
      args: { path: "new" },
      result: "new evidence",
      isError: false,
    };
    expect(detector.isMateriallyNovelTerminal(input)).toBe(false);
    end(detector, "1", { path: "a" }, "same");
    end(detector, "2", { path: "a" }, "same");
    end(detector, "3", { path: "a" }, "same");
    expect(detector.isMateriallyNovelTerminal(input)).toBe(true);
    detector.markConcreteProgress();
    expect(detector.isMateriallyNovelTerminal(input)).toBe(false);
  });

  test("an active concurrent tool makes abort unsafe until its matching terminal event", () => {
    const detector = new AdvisorToolTrajectoryDetector();
    end(detector, "1", { path: "a" }, "same");
    end(detector, "2", { path: "a" }, "same");
    detector.start("concurrent");
    detector.start("3");
    expect(
      detector.end({
        parentTurnId: 7,
        toolCallId: "3",
        toolName: "read",
        args: { path: "a" },
        result: "same",
        isError: false,
      }),
    ).toMatchObject({ abortSafe: false });
    expect(detector.activeToolCount).toBe(1);
    detector.end({
      parentTurnId: 7,
      toolCallId: "concurrent",
      toolName: "grep",
      args: { pattern: "x" },
      result: "new",
      isError: false,
    });
    expect(detector.activeToolCount).toBe(0);
  });
});
