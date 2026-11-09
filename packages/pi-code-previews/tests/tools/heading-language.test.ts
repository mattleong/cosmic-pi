import { beforeEach, expect, test } from "vitest";
import { applyPresentationSettings, createToolPresentationHarness } from "../../testing";
import { detectPreviewLanguage } from "../../src/syntax/language";
import { builtinRenderers, previewBodiesDisabled, stripAnsi } from "../support/render";

beforeEach(() =>
  applyPresentationSettings({
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: "preview",
    toolCallBackground: "off",
    ...previewBodiesDisabled,
  }),
);

const heading = (name: "read" | "write", args: Record<string, string>) => {
  const harness = createToolPresentationHarness(builtinRenderers(name, true)!);
  harness.call(args);
  return stripAnsi(harness.render(120)[0] ?? "");
};

test("the language reports whether the path or only the content gave it", () => {
  expect(detectPreviewLanguage({ path: "src/a.ts" })).toEqual({
    language: "typescript",
    from: "path",
  });
  expect(detectPreviewLanguage({ path: ".env", content: "A=1" })?.from).toBe("path");
  expect(detectPreviewLanguage({ path: "bin/deploy", content: "#!/usr/bin/env bash\n" })).toEqual({
    language: "bash",
    from: "content",
  });
  expect(detectPreviewLanguage({ path: "fixture", content: '{"a":1}' })?.from).toBe("content");
});

test("a read or write heading names the language only when its path doesn't say it", () => {
  for (const name of ["read", "write"] as const) {
    const text = heading(name, { path: "src/a.ts", content: "export {};" });
    expect(text).toMatch(/src\/a\.ts/u);
    expect(text).not.toMatch(/typescript/u);
  }
  expect(heading("write", { path: ".env", content: "A=1" })).not.toMatch(/dotenv/u);
  // An extensionless script's language comes from its shebang, which the heading still names.
  const script = heading("write", { path: "bin/deploy", content: "#!/usr/bin/env bash\necho" });
  expect(script).toMatch(/bin\/deploy .*· bash/u);
});
