import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { schedule } from "../../eval/schedule.ts";

// Recorded before extracting the offline planner. These include arm order and cohort identity.
const frozenPlans = [
  ["adoption", 24, "c0f599466f36b95d0c3d554280b5bb75ecd5853c61d38768176306d0bd1f96a4"],
  ["output", 24, "016bbaa47f687eb44111ef5094cd799b0ddca8aebab387199c3a36195f2683f2"],
  ["wording", 24, "6e1c32eac5e71e2b10305f9b07f7787582d8535fcccf4374d617c0b801e9f0c8"],
  ["wording", 48, "031a0a47a1bc997599e7569e2788dd2647e4649c4e9be99cba42e88332c6014c"],
  ["formatter", 24, "d7ec54b459abcafca77231b615e135ddc4d42fbf4302976edbfbcb23c3ac9854"],
  ["formatter", 48, "5ec204730d5fd58a51639374b4a482dcb57a15155d9515689be4c77af415606c"],
] as const;

describe("offline schedules", () => {
  it("preserves frozen identities and ordering for archived and supported cohorts", () => {
    for (const [experiment, cap, expected] of frozenPlans) {
      const plan = schedule(experiment, cap).map(({ task, variant, repetition }) => ({
        task: task.id,
        split: task.split,
        eligible: task.eligible,
        variant,
        repetition,
      }));
      expect(createHash("sha256").update(JSON.stringify(plan)).digest("hex")).toBe(expected);
    }
  });
});
