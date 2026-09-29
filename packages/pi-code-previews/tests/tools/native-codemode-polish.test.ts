import assert from "node:assert/strict";
import { afterEach, test, vi } from "vitest";
import { formatDuration } from "pi-cosmic-core";
import { extensionApiFixture, opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { animationSchedulerProbe, createToolPresentationHarness } from "../../testing";
import { captureFreshNativeCodemode } from "../../src/boundary/host-native-codemode";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { styleNativeCodemode } from "../../src/tools/native-codemode-render";
import { stripAnsi } from "../support/render";

const fresh = () =>
  captureFreshNativeCodemode(
    extensionApiFixture({
      getSettings: () => ({}),
      getAllTools: () => [],
      appendEntry() {},
    }),
  )!;
const settings = (
  style: "compact" | "preview",
  timing = false,
  background: "off" | "on" | "border" = "off",
) =>
  setCodePreviewSettings({
    ...defaultCodePreviewSettings,
    syntaxHighlighting: false,
    toolCallCollapsedStyle: style,
    toolCallTiming: timing,
    toolCallBackground: background,
  });
const running = {
  content: [],
  details: {
    calls: [{ id: "private/1", name: "read", args: '{"path":"/project/a.ts"}', status: "running" }],
  },
};
const completed = {
  content: [
    { type: "text" as const, text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
    { type: "text" as const, text: "OUTPUT_RETAINED" },
  ],
  details: { calls: [] },
};
afterEach(() => {
  setCodePreviewSettings(defaultCodePreviewSettings);
  vi.restoreAllMocks();
});

for (const width of [16, 60, 100])
  test(`native collapsed source is screen-row bounded at ${width} columns, with complete expansion`, () => {
    settings("preview");
    const source = "// SOURCE_HEAD " + "x".repeat(2400) + " SOURCE_TAIL";
    for (const hostile of [false, true]) {
      const theme = hostile
        ? opaqueFixture({
            ...plainTheme,
            fg() {
              throw new Error("theme unavailable");
            },
          })
        : plainTheme;
      const h = createToolPresentationHarness(
        styleNativeCodemode(fresh(), () => undefined, "/project"),
        { theme },
      );
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
            const h = createToolPresentationHarness(
              styleNativeCodemode(fresh(), probe.schedule, "/project"),
            );
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

for (const enabled of [false, true])
  test(`native measured parent/child timing respects the setting, enabled=${enabled}`, () => {
    settings("compact", enabled);
    let now = 1000;
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const h = createToolPresentationHarness(
      styleNativeCodemode(fresh(), () => undefined, "/project"),
    );
    h.call({ code: "return 1" }, { executionStarted: true, isPartial: true });
    h.result(running, { isPartial: true });
    now += 3200;
    h.result({
      ...completed,
      details: { calls: [{ ...running.details.calls[0], status: "ok", durationMs: 2500 }] },
    });
    const rows = h.render(120).join("\n");
    assert.equal(rows.includes(formatDuration(3200)), enabled);
    assert.equal(rows.includes(formatDuration(2500)), enabled);
  });

for (const style of ["compact", "preview"] as const)
  test(`native ${style} expansion preserves bounded calls with oversized or unknown history`, () => {
    settings(style);
    const records = Array.from({ length: 257 }, (_, index) => ({
      id: `private/${index}`,
      name: "read",
      args: JSON.stringify({ path: `/project/record-${index}.ts` }),
      status: "ok",
    }));
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
      const h = createToolPresentationHarness(
        styleNativeCodemode(fresh(), () => undefined, "/project"),
      );
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
