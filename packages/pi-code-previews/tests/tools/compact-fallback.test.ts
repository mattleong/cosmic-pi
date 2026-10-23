import assert from "node:assert/strict";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings, renderContextFixture } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { plainTheme } from "../support/render";
import * as Str from "effect/String";
import * as Arr from "effect/Array";

type Definition = ReturnType<typeof createReadToolDefinition>;
type Context = Parameters<NonNullable<Definition["renderCall"]>>[2];
type Result = Awaited<ReturnType<Definition["execute"]>>;
const result: Result = { content: [{ type: "text", text: "raw result" }], details: undefined };
const modes = ["on", "off", "border"] as const;
const count = (text: string, phrase: string) => Str.split(text, phrase).length - 1;

beforeEach(() =>
  applyPresentationSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
  }),
);

const context = (overrides: Partial<Context> = {}): Context =>
  renderContextFixture<Context["args"]>({
    args: { path: "file.ts" },
    argsComplete: false,
    isPartial: false,
    expanded: true,
    showImages: false,
    ...overrides,
  });

function paint(tool: Definition, ctx: Context, value = result) {
  const call = tool.renderCall!(ctx.args, plainTheme, ctx);
  const output = tool.renderResult!(
    value,
    { expanded: ctx.expanded, isPartial: ctx.isPartial },
    plainTheme,
    ctx,
  );
  const rows = [...call.render(100), ...output.render(100)];
  return { call, output, rows };
}

test("an expanded failed call renderer still shows the exact arguments, inertly", () => {
  for (const mode of modes) {
    const tool = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => {
          throw new Error("call renderer failure");
        },
        renderResult: () => new Text("BODY", 0, 0),
      },
      { mode, compactSummary: () => ({ subject: "file.ts", outcome: "success" }) },
    );
    const args = { path: "src/\u009b31mfile.ts", offset: 17, limit: 42 };
    const text = Arr.join(paint(tool, context({ args })).rows, "\n");
    for (const value of [/31mfile\.ts/u, /offset\D+17/u, /limit\D+42/u])
      assert.match(text, value, mode);
    assert.doesNotMatch(text, /\u009b/u);
    assert.match(text, /BODY/u);
  }
});

test("throwing result fallback retains hidden image indicators alongside text", () => {
  const tool = withCodePreviewShell(
    {
      ...createReadToolDefinition("/project"),
      renderResult() {
        throw new Error("temporary image renderer failure");
      },
    },
    { mode: "off", compactSummary: () => undefined },
  );
  const value: Result = {
    content: [
      { type: "text", text: "image context" },
      { type: "image", mimeType: "image/png", data: "" },
    ],
    details: undefined,
  };
  const text = Arr.join(paint(tool, context({ showImages: false }), value).rows, "\n");
  assert.match(text, /image context/u);
  assert.match(text, /image\/png/u);
});

test("render-time failures revoke component ownership before invalidation and reuse", () => {
  let fails = true;
  let inherited: Component | undefined;
  const definition: Definition = {
    ...createReadToolDefinition("/project"),
    renderResult(_value, _options, _theme, ctx) {
      inherited = ctx.lastComponent;
      if (!fails) return new Text("Recovered original result", 0, 0);
      return {
        render() {
          throw new Error("bad render");
        },
        invalidate() {
          throw new Error("bad invalidate");
        },
      };
    },
  };
  const tool = withCodePreviewShell(definition, {
    mode: "off",
    compactSummary: () => ({
      subject: "operation",
      outcome: "warning",
      issues: [{ severity: "warning", code: "cleanup", message: "Check cleanup" }],
    }),
  });
  const ctx = context();
  const failed = paint(tool, ctx);
  assert.equal(count(Arr.join(failed.rows, "\n"), "Check cleanup"), 1);
  assert.doesNotThrow(() => {
    failed.call.invalidate();
    failed.output.invalidate();
  });
  fails = false;
  assert.match(Arr.join(paint(tool, ctx).rows, "\n"), /raw result/u);
  ctx.args = { path: "repaired.ts" };
  assert.match(Arr.join(paint(tool, ctx).rows, "\n"), /Recovered original result/u);
  assert.equal(inherited, undefined);
});
