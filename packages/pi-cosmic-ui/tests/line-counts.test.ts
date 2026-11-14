import { describe, expect, it } from "@effect/vitest";
import { paintLineCounts } from "../src/tool/presentation.ts";

// Tags each painted segment with its colour, so the test reads which colour each part takes.
const tagging = { fg: (color: string, text: string) => `<${color}>${text}</${color}>` };

const paint = (text: string) => paintLineCounts(tagging, text, "muted");

describe("paintLineCounts", () => {
  it("paints a pair's nonzero counts in the diff's colours and the rest in the base colour", () => {
    expect(paint("edit src/a.ts · +4 −2 lines")).toBe(
      "<muted>edit src/a.ts · </muted><toolDiffAdded>+4</toolDiffAdded><muted> </muted><toolDiffRemoved>−2</toolDiffRemoved><muted> lines</muted>",
    );
  });

  it("keeps a zero count in the base colour, so a pure addition shows one coloured number", () => {
    expect(paint("+12 −0")).toBe("<toolDiffAdded>+12</toolDiffAdded><muted> −0</muted>");
    expect(paint("+0 −3")).toBe("<muted>+0 </muted><toolDiffRemoved>−3</toolDiffRemoved>");
  });

  it("leaves text that holds no pair exactly as the base colour paints it", () => {
    for (const text of ["auth-review +1", "(+2 uncaptured)", "+4 -2", "3 files", ""])
      expect(paint(text)).toBe(tagging.fg("muted", text));
  });

  it("paints every pair in the text", () => {
    expect(paint("+3 −1 a.ts, +5 −0 b.ts")).toBe(
      "<toolDiffAdded>+3</toolDiffAdded><muted> </muted><toolDiffRemoved>−1</toolDiffRemoved><muted> a.ts, </muted><toolDiffAdded>+5</toolDiffAdded><muted> −0 b.ts</muted>",
    );
  });
});
