import assert from "node:assert/strict";
import { createReadToolDefinition, type Theme } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";
import { testTheme } from "../support/render";

type Definition = ReturnType<typeof createReadToolDefinition>;
type Context = Parameters<NonNullable<Definition["renderCall"]>>[2];
type Result = Awaited<ReturnType<Definition["execute"]>>;
const originalSettings = { ...codePreviewSettings, tools: [...codePreviewSettings.tools] };
// SAFETY: The render-only theme supplies all foreground and background methods used here.
const theme = { ...testTheme(), bg: (_key: string, text: string) => text } as Theme;
const result: Result = { content: [{ type: "text", text: "raw result" }], details: undefined };

beforeEach(() =>
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    toolCallCollapsedStyle: "compact",
    toolCallTiming: false,
  }),
);
afterEach(() => setCodePreviewSettings(originalSettings));

function context(overrides: Partial<Context> = {}): Context {
  return {
    args: { path: "file.ts" },
    state: {},
    cwd: "/project",
    toolCallId: "fallback",
    lastComponent: undefined,
    invalidate: () => undefined,
    executionStarted: false,
    argsComplete: false,
    isPartial: false,
    expanded: true,
    isError: false,
    showImages: false,
    ...overrides,
  };
}

function paint(tool: Definition, ctx: Context, value = result) {
  const call = tool.renderCall!(ctx.args, theme, ctx);
  const output = tool.renderResult!(
    value,
    { expanded: ctx.expanded, isPartial: ctx.isPartial },
    theme,
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

test("transient renderer failures clear original slot caches so later calls recover", () => {
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
  for (let attempt = 0; attempt < 2; attempt++) {
    const text = paint(tool, ctx).rows.join("\n");
    assert.match(text, /call recovered/u);
    assert.match(text, /result recovered/u);
  }
});

test("only expanded details expose nested mouse actions through every frame", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const failure of [false, true]) {
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
          failure
            ? {
                subject: "file.ts",
                outcome: "uncertain",
                notices: [{ kind: "recovery", text: "retained guidance" }],
              }
            : undefined,
      });
      for (const expanded of [false, true]) {
        const ctx = context({ expanded });
        const { call, rows } = paint(tool, ctx);
        if (failure) {
          const noticeRow = rows.findIndex((line) => line.includes("retained guidance"));
          assert.ok(noticeRow >= 0);
          if (expanded && mode !== "off") assert.ok(noticeRow < rows.length - 1);
        }
        const y = rows.findIndex((line) => line.includes("ACTION"));
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

test("explicit non-success projections hide details until expansion and retain slot state", () => {
  for (const outcome of ["error", "cancelled", "uncertain"] as const) {
    for (const mode of ["on", "off", "border"] as const) {
      const callBody = new StatefulText("original call", 0, 0);
      const resultBody = new StatefulText("original result", 0, 0);
      let expandedOnce = false;
      const tool = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderCall(_args, _theme, ctx) {
            assert.equal(ctx.lastComponent, expandedOnce ? callBody : undefined);
            return callBody;
          },
          renderResult(_value, _options, _theme, ctx) {
            assert.equal(ctx.lastComponent, expandedOnce ? resultBody : undefined);
            return resultBody;
          },
        },
        {
          mode,
          compactSummary: () => ({
            subject: "decoded outcome",
            outcome,
            detailsOnExpand: true,
            notices: [{ kind: "recovery", text: "Inspect before retrying." }],
          }),
        },
      );
      const state = {};
      for (let cycle = 0; cycle < 2; cycle++) {
        const collapsed = paint(tool, context({ state, expanded: false })).rows.join("\n");
        assert.match(collapsed, /decoded outcome/u);
        assert.match(collapsed, /Inspect before retrying/u);
        assert.doesNotMatch(collapsed, /original call|original result/u);
        const expanded = paint(tool, context({ state, expanded: true })).rows.join("\n");
        assert.match(expanded, /original call/u);
        assert.match(expanded, /original result/u);
        expandedOnce = true;
      }
    }
  }
});

test("unflagged non-success keeps details on expansion and owned failure keeps its presentation", () => {
  for (const outcome of ["error", "cancelled", "uncertain"] as const) {
    for (const owned of [false, true]) {
      const tool = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderCall: () => new Text("original call", 0, 0),
          renderResult: () => new Text("original result", 0, 0),
        },
        {
          mode: "off",
          compactSummary: () =>
            owned
              ? {
                  subject: "decoded outcome",
                  outcome,
                  detailsOnExpand: true,
                  failure: { cause: "owned cause", details: "owned details" },
                }
              : { subject: "decoded outcome", outcome },
        },
      );
      for (const expanded of [false, true]) {
        const text = paint(tool, context({ expanded })).rows.join("\n");
        if (owned) {
          assert.match(text, expanded ? /owned details/u : /owned cause/u);
          assert.doesNotMatch(text, /original call|original result/u);
        } else if (expanded) {
          assert.match(text, /original call/u);
          assert.match(text, /original result/u);
        } else {
          assert.doesNotMatch(text, /original call|original result/u);
          assert.match(text, /decoded outcome/u);
        }
      }
    }
  }
});

test("expanded ownership requires a current successful result and survives toggles", () => {
  for (const mode of ["on", "off", "border"] as const) {
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
          return new Text(`${preparedHeading ?? "missing preparation"}\ncomplete recovery`, 0, 0);
        },
      },
      {
        mode,
        compactSummary: () => ({
          subject: "compact subject",
          outcome: "warning",
          expandedResultOwnsCall: true,
          notices: [
            { kind: "recovery", text: "complete recovery", expandedInResult: true },
            { kind: "warning", text: "independent guidance" },
          ],
        }),
      },
    );
    const state = {};
    for (const isPartial of [true, false]) {
      for (const expanded of [true, false, true]) {
        for (fails of [false, true, false]) {
          preparedHeading = undefined;
          const text = paint(tool, context({ state, isPartial, expanded })).rows.join("\n");
          assert.equal(text.match(/complete recovery/gu)?.length, 1);
          assert.match(text, /independent guidance/u);
          if (expanded) {
            if (!fails) assert.match(text, /prepared result heading/u);
            assert.equal(text.includes("sole call heading"), fails);
            assert.equal(text.includes("raw result"), fails);
          }
        }
      }
    }
    // Pi mounts the final call before replacing the retained streaming result.
    paint(tool, context({ state, isPartial: true }));
    const finalContext = context({ state, isPartial: false });
    const call = tool.renderCall!(finalContext.args, theme, finalContext);
    const pendingFinal = call.render(100).join("\n");
    assert.match(pendingFinal, /sole call heading/u);
    assert.match(pendingFinal, /complete recovery/u);
  }
});

test("owned failure keeps independent notices even when marked for original result ownership", () => {
  for (const mode of ["on", "off", "border"] as const) {
    const tool: Definition = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => new Text("original call", 0, 0),
        renderResult: () => new Text("original result", 0, 0),
      },
      {
        mode,
        compactSummary: () => ({
          subject: "failed operation",
          outcome: "error",
          expandedResultOwnsCall: true,
          failure: { cause: "owned cause", details: "complete owned failure" },
          notices: [{ kind: "recovery", text: "independent recovery", expandedInResult: true }],
        }),
      },
    );
    for (const expanded of [false, true]) {
      const text = paint(tool, context({ expanded })).rows.join("\n");
      assert.match(text, expanded ? /complete owned failure/u : /owned cause/u);
      assert.equal(text.match(/independent recovery/gu)?.length, 1);
      assert.doesNotMatch(text, /original call|original result/u);
    }
  }
});

test("expanded-only hints render once on expansion, including renderer fallback", () => {
  for (const mode of ["on", "off", "border"] as const) {
    for (const fails of [false, true]) {
      const tool: Definition = withCodePreviewShell(
        {
          ...createReadToolDefinition("/project"),
          renderCall: () => new Text("call", 0, 0),
          renderResult: () => {
            if (fails) throw new Error("failed renderer");
            return new Text("Continue at offset=143", 0, 0);
          },
        },
        {
          mode,
          compactSummary: () => ({
            subject: "file",
            outcome: "success",
            notices: [
              {
                kind: "recovery",
                text: "Continue at offset=143",
                code: "read-pagination",
                expandedOnly: true,
                expandedInResult: true,
              },
            ],
          }),
        },
      );
      const state = {};
      for (const expanded of [false, true, false, true]) {
        const text = paint(tool, context({ state, expanded })).rows.join("\n");
        assert.equal(text.match(/offset=143/gu)?.length ?? 0, expanded ? 1 : 0);
      }
    }
  }
});

test("result-only rows share notices only after their original result succeeds", () => {
  for (const fails of [false, true]) {
    const tool: Definition = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderResult: () => {
          if (fails) throw new Error("factory failure");
          return new Text("complete recovery", 0, 0);
        },
      },
      {
        mode: "border",
        compactSummary: () => ({
          subject: "result only",
          outcome: "warning",
          notices: [{ kind: "recovery", text: "complete recovery", expandedInResult: true }],
        }),
      },
    );
    const ctx = context();
    const body = tool.renderResult!(result, { expanded: true, isPartial: false }, theme, ctx);
    const text = body.render(100).join("\n");
    assert.equal(text.match(/complete recovery/gu)?.length, 1);
    assert.equal(text.includes("raw result"), fails);
  }
});

test("unknown providers retain complete long original recovery without parsing it", () => {
  const recovery = Array.from({ length: 100 }, (_, index) => `recovery-step-${index}`).join("\n");
  for (const throws of [false, true]) {
    const tool: Definition = withCodePreviewShell(
      {
        ...createReadToolDefinition("/project"),
        renderCall: () => new Text("unique source and target", 0, 0),
        renderResult: () => new Text(recovery, 0, 0),
      },
      {
        mode: "border",
        compactSummary: () => {
          if (throws) throw new Error("unknown provider");
          return undefined;
        },
      },
    );
    for (const expanded of [false, true]) {
      const text = paint(tool, context({ expanded })).rows.join("\n");
      if (expanded) {
        assert.match(text, /unique source and target/u);
        for (const step of recovery.split("\n")) assert.ok(text.includes(step));
      } else {
        assert.doesNotMatch(text, /unique source and target|recovery-step/u);
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

test("unknown child coverage keeps the original batch result on expansion", () => {
  const definition: Definition = {
    ...createReadToolDefinition("/project"),
    renderResult: () => new Text("Original recovery must remain visible", 0, 0),
  };
  const tool = withCodePreviewShell(definition, {
    mode: "off",
    compactSummary: () => ({
      subject: "batch",
      outcome: "success",
      detailsOnExpand: true,
      issues: { coverage: "complete", entries: [] },
      children: {
        total: 1,
        entries: [
          { label: "child", status: "success", issues: { coverage: "unknown", entries: [] } },
        ],
      },
    }),
  });
  assert.doesNotMatch(
    paint(tool, context({ expanded: false })).rows.join("\n"),
    /Original recovery/u,
  );
  assert.match(paint(tool, context({ expanded: true })).rows.join("\n"), /Original recovery/u);
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
      issues: {
        coverage: "complete",
        entries: [
          {
            operation: "operation",
            code: "cleanup",
            severity: "warning",
            cause: "Check cleanup",
            recovery: [],
            expandedInResult: true,
          },
        ],
      },
    }),
  });
  const ctx = context();
  const failed = paint(tool, ctx);
  assert.match(failed.rows.join("\n"), /Check cleanup/u);
  assert.doesNotThrow(() => {
    failed.call.invalidate();
    failed.output.invalidate();
  });
  fails = false;
  assert.match(paint(tool, ctx).rows.join("\n"), /Recovered original result/u);
  assert.equal(inherited, undefined);
});
