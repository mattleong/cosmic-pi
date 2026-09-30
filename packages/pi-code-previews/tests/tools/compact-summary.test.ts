import assert from "node:assert/strict";
import { test } from "vitest";
import {
  compactStatus,
  resolveCompactSummary,
  type CompactSummary,
} from "../../src/tools/compact-summary";

test("a returned outcome stays neutral until issues or Pi's error flag say otherwise", () => {
  const returned: CompactSummary = { subject: "docs / lookup", outcome: "returned" };
  assert.equal(compactStatus("settled", returned), "returned");
  assert.equal(compactStatus("running", returned), "running");
  assert.equal(
    compactStatus("settled", {
      ...returned,
      issues: [{ severity: "info", code: "more", message: "More resources are available" }],
    }),
    "returned",
  );
  assert.equal(
    compactStatus("settled", {
      ...returned,
      issues: [{ severity: "warning", code: "truncated", message: "Output is truncated" }],
    }),
    "warning",
  );
  assert.deepEqual(resolveCompactSummary(returned, "settled", false), returned);
  const failed = resolveCompactSummary(returned, "settled", true, "Error: connection reset");
  assert.equal(failed?.outcome, "error");
  assert.ok(failed && compactStatus("settled", failed) === "error");
  assert.ok(failed?.issues?.some((issue) => issue.severity === "error"));
});
