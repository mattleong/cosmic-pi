import { describe, expect, it } from "vitest";
import {
  COLLAPSED_BACKGROUND_LOG_LINES,
  selectBackgroundLogPreview,
} from "../src/ui/log-preview.ts";

const logText = (count: number) =>
  Array.from({ length: count }, (_, index) => `log line ${index + 1}`).join("\n");

describe("background log preview", () => {
  it("keeps short log output unchanged", () => {
    const text = "metadata\nready\n";
    expect(selectBackgroundLogPreview(text, false)).toEqual({
      text: "metadata\nready",
      shown: 2,
      hidden: 0,
      total: 2,
    });
  });

  it("shows a bounded head and tail while collapsed", () => {
    const preview = selectBackgroundLogPreview(logText(30), false);
    expect(preview.shown).toBe(COLLAPSED_BACKGROUND_LOG_LINES);
    expect(preview.hidden).toBe(18);
    expect(preview.total).toBe(30);
    expect(preview.text).toContain("log line 1");
    expect(preview.text).toContain("18 lines hidden");
    expect(preview.text).not.toContain("log line 15");
    expect(preview.text).toContain("log line 30");
  });

  it("shows all available output while expanded", () => {
    const text = logText(30);
    expect(selectBackgroundLogPreview(text, true)).toEqual({
      text,
      shown: 30,
      hidden: 0,
      total: 30,
    });
  });
});
