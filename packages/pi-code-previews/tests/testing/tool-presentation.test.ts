import { createReadToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { afterEach, expect, it } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  captureRegistrations,
  createToolPresentationHarness,
  probeAnimationOwnership,
  renderContextFixture,
  withPresentationSettings,
} from "../../testing";
import { cloneCodePreviewSettings, codePreviewSettings } from "../../src/config/state";
import { withCodePreviewShell } from "../../src/tools/cooperative-tools";

const original = cloneCodePreviewSettings(codePreviewSettings);
afterEach(() => applyPresentationSettings(original));

const renderMessage = () => undefined;
const readTool = (onRenderCall: () => void = () => undefined) => ({
  ...createReadToolDefinition("/project"),
  renderCall: (
    args: { path?: string },
    theme: { bold: (text: string) => string },
    context: { expanded: boolean },
  ) => {
    onRenderCall();
    return new Text(theme.bold(`CALL ${args.path} ${context.expanded ? "open" : "closed"}`), 0, 0);
  },
  renderResult: () => new Text("BODY", 0, 0),
});

it("applies settings over the current snapshot and restores them even after a throw", () => {
  const restoreBaseline = applyPresentationSettings({ toolCallTiming: false });
  const baseline = codePreviewSettings;
  expect(() =>
    withPresentationSettings({ toolCallCollapsedStyle: "compact" }, () => {
      expect(codePreviewSettings).toMatchObject({
        toolCallCollapsedStyle: "compact",
        toolCallTiming: false,
      });
      throw new Error("render failed");
    }),
  ).toThrow("render failed");
  expect(codePreviewSettings).toEqual(baseline);
  restoreBaseline();
  expect(codePreviewSettings).toEqual(original);
});

it("builds pending render contexts and renders with the plain theme by default", () => {
  expect(renderContextFixture({ expanded: true })).toMatchObject({
    args: {},
    cwd: "/project",
    executionStarted: false,
    isPartial: true,
    expanded: true,
  });
  const harness = createToolPresentationHarness(readTool());
  harness.call({ path: "file.ts" });
  expect(harness.render().join("\n")).toContain("CALL file.ts closed");
});

it("captures tool and message renderer registrations and ignores commands", () => {
  const tool = readTool();
  const { tools, messageRenderers } = captureRegistrations((pi) => {
    pi.registerCommand("example", { handler: () => Promise.resolve() });
    pi.registerTool(tool);
    pi.registerMessageRenderer("example-message", renderMessage);
  });
  expect(tools).toEqual([tool]);
  expect(messageRenderers.get("example-message")).toBe(renderMessage);
});

it("resolves renderer-only registrations in order without registering or executing tools", () => {
  const native = { renderCall: () => new Text("native", 0, 0) };
  const styled = { renderCall: () => new Text("styled", 0, 0) };
  const captured = captureRegistrations((pi) => {
    pi.registerToolRenderer((_name, next) => next());
    pi.registerToolRenderer((name, next) => (name === "late-tool" ? styled : next()));
  });
  expect(captured.tools).toEqual([]);
  const resolved = captured.resolveToolRenderers("late-tool", native);
  expect(resolved).toBe(styled);
  expect(captured.resolveToolRenderers("other", native)).toBe(native);
  expect(captured.resolveToolRenderers("missing")).toBeUndefined();
  const harness = createToolPresentationHarness(resolved!);
  harness.call({});
  expect(harness.render().join("\n")).toContain("styled");
});

it("cycles expansion states with per-state overrides and opt-in invalidation", () => {
  let calls = 0;
  const harness = createToolPresentationHarness(readTool(() => (calls += 1)));
  const cycled = harness.cycle({ path: "a.ts" }, undefined, {
    states: [false, true],
    overrides: (expanded) => ({ isError: expanded }),
  });
  expect(cycled.map(({ expanded, text }) => [expanded, text.trim()])).toEqual([
    [false, "CALL a.ts closed"],
    [true, "CALL a.ts open"],
  ]);
  expect(harness.context.isError).toBe(true);
  expect(calls).toBe(2);
  harness.cycle({ path: "a.ts" }, undefined, { states: [false], invalidate: "after" });
  expect(calls).toBe(4);
});

it("reports each tool's scheduled animation, tick invalidation, and settlement stop", () => {
  const scheduler = animationSchedulerProbe();
  const report = withPresentationSettings(
    { toolCallCollapsedStyle: "compact", toolCallTiming: false },
    () => {
      const shelled = withCodePreviewShell(readTool(), {
        compactSummary: ({ args }) => ({ subject: args.path ?? "" }),
        scheduleAnimation: scheduler.schedule,
      });
      const unshelled = { ...readTool(), name: "plain" };
      return probeAnimationOwnership([shelled, unshelled], scheduler, {
        args: () => ({ path: "file.ts" }),
        filter: (tool) => tool.name !== "plain",
      });
    },
  );
  expect(report).toEqual([{ name: "read", scheduled: 1, invalidated: true, stops: 1 }]);
});
