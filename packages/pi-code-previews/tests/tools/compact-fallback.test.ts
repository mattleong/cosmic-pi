import assert from "node:assert/strict";
import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { beforeEach, test } from "vitest";
import { applyPresentationSettings, renderContextFixture } from "../../testing";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import type { CompactIssue } from "../../src/tools/compact-issues";
import { plainTheme } from "../support/render";

type Definition = ReturnType<typeof createReadToolDefinition>;
type Context = Parameters<NonNullable<Definition["renderCall"]>>[2];
type Result = Awaited<ReturnType<Definition["execute"]>>;
const result: Result = { content: [{ type: "text", text: "raw result" }], details: undefined };
const modes = ["on", "off", "border"] as const;
const count = (text: string, phrase: string) => text.split(phrase).length - 1;

beforeEach(() =>
  applyPresentationSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
  }),
);

const context = (overrides: Partial<Context> = {}): Context =>
  renderContextFixture({
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

class StatefulText extends Text {
  updateValue(value: string) {
    this.setText(value);
  }
}

test("transient renderer failures clear original slot caches so changed inputs recover", () => {
  let callFails = true;
  let resultFails = true;
  const recovered = (last: Component | undefined, value: string) => {
    if (last !== undefined && !(last instanceof StatefulText)) throw new Error("wrong component");
    const component = last ?? new StatefulText("", 0, 0);
    component.updateValue(value);
    return component;
  };
  const definition: Definition = {
    ...createReadToolDefinition("/project"),
    renderCall(_args, _theme, ctx) {
      if (callFails) {
        callFails = false;
        throw new Error("transient call failure");
      }
      return recovered(ctx.lastComponent, "call recovered");
    },
    renderResult(_value, _options, _theme, ctx) {
      if (resultFails) {
        resultFails = false;
        throw new Error("transient result failure");
      }
      return recovered(ctx.lastComponent, "result recovered");
    },
  };
  const tool = withCodePreviewShell(definition, { mode: "off", compactSummary: () => undefined });
  const ctx = context();
  assert.match(paint(tool, ctx).rows.join("\n"), /raw result/u);
  ctx.args = { path: "changed.ts" };
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = paint(tool, ctx).rows.join("\n");
    assert.match(text, /call recovered/u);
    assert.match(text, /result recovered/u);
  }
});

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
    // JSON escapes C0 controls; a C1 introducer would otherwise reach the terminal raw.
    const args = { path: "src/\u009b31mfile.ts", offset: 17, limit: 42 };
    const text = paint(tool, context({ args })).rows.join("\n");
    for (const value of [/31mfile\.ts/u, /offset\D+17/u, /limit\D+42/u])
      assert.match(text, value, mode);
    assert.doesNotMatch(text, /\u009b/u);
    assert.match(text, /BODY/u);
  }
});

test("without content callbacks, issues sit once between the original call and result", () => {
  const issues: CompactIssue[] = [
    { severity: "error", code: "failed", message: "Remote write failed", detail: "Run status" },
    { severity: "warning", code: "partial", message: "Partial changes may remain" },
    { severity: "info", code: "page", message: "Continue at offset=143" },
  ];
  for (const mode of modes) {
    const tool = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => new Text("ORIGINAL CALL", 0, 0),
        renderResult: () => new Text("ORIGINAL RESULT", 0, 0),
      },
      { mode, compactSummary: () => ({ subject: "file.ts", outcome: "error", issues }) },
    );
    const state = {};
    for (const expanded of [false, true, false, true]) {
      const text = paint(tool, context({ state, expanded })).rows.join("\n");
      assert.equal(count(text, "Remote write failed"), 1);
      assert.equal(count(text, "Partial changes may remain"), 1);
      for (const phrase of ["Run status", "Continue at offset=143", "ORIGINAL"])
        assert.equal(text.includes(phrase), expanded, `${mode} ${phrase}`);
      if (!expanded) continue;
      const positions = [
        "ORIGINAL CALL",
        "Remote write failed",
        "Run status",
        "Partial changes may remain",
        "Continue at offset=143",
        "ORIGINAL RESULT",
      ].map((phrase) => text.indexOf(phrase));
      assert.deepEqual(
        positions,
        positions.toSorted((a, b) => a - b),
      );
    }
  }
});

test("only expanded details expose nested mouse actions through every frame", () => {
  for (const mode of modes) {
    for (const issues of [false, true]) {
      let clicks = 0;
      const action: Component = {
        render: () => ["ACTION"],
        invalidate() {},
        handleMouse(event) {
          assert.equal(event.x, 0);
          assert.equal(event.y, 0);
          clicks++;
          return { handled: true };
        },
      };
      const definition: Definition = {
        ...createReadToolDefinition("/project"),
        renderCall: () => new Text("header", 0, 0),
        renderResult: () => action,
      };
      const tool = withCodePreviewShell(definition, {
        mode,
        compactSummary: () =>
          issues
            ? {
                subject: "file.ts",
                outcome: "uncertain",
                issues: [
                  {
                    severity: "warning",
                    code: "unconfirmed",
                    message: "Could not confirm the result",
                    detail: "retained guidance",
                  },
                ],
              }
            : undefined,
      });
      for (const expanded of [false, true]) {
        const ctx = context({ expanded });
        const { call, rows } = paint(tool, ctx);
        const y = rows.findIndex((line) => line.includes("ACTION"));
        if (issues) {
          const detailRow = rows.findIndex((line) => line.includes("retained guidance"));
          assert.equal(detailRow >= 0, expanded);
        }
        if (!expanded) {
          assert.equal(y, -1);
          continue;
        }
        assert.ok(y >= 0);
        const x = rows[y]!.indexOf("ACTION");
        const event: TuiMouseEvent = {
          type: "click",
          button: "left",
          x,
          y,
          screenX: x + 20,
          screenY: y + 10,
          width: 100,
          height: rows.length,
          shift: false,
          alt: false,
          ctrl: false,
        };
        assert.equal(call.handleMouse?.(event)?.handled, true);
      }
      assert.equal(clicks, 1);
    }
  }
});

test("expanded bodies are built in Pi's call-then-result order across toggles and failures", () => {
  for (const mode of modes) {
    let fails = false;
    let preparedHeading: string | undefined;
    const tool: Definition = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => {
          preparedHeading = "prepared result heading";
          return new Text("sole call heading", 0, 0);
        },
        renderResult: () => {
          if (fails) throw new Error("factory failure");
          return new Text(`${preparedHeading ?? "missing preparation"}\nresult body`, 0, 0);
        },
      },
      {
        mode,
        compactSummary: () => ({
          subject: "compact subject",
          outcome: "warning",
          issues: [{ severity: "warning", code: "cleanup", message: "independent guidance" }],
        }),
      },
    );
    const state = {};
    for (const isPartial of [true, false]) {
      for (const expanded of [true, false, true]) {
        for (fails of [false, true, false]) {
          preparedHeading = undefined;
          const text = paint(tool, context({ state, isPartial, expanded })).rows.join("\n");
          assert.equal(count(text, "independent guidance"), 1);
          assert.equal(text.includes("sole call heading"), expanded);
          if (!expanded) continue;
          assert.doesNotMatch(text, /missing preparation/u);
          assert.equal(text.includes("prepared result heading"), !fails);
          assert.equal(text.includes("raw result"), fails);
        }
      }
    }
    // Pi mounts the final call before replacing the retained streaming result.
    paint(tool, context({ state, isPartial: true }));
    const finalContext = context({ state, isPartial: false });
    const call = tool.renderCall!(finalContext.args, plainTheme, finalContext);
    assert.match(call.render(100).join("\n"), /sole call heading/u);
  }
});

test("informational issues render once on expansion, including renderer fallback", () => {
  for (const mode of modes) {
    for (const fails of [false, true]) {
      const tool: Definition = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderCall: () => new Text("call", 0, 0),
          renderResult: () => {
            if (fails) throw new Error("failed renderer");
            return new Text("page body", 0, 0);
          },
        },
        {
          mode,
          compactSummary: () => ({
            subject: "file",
            outcome: "success",
            issues: [
              {
                severity: "info",
                code: "read-continuation",
                message: "Showing lines 1-142 of 180",
                detail: "Use offset=143 to continue.",
              },
            ],
          }),
        },
      );
      const state = {};
      for (const expanded of [false, true, false, true]) {
        const text = paint(tool, context({ state, expanded })).rows.join("\n");
        assert.equal(count(text, "Showing lines 1-142 of 180"), expanded ? 1 : 0);
        assert.equal(count(text, "offset=143"), expanded ? 1 : 0);
        if (expanded) assert.equal(text.includes("raw result"), fails);
      }
    }
  }
});

test("result-only rows show issues and fall back when their original result fails", () => {
  for (const mode of modes) {
    for (const fails of [false, true]) {
      const tool: Definition = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderResult: () => {
            if (fails) throw new Error("factory failure");
            return new Text("original result", 0, 0);
          },
        },
        {
          mode,
          compactSummary: () => ({
            subject: "result only",
            outcome: "warning",
            issues: [
              {
                severity: "warning",
                code: "cleanup",
                message: "Cleanup is unconfirmed",
                detail: "complete recovery",
              },
            ],
          }),
        },
      );
      for (const expanded of [false, true]) {
        const ctx = context({ expanded });
        const body = tool.renderResult!(result, { expanded, isPartial: false }, plainTheme, ctx);
        const text = body.render(100).join("\n");
        assert.equal(count(text, "Cleanup is unconfirmed"), 1);
        assert.equal(count(text, "complete recovery"), expanded ? 1 : 0);
        assert.equal(text.includes("raw result"), expanded && fails);
        assert.equal(text.includes("original result"), expanded && !fails);
      }
    }
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
  const text = paint(tool, context({ showImages: false }), value).rows.join("\n");
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
  assert.equal(count(failed.rows.join("\n"), "Check cleanup"), 1);
  assert.doesNotThrow(() => {
    failed.call.invalidate();
    failed.output.invalidate();
  });
  fails = false;
  assert.match(paint(tool, ctx).rows.join("\n"), /raw result/u);
  ctx.args = { path: "repaired.ts" };
  assert.match(paint(tool, ctx).rows.join("\n"), /Recovered original result/u);
  assert.equal(inherited, undefined);
});
