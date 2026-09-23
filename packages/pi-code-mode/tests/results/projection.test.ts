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
      const projected = projectResultPage(artifact, offset, 19, 200);
      const raw = projected.text;
      expect(utf8ByteLength(raw)).toBeLessThanOrEqual(200);
      const page = JSON.parse(raw);
      expect(page.outcome).toBe("failed");
      expect(page.offset).toBe(offset);
      expect(projected.presentation).toEqual({
        status: "page",
        id: page.id,
        originalOutcome: page.outcome,
        offset: page.offset,
        end: page.offset + page.text.length,
        next: page.next,
        total: page.total,
      });
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
    const exact = projectResultPage(large, 999_999, 1, utf8ByteLength(expected.text));
    expect(exact).toEqual(expected);
    expect(JSON.parse(exact.text)).toMatchObject({ next: null, text: "x" });
  });
  it("rejects split and out-of-range offsets without rounding or stale cursors", () => {
    for (const offset of [-1, 2, 1.5, artifact.text.length + 1]) {
      const projected = projectResultPage(artifact, offset, 20, 1000);
      expect(projected.text).toContain("Invalid result offset");
      expect(projected.presentation).toEqual({ status: "error", code: "invalid-offset" });
    }
    expect(
      JSON.parse(projectResultPage(artifact, artifact.text.length, 20, 1000).text).next,
    ).toBeNull();
  });
  it("never emits a nonadvancing cursor under tiny limits or budgets", () => {
    for (let budget = 0; budget < 180; budget++) {
      const raw = projectResultPage(artifact, 1, 1, budget).text;
      expect(utf8ByteLength(raw)).toBeLessThanOrEqual(budget);
      expect(raw).not.toContain('"next":1');
    }
    expect(projectResultPage(artifact, 0, 10, 0).text).toBe("");
  });

  it("returns either a complete escaped JSON envelope or a truthful cursor-free fallback", () => {
    const escaped = {
      ...artifact,
      outcome: "succeeded" as const,
      text: '\u0000"\\😀tail',
    };
    for (let budget = 0; budget <= 320; budget++) {
      const projected = projectResultPage(escaped, 0, escaped.text.length, budget, {
        includeRecovery: true,
        receipts: { total: 4, completed: 4 },
      });
      expect(utf8ByteLength(projected.text)).toBeLessThanOrEqual(budget);
      if (projected.presentation.status === "page") {
        const page = JSON.parse(projected.text);
        expect(page.offset).toBe(0);
        expect(page.text.length).toBeGreaterThan(0);
        expect(page.receipts).toEqual({ total: 4, completed: 4 });
        if (page.next !== null)
          expect(page.recovery).toEqual({
            action: "result.read",
            id: escaped.id,
            offset: page.next,
          });
      } else {
        expect(projected.presentation).toEqual({ status: "error", code: "page-budget" });
        expect(projected.text).not.toContain('"next"');
      }
    }
  });

  it("preserves the EOF endpoint check when continuation recovery makes prefixes larger", () => {
    const escaped = { ...artifact, outcome: "succeeded" as const, text: "😀" };
    const expected = projectResultPage(escaped, 0, escaped.text.length, 1_000, {
      includeRecovery: true,
      receipts: { total: 1, completed: 1 },
    });
    const exact = projectResultPage(
      escaped,
      0,
      escaped.text.length,
      utf8ByteLength(expected.text),
      {
        includeRecovery: true,
        receipts: { total: 1, completed: 1 },
      },
    );
    expect(exact).toEqual(expected);
    expect(JSON.parse(exact.text)).toMatchObject({ next: null, text: "😀" });
  });
});
