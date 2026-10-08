import assert from "node:assert/strict";
import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { stripAnsi } from "pi-cosmic-core";
import { beforeEach, test } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
} from "../../testing";
import { createNativeMcpRenderers } from "../../src/tools/native-mcp-render";
import type { CodePreviewRendererPresentation } from "../../src/application/renderer-contract";

const name = "mcp__team_docs__find_page";
const metadata = (path = "builtin:mcp", exposure: ToolInfo["exposure"] = "direct"): ToolInfo => ({
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
  enabledTools: [],
});
const settings = (style: "preview" | "compact", background: "off" | "on" | "border" = "off") =>
  applyPresentationSettings({ toolCallCollapsedStyle: style, toolCallBackground: background });
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false, toolCallTiming: false }));

/** Like Pi's own MCP call: its label, then the arguments as key/value lines. */
const native: ToolRenderers = {
  renderCall: (args, _theme, context) => {
    const body = new Container();
    body.addChild(new Text("NATIVE_LABEL", 0, 0));
    body.addChild(new Text("NATIVE_EXTRA_CALL_CONTENT", 0, 0));
    body.addChild(
      new Text(context.expanded ? "NATIVE_EXPANDED_CALL_CONTENT" : "NATIVE_PENDING_CONTENT", 0, 0),
    );
    body.addChild(new Text(JSON.stringify(args), 0, 0));
    return body;
  },
  renderResult: () => new Text("Native result", 0, 0),
};
const occurrences = (text: string, marker: string) => text.split(marker).length - 1;

for (const style of ["preview", "compact"] as const)
  for (const background of ["off", "on", "border"] as const)
    test(`${style}/${background} keeps the collapsed native call and shows expanded arguments once`, () => {
      settings(style, background);
      const renderers = createNativeMcpRenderers(name, metadata(), native, session());
      assert.equal(renderers.renderShell, "self");
      const h = createToolPresentationHarness(renderers);
      const args = { query: "EXACT_ARGUMENT", nested: { retained: [1, true] } };
      h.call(args);
      const pending = stripAnsi(h.render(200).join("\n"));
      if (style === "preview") {
        assert.ok(pending.includes("NATIVE_LABEL"));
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
      for (const marker of ["EXACT_ARGUMENT", '"retained"', "COMPLETE_OUTPUT"])
        assert.ok(expanded.includes(marker), marker);
      assert.equal(occurrences(expanded, "EXACT_ARGUMENT"), 1, "arguments appear once");
      // One shared heading names the confirmed remote tool; the native call adds no second one.
      assert.ok(expanded.includes("find.page"));
      for (const marker of [
        "NATIVE_LABEL",
        "NATIVE_EXTRA_CALL_CONTENT",
        "NATIVE_EXPANDED_CALL_CONTENT",
      ])
        assert.equal(expanded.includes(marker), false, marker);
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
      const renderers = createNativeMcpRenderers(name, metadata(), cachedNative, session());
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
        if (frame.expanded) assert.ok(text.includes("EXACT_INPUT_RETAINED"));
        else if (style === "preview") assert.ok(text.includes("NATIVE_PENDING_RETAINED"));
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
    const renderers = createNativeMcpRenderers(name, metadata(), native, captured);
    const h = createToolPresentationHarness(renderers);
    h.call({ query: "retained" });
    const text = stripAnsi(h.render(200).join("\n"));
    assert.equal(text.includes("NATIVE_EXTRA_CALL_CONTENT"), capturedStyle === "preview");
    if (capturedStyle === "compact") assert.ok(text.includes(name));
  }
});

test("native call failure still preserves exact expanded input", () => {
  settings("compact");
  const renderers = createNativeMcpRenderers(
    name,
    metadata(),
    {
      renderCall: () => {
        throw new Error("Native style unavailable");
      },
    },
    session(),
  );
  const h = createToolPresentationHarness(renderers);
  h.call({ query: "EXACT_INPUT_AFTER_NATIVE_FAILURE" }, { expanded: true });
  assert.ok(stripAnsi(h.render(200).join("\n")).includes("EXACT_INPUT_AFTER_NATIVE_FAILURE"));
});

test("historical missing-before-connect presentation stays conservative, then follows catalog and hidden withdrawal", () => {
  settings("compact");
  for (const metadataState of [
    undefined,
    metadata("builtin:mcp", "codemode"),
    metadata("builtin:mcp", "hidden"),
  ]) {
    const renderers = createNativeMcpRenderers(name, metadataState, native, session());
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
  const h = createToolPresentationHarness(
    createNativeMcpRenderers(name, metadata(), downstream, session()),
  );
  h.call({});
  assert.ok(stripAnsi(h.render(100).join("\n")).includes("FOREIGN_WINNER"));
});

test("retired scheduling admission never borrows the replacement owner", () => {
  settings("preview");
  const origin = animationSchedulerProbe();
  const replacement = animationSchedulerProbe();
  let live = true;
  const ownedSchedule: CodePreviewRendererPresentation["scheduleAnimation"] = (interval, tick) =>
    live ? origin.schedule(interval, tick) : undefined;
  const renderers = createNativeMcpRenderers(name, metadata(), native, session(ownedSchedule));
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
  const replacementRenderers = createNativeMcpRenderers(
    name,
    metadata(),
    native,
    session(replacement.schedule),
  );
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
