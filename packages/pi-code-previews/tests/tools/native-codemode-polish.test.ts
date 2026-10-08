import assert from "node:assert/strict";
import { afterEach, beforeEach, test, vi } from "vitest";
import { formatDuration } from "pi-cosmic-core";
import { failingTheme, plainTheme } from "pi-cosmic-core/testing";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
} from "../../testing";
import { codemodeRenderers, nativeCall, scriptResult } from "../support/native-codemode";
import { stripAnsi } from "../support/render";

const settings = (
  style: "compact" | "preview",
  timing = false,
  background: "off" | "on" | "border" = "off",
) =>
  applyPresentationSettings({
    toolCallCollapsedStyle: style,
    toolCallTiming: timing,
    toolCallBackground: background,
  });
const running = { content: [], details: { calls: [nativeCall({ status: "running" })] } };
const completed = scriptResult(
  "completed",
  { calls: [] },
  { type: "text", text: "OUTPUT_RETAINED" },
);
beforeEach(() => applyPresentationSettings({ syntaxHighlighting: false }));
afterEach(() => vi.restoreAllMocks());

for (const width of [16, 60, 100])
  test(`native collapsed source is screen-row bounded at ${width} columns, with complete expansion`, () => {
    settings("preview");
    const source = "// SOURCE_HEAD " + "x".repeat(2400) + " SOURCE_TAIL";
    for (const hostile of [false, true]) {
      const theme = hostile ? failingTheme() : plainTheme;
      const h = createToolPresentationHarness(codemodeRenderers(), { theme });
      h.call({ code: source });
      assert.ok(h.render(width).length <= 12);
      h.call({ code: source }, { expanded: true });
      const expanded = stripAnsi(h.render(width).join("\n"));
      assert.ok(expanded.includes("SOURCE_HEAD"));
      assert.ok(expanded.includes("SOURCE_TAIL"));
      assert.ok(h.render(width).length > 12);
    }
  });

for (const style of ["compact", "preview"] as const)
  for (const expanded of [false, true])
    for (const timing of [false, true])
      for (const background of ["off", "on", "border"] as const)
        for (const progress of ["none", "returned", "running"] as const)
          test(`native progress animates and releases its owner in ${style}/${background}/${progress}, expanded=${expanded}, timing=${timing}`, () => {
            settings(style, timing, background);
            const probe = animationSchedulerProbe();
            const h = createToolPresentationHarness(codemodeRenderers(probe.schedule));
            h.call({ code: "// SOURCE_RETAINED" }, { expanded });
            assert.equal(probe.scheduled, 0);
            const partial =
              progress === "none"
                ? { content: [], details: { calls: [] } }
                : progress === "returned"
                  ? {
                      ...running,
                      details: { calls: [{ ...running.details.calls[0], status: "ok" }] },
                    }
                  : running;
            h.result(partial, { isPartial: true, expanded });
            const before = h.render(100).join("\n");
            assert.equal(probe.scheduled, 1);
            probe.tick();
            assert.notEqual(h.render(100).join("\n"), before);
            assert.equal(probe.scheduled, 1);
            if (!timing) assert.equal(h.context.state.codePreviewTimingStartedAt, undefined);
            h.result(completed, { expanded });
            h.render(100);
            assert.equal(probe.stops, 1);
            h.call({ code: "// SOURCE_RETAINED" }, { expanded: true });
            h.result(completed, { expanded: true });
            const final = h.render(100).join("\n");
            assert.ok(final.includes("SOURCE_RETAINED"));
            assert.ok(final.includes("OUTPUT_RETAINED"));
          });

for (const style of ["compact", "preview"] as const)
  for (const expanded of [false, true])
    for (const enabled of [false, true])
      for (const background of ["off", "on", "border"] as const)
        for (const parentMs of [0, 379, 3200])
          test(`native independent measured timing in ${style}/${background}, expanded=${expanded}, timing=${enabled}, parent=${parentMs}ms`, () => {
            settings(style, enabled, background);
            let now = 1000;
            vi.spyOn(Date, "now").mockImplementation(() => now);
            const h = createToolPresentationHarness(codemodeRenderers());
            const args = { code: "await Promise.allSettled(checks);" };
            h.call(args, { executionStarted: true, isPartial: true, expanded });
            h.result(running, { isPartial: true, expanded });
            now += parentMs;
            const final = {
              ...completed,
              details: {
                calls: [
                  { ...running.details.calls[0], status: "ok", durationMs: 137 },
                  nativeCall({
                    id: "private/2",
                    name: "mcp__atlassian__tool_call",
                    args: "{}",
                    durationMs: 253,
                  }),
                  nativeCall({
                    id: "private/3",
                    name: "bash",
                    args: '{"command":"run-check"}',
                    status: "error",
                    error: "CHECK_FAILURE_RETAINED",
                    durationMs: 211,
                  }),
                ],
              },
            };
            h.result(final, { expanded });
            // Pi rebuilds both slots at settlement, including a previously partial border call.
            h.invalidate();
            const assertMeasurements = () => {
              const rows = stripAnsi(h.render(160).join("\n"));
              for (const duration of [parentMs, 137, 253, 211])
                assert.equal(rows.split(formatDuration(duration)).length - 1, enabled ? 1 : 0);
              // Concurrent children are not summed into the parent or each other.
              assert.equal(rows.includes(formatDuration(390)), false);
              assert.ok(rows.includes("atlassian / tool_call"));
              assert.ok(rows.includes("CHECK_FAILURE_RETAINED"));
            };
            assertMeasurements();
            assert.equal(h.context.state.codePreviewTimingStartedAt, enabled ? 1000 : undefined);
            assert.equal(
              h.context.state.codePreviewTimingEndedAt,
              enabled ? 1000 + parentMs : undefined,
            );
            now += 5000;
            h.call(args, { expanded: !expanded, isPartial: false });
            h.result(final, { expanded: !expanded });
            assertMeasurements();
          });

for (const style of ["compact", "preview"] as const)
  for (const background of ["off", "on", "border"] as const)
    test(`native ${style}/${background} pending and replayed calls never acquire synthetic timing`, () => {
      settings(style, true, background);
      for (const durationMs of [undefined, -1, NaN, Infinity, "250", 0]) {
        const h = createToolPresentationHarness(codemodeRenderers());
        const args = { code: "// SOURCE_RETAINED" };
        h.call(args, { executionStarted: false, isPartial: true });
        assert.equal(h.render(160).join("\n").includes(formatDuration(0)), false);
        assert.equal(h.context.state.codePreviewTimingStartedAt, undefined);
        const final = {
          ...completed,
          details: {
            calls: [{ ...running.details.calls[0], status: "ok", durationMs }],
          },
        };
        for (const expanded of [false, true]) {
          h.call(args, { expanded, executionStarted: true, isPartial: false });
          h.result(final, { expanded });
          const rows = stripAnsi(h.render(160).join("\n"));
          // Only the child's actual recorded zero is eligible; the header is not a new clock.
          assert.equal(rows.split(formatDuration(0)).length - 1, durationMs === 0 ? 1 : 0);
          assert.equal(rows.includes(formatDuration(250)), false);
          assert.equal(h.context.state.codePreviewTimingStartedAt, undefined);
          assert.equal(h.context.state.codePreviewTimingEndedAt, undefined);
        }
      }
    });

for (const style of ["compact", "preview"] as const)
  test(`native ${style} expansion preserves bounded calls with oversized or unknown history`, () => {
    settings(style);
    const records = Array.from({ length: 257 }, (_, index) =>
      nativeCall({ id: `private/${index}`, args: `{"path":"/project/record-${index}.ts"}` }),
    );
    const retained = [
      ...records.slice(0, -1),
      { ...records[256]!, status: "error", error: "LAST_FAILURE" },
    ];
    const result = {
      ...completed,
      details: { calls: retained, fullOutputPath: "/tmp/RECOVERY_PATH" },
    };
    const before = structuredClone(result);
    for (const unknownHeader of [false, true]) {
      const h = createToolPresentationHarness(codemodeRenderers());
      const rendered = unknownHeader
        ? {
            ...result,
            content: [{ type: "text" as const, text: "UNKNOWN_HEADER\nOUTPUT_RETAINED" }],
          }
        : result;
      h.call({ code: "// SOURCE_RETAINED" }, { expanded: true });
      h.result(rendered, { expanded: true });
      const text = h.render(120).join("\n");
      for (const marker of [
        "SOURCE_RETAINED",
        "record-256.ts",
        "LAST_FAILURE",
        "OUTPUT_RETAINED",
        "RECOVERY_PATH",
      ])
        assert.ok(text.includes(marker), marker);
    }
    assert.deepEqual(result, before);
  });
