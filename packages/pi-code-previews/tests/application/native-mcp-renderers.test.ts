import assert from "node:assert/strict";
import type { ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { stripAnsi } from "pi-cosmic-core";
import { afterEach, test } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
} from "../../testing";
import { selectNativeMcpRenderers } from "../../src/application/native-mcp-renderers";
import type {
  CodePreviewRendererPresentation,
  PreviewToolInfo,
} from "../../src/application/renderer-contract";

const name = "mcp__team_docs__find_page";
const metadata = (
  path = "builtin:mcp",
  exposure: PreviewToolInfo["exposure"] = "direct",
): PreviewToolInfo => ({
  name,
  description: "Public native tool metadata, no label or execution",
  parameters: opaqueFixture({ type: "object" }),
  namespace: { name: "mcp__team_docs" },
  sourceInfo: { path, source: "builtin", scope: "temporary", origin: "top-level" },
  exposure,
});
const session = (
  scheduleAnimation = animationSchedulerProbe().schedule,
): CodePreviewRendererPresentation => ({
  cwd: "/project",
  scheduleAnimation,
  selfShell: true,
});
let restoreSettings = () => {};
afterEach(() => restoreSettings());
const settings = (style: "preview" | "compact", background: "off" | "on" | "border" = "off") => {
  restoreSettings();
  restoreSettings = applyPresentationSettings({
    syntaxHighlighting: false,
    toolCallTiming: false,
    toolCallCollapsedStyle: style,
    toolCallBackground: background,
  });
};

const native: ToolRenderers = {
  renderCall: (_args, _theme, context) => {
    const body = new Container();
    body.addChild(new Text("team-docs / find.page", 0, 0));
    body.addChild(new Text("NATIVE_EXTRA_CALL_CONTENT", 0, 0));
    body.addChild(
      new Text(context.expanded ? "NATIVE_EXPANDED_CALL_CONTENT" : "NATIVE_PENDING_CONTENT", 0, 0),
    );
    return body;
  },
  renderResult: () => new Text("Native result", 0, 0),
};

for (const style of ["preview", "compact"] as const)
  for (const background of ["off", "on", "border"] as const)
    test(`${style}/${background} keeps complete downstream native calls and exact expanded arguments`, () => {
      settings(style, background);
      const renderers = selectNativeMcpRenderers(name, metadata(), true, native, session());
      assert.ok(renderers);
      assert.equal(renderers.renderShell, "self");
      const h = createToolPresentationHarness(renderers);
      const args = { query: "EXACT_ARGUMENT", nested: { retained: [1, true] } };
      h.call(args);
      const pending = stripAnsi(h.render(200).join("\n"));
      if (style === "preview") {
        assert.ok(pending.includes("team-docs / find.page"));
        assert.ok(pending.includes("NATIVE_EXTRA_CALL_CONTENT"));
        assert.ok(pending.includes("NATIVE_PENDING_CONTENT"));
      } else assert.ok(pending.includes(name), "compact pending identity retains the raw alias");
      h.call(args, { expanded: true });
      h.result(
        {
          content: [{ type: "text", text: "COMPLETE_OUTPUT" }],
          details: { server: "team-docs", tool: "find.page" },
        },
        { expanded: true },
      );
      const expanded = stripAnsi(h.render(200).join("\n"));
      for (const marker of [
        "NATIVE_EXTRA_CALL_CONTENT",
        "NATIVE_EXPANDED_CALL_CONTENT",
        "EXACT_ARGUMENT",
        '"retained"',
        "COMPLETE_OUTPUT",
      ])
        assert.ok(expanded.includes(marker), marker);
    });

for (const style of ["preview", "compact"] as const)
  for (const background of ["off", "on", "border"] as const)
    test(`${style}/${background} expansion cycles preserve native mutable component ownership`, () => {
      settings(style, background);
      const cachedNative: ToolRenderers = {
        renderCall: (_args, _theme, context) => {
          assert.ok(!context.lastComponent || context.lastComponent instanceof Text);
          const text =
            context.lastComponent instanceof Text ? context.lastComponent : new Text("", 0, 0);
          text.setText(context.expanded ? "NATIVE_EXPANDED_RETAINED" : "NATIVE_PENDING_RETAINED");
          return text;
        },
      };
      const renderers = selectNativeMcpRenderers(name, metadata(), true, cachedNative, session());
      assert.ok(renderers);
      const h = createToolPresentationHarness(renderers);
      for (const frame of h.cycle(
        { query: "EXACT_INPUT_RETAINED" },
        {
          content: [{ type: "text", text: "Output" }],
          details: { server: "team-docs", tool: "find.page" },
        },
        { invalidate: "after" },
      )) {
        const text = stripAnsi(frame.text);
        if (frame.expanded) {
          assert.ok(text.includes("NATIVE_EXPANDED_RETAINED"));
          assert.ok(text.includes("EXACT_INPUT_RETAINED"));
        } else if (style === "preview") assert.ok(text.includes("NATIVE_PENDING_RETAINED"));
      }
    });

test("MCP rows use the session's captured appearance after settings change", () => {
  for (const capturedStyle of ["preview", "compact"] as const) {
    settings(capturedStyle === "compact" ? "preview" : "compact", "on");
    const captured: CodePreviewRendererPresentation = {
      ...session(),
      mode: "off",
      collapsedStyle: capturedStyle,
    };
    const renderers = selectNativeMcpRenderers(name, metadata(), true, native, captured);
    assert.ok(renderers);
    const h = createToolPresentationHarness(renderers);
    h.call({ query: "retained" });
    const text = stripAnsi(h.render(200).join("\n"));
    assert.equal(text.includes("NATIVE_EXTRA_CALL_CONTENT"), capturedStyle === "preview");
    if (capturedStyle === "compact") assert.ok(text.includes(name));
  }
});

test("native call failure still preserves exact expanded input", () => {
  settings("compact");
  const renderers = selectNativeMcpRenderers(
    name,
    metadata(),
    true,
    {
      renderCall: () => {
        throw new Error("Native style unavailable");
      },
    },
    session(),
  );
  assert.ok(renderers);
  const h = createToolPresentationHarness(renderers);
  h.call({ query: "EXACT_INPUT_AFTER_NATIVE_FAILURE" }, { expanded: true });
  assert.ok(stripAnsi(h.render(200).join("\n")).includes("EXACT_INPUT_AFTER_NATIVE_FAILURE"));
});

test("foreign winners, lookalikes, unrelated names and missing historical manager proof decline", () => {
  const downstream = Object.freeze(native);
  for (const path of [
    "<inline:foreign>",
    "builtin:mcp-lookalike",
    "some/builtin:mcp",
    "builtin:mcp/extra",
  ])
    assert.equal(
      selectNativeMcpRenderers(name, metadata(path), true, downstream, session()),
      undefined,
    );
  assert.equal(
    selectNativeMcpRenderers("read", metadata(), true, downstream, session()),
    undefined,
  );
  assert.equal(selectNativeMcpRenderers("mcp", undefined, true, downstream, session()), undefined);
  assert.equal(selectNativeMcpRenderers(name, undefined, false, downstream, session()), undefined);
  assert.equal(
    selectNativeMcpRenderers(
      name,
      { ...metadata(), name: "mcp__other__lookup" },
      true,
      downstream,
      session(),
    ),
    undefined,
  );
  assert.equal(downstream.renderCall, native.renderCall);
});

test("historical missing-before-connect presentation stays conservative, then follows catalog and hidden withdrawal", () => {
  settings("compact");
  for (const metadataState of [
    undefined,
    metadata("builtin:mcp", "codemode"),
    metadata("builtin:mcp", "hidden"),
  ]) {
    const renderers = selectNativeMcpRenderers(name, metadataState, true, native, session());
    assert.ok(renderers);
    const h = createToolPresentationHarness(renderers);
    h.call({ query: "retained" });
    assert.ok(stripAnsi(h.render(200).join("\n")).includes(name));
    h.result({
      content: [{ type: "text", text: "Returned" }],
      details: { server: "team-docs", tool: "find.page" },
    });
    assert.ok(stripAnsi(h.render(200).join("\n")).includes("team-docs / find.page"));
  }
});

test("renderer-only downstream never needs labels, schemas or execution fields", () => {
  const foreign = Object.freeze({ renderCall: () => new Text("FOREIGN_WINNER", 0, 0) });
  // Public next() exposes renderers only. Poison fields ensure no accidental definition inspection.
  const downstream = Object.defineProperties(
    { ...foreign },
    {
      label: {
        get() {
          throw new Error("next has no label");
        },
      },
      outputSchema: {
        get() {
          throw new Error("next has no outputSchema");
        },
      },
      execute: {
        get() {
          throw new Error("next has no execute");
        },
      },
    },
  );
  settings("preview");
  for (const tool of [metadata(), metadata("<inline:foreign>")]) {
    const renderers =
      selectNativeMcpRenderers(name, tool, true, downstream, session()) ?? downstream;
    const h = createToolPresentationHarness(renderers);
    h.call({});
    assert.ok(stripAnsi(h.render(100).join("\n")).includes("FOREIGN_WINNER"));
  }
});

test("retired scheduling admission never borrows the replacement owner", () => {
  settings("preview");
  const origin = animationSchedulerProbe();
  const replacement = animationSchedulerProbe();
  let live = true;
  const ownedSchedule: CodePreviewRendererPresentation["scheduleAnimation"] = (interval, tick) =>
    live ? origin.schedule(interval, tick) : undefined;
  const renderers = selectNativeMcpRenderers(
    name,
    metadata(),
    true,
    native,
    session(ownedSchedule),
  );
  assert.ok(renderers);
  const update = {
    content: [{ type: "text" as const, text: "Indexing" }],
    details: { server: "team-docs", tool: "find.page" },
  };
  const liveOrigin = createToolPresentationHarness(renderers);
  liveOrigin.call({}, { executionStarted: true });
  liveOrigin.result(update, { isPartial: true });
  liveOrigin.render(100);
  assert.ok(origin.scheduled > 0);
  live = false;
  const replacementRenderers = selectNativeMcpRenderers(
    name,
    metadata(),
    true,
    native,
    session(replacement.schedule),
  );
  assert.ok(replacementRenderers);
  const liveReplacement = createToolPresentationHarness(replacementRenderers);
  liveReplacement.call({}, { executionStarted: true });
  liveReplacement.result(update, { isPartial: true });
  liveReplacement.render(100);
  assert.ok(replacement.scheduled > 0);
  const count = replacement.scheduled;
  const originCount = origin.scheduled;
  const retired = createToolPresentationHarness(renderers);
  retired.call({}, { executionStarted: true });
  retired.result(update, { isPartial: true });
  retired.render(100);
  assert.equal(origin.scheduled, originCount);
  assert.equal(replacement.scheduled, count);
});
