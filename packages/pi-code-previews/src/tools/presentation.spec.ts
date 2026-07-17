import { expect, test } from "vitest";
import { testTheme } from "../testing/render";
import { ALL_CODE_PREVIEW_TOOLS } from "./names";
import { CODE_PREVIEW_TOOL_ICONS, renderCodePreviewToolTitle } from "./presentation";

test("code preview tools have distinct emoji titles", () => {
  expect(CODE_PREVIEW_TOOL_ICONS).toEqual({
    bash: "🔧",
    read: "📖",
    write: "✏️",
    edit: "✂️",
    grep: "🔎",
    find: "🎯",
    ls: "📂",
  });
  expect(new Set(Object.values(CODE_PREVIEW_TOOL_ICONS)).size).toBe(ALL_CODE_PREVIEW_TOOLS.length);

  for (const tool of ALL_CODE_PREVIEW_TOOLS)
    expect(renderCodePreviewToolTitle(tool, testTheme())).toBe(
      `${CODE_PREVIEW_TOOL_ICONS[tool]} ${tool}`,
    );
});
