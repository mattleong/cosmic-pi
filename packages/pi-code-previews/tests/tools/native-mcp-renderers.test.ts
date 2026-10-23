import assert from "node:assert/strict";
import type { ToolInfo, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import { stripAnsi } from "pi-cosmic-core";
import { beforeEach, test } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
} from "../../testing";
import { createNativeMcpRenderers } from "../../src/tools/native-mcp-render";
import type { CodePreviewRendererPresentation } from "../../src/application/renderer-contract";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";

const name = "mcp__team_docs__find_page";
const metadata = (path = "builtin:mcp", exposure: ToolInfo["exposure"] = "direct"): ToolInfo => ({
  name,
  description: "Public native tool metadata, no label or execution",
  parameters: { type: "object" },
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
  assert.ok(
    Fn.pipe(
      stripAnsi(Arr.join(h.render(200), "\n")),
      Str.includes("EXACT_INPUT_AFTER_NATIVE_FAILURE"),
    ),
  );
});

test("renderer-only downstream never needs labels, schemas or execution fields", () => {
  const foreign = Object.freeze({ renderCall: () => new Text("FOREIGN_WINNER", 0, 0) });
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
  assert.ok(Fn.pipe(stripAnsi(Arr.join(h.render(100), "\n")), Str.includes("FOREIGN_WINNER")));
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
