import { describe, expect, test } from "vitest";
import { AdvisorTrajectoryDetector } from "../src/trajectory.ts";

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
