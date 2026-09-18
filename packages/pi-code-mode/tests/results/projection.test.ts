import { describe, expect, it } from "@effect/vitest";
import { projectResultPage } from "../../src/results/projection.ts";
import type { ResultArtifact } from "../../src/results/model.ts";
import { utf8ByteLength } from "../../src/tools/limits.ts";

const artifact: ResultArtifact = {
  id: "cm-test",
  text: 'a😀é\n"\\'.repeat(100),
  outcome: "failed",
  kind: "output",
  cost: 0,
};
describe("retained output pages", () => {
  it("reconstructs Unicode text under exact total byte caps including JSON metadata", () => {
    let offset = 0;
    let text = "";
    for (let count = 0; count < 1000; count++) {
      const raw = projectResultPage(artifact, offset, 19, 200);
      expect(utf8ByteLength(raw)).toBeLessThanOrEqual(200);
      const page = JSON.parse(raw);
      expect(page.outcome).toBe("failed");
      expect(page.offset).toBe(offset);
      text += page.text;
      if (page.next === null) break;
      expect(page.next).toBeGreaterThan(offset);
      offset = page.next;
    }
    expect(text).toBe(artifact.text);
  });
  it("admits exact final-page fits when the null cursor shrinks metadata", () => {
    const large = { ...artifact, outcome: "succeeded" as const, text: "x".repeat(1_000_000) };
    const expected = projectResultPage(large, 999_999, 1, 1000);
    const exact = projectResultPage(large, 999_999, 1, utf8ByteLength(expected));
    expect(exact).toBe(expected);
    expect(JSON.parse(exact)).toMatchObject({ next: null, text: "x" });
  });
  it("rejects split and out-of-range offsets without rounding or stale cursors", () => {
    for (const offset of [-1, 2, 1.5, artifact.text.length + 1]) {
      expect(projectResultPage(artifact, offset, 20, 1000)).toContain("Invalid result offset");
    }
    expect(JSON.parse(projectResultPage(artifact, artifact.text.length, 20, 1000)).next).toBeNull();
  });
  it("never emits a nonadvancing cursor under tiny limits or budgets", () => {
    for (let budget = 0; budget < 180; budget++) {
      const raw = projectResultPage(artifact, 1, 1, budget);
      expect(utf8ByteLength(raw)).toBeLessThanOrEqual(budget);
      expect(raw).not.toContain('"next":1');
    }
    expect(projectResultPage(artifact, 0, 10, 0)).toBe("");
  });
});
