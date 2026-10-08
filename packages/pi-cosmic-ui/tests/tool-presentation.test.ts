import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderToolHeader } from "../src/tool/presentation.ts";

describe("tool presentation", () => {
  it("sanitizes and bounds tool header subtitles", () => {
    const header = renderToolHeader({ title: "tool\nname", subtitle: "x".repeat(400) }, plainTheme);
    expect(header).not.toContain("\n");
    expect(visibleWidth(header)).toBeLessThanOrEqual(visibleWidth("tool name ") + 160);
  });
});
