import assert from "node:assert/strict";
import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { it } from "vitest";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { createToolPresentationHarness, withPresentationSettings } from "../../../testing";
import { createWebAccessRenderers } from "../../../src/third-party/web-access/render";

const downstream: ToolRenderers = {
  renderCall: () => new Text("DOWNSTREAM CALL EXTRAS", 0, 0),
  renderResult: (result) =>
    new Text(
      `DOWNSTREAM RESULT EXTRAS\n${result.content[0]?.type === "text" ? result.content[0].text.slice(0, 200) : ""}`,
      0,
      0,
    ),
};
const args = Object.freeze({
  urls: Array.from({ length: 7 }, (_, index) => `https://example.test/${index}`),
  prompt: `Exact prompt ${"padding ".repeat(80)}ARGUMENT_TAIL`,
  mode: "raw",
  auth: "browser-profile",
  proxy: "https://proxy.test",
});
const image = Object.freeze({ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" });
const content = Object.freeze([
  Object.freeze({ type: "text" as const, text: `${"Page text ".repeat(100)}OUTPUT_TAIL` }),
  Object.freeze({
    type: "text" as const,
    text: "RECOVERY_TAIL use the stored reference private-reference",
  }),
  image,
]);

for (const style of ["preview", "compact"] as const)
  for (const mode of ["on", "off", "border"] as const)
    for (const known of [true, false])
      it(`${style}/${mode}/${known ? "known" : "unknown"} preserves complete expansion and opaque downstream extras`, () => {
        withPresentationSettings(
          { toolCallCollapsedStyle: style, toolCallBackground: mode, toolCallTiming: false },
          () => {
            const details = Object.freeze(
              known
                ? { urlCount: 7, successful: 7, responseId: "private-reference" }
                : { version: "future" },
            );
            const value: AgentToolResult<unknown> = { content: opaqueFixture(content), details };
            const harness = createToolPresentationHarness(
              createWebAccessRenderers("fetch_content", downstream, {
                mode,
                collapsedStyle: style,
                selfShell: false,
                scheduleAnimation: () => undefined,
              }),
            );
            const frames = harness.cycle(args, value, {
              invalidate: "before",
              overrides: () => ({ showImages: false }),
            });
            for (const frame of frames.filter((entry) => entry.expanded)) {
              for (const marker of [
                "DOWNSTREAM CALL EXTRAS",
                "DOWNSTREAM RESULT EXTRAS",
                "ARGUMENT_TAIL",
                "OUTPUT_TAIL",
                "RECOVERY_TAIL",
                "https://example.test/6",
                "browser-profile",
                "private-reference",
              ])
                assert.ok(frame.text.includes(marker), marker);
            }
            assert.equal(value.content, content);
            assert.equal(value.details, details);
            assert.equal(value.content[2], image);
          },
        );
      });

for (const style of ["preview", "compact"] as const)
  for (const failure of ["construct", "draw"] as const)
    it(`${style} contains ${failure} failures without replaying the broken renderer or losing raw evidence`, () => {
      withPresentationSettings(
        { toolCallCollapsedStyle: style, toolCallBackground: "off", toolCallTiming: false },
        () => {
          let calls = 0;
          let fail = true;
          const renderers = createWebAccessRenderers(
            "fetch_content",
            {
              renderCall: downstream.renderCall!,
              renderResult: () => {
                calls++;
                if (fail && failure === "construct") throw new Error("broken construction");
                return {
                  render() {
                    if (fail) throw new Error("broken draw");
                    return ["RECOVERED DOWNSTREAM"];
                  },
                  invalidate() {},
                };
              },
            },
            {
              collapsedStyle: style,
              mode: "off",
              selfShell: false,
              scheduleAnimation: () => undefined,
            },
          );
          const harness = createToolPresentationHarness(renderers);
          const value = {
            content: [{ type: "text" as const, text: "FULL FAILURE OUTPUT AND RECOVERY" }],
            details: { urlCount: 1, successful: 1 },
          };
          harness.call(args, { expanded: true });
          harness.result(value);
          assert.match(harness.render().join("\n"), /FULL FAILURE OUTPUT AND RECOVERY/);
          const failedCalls = calls;
          harness.invalidate();
          harness.call(args, { expanded: false });
          harness.call(args, { expanded: true });
          assert.match(harness.render().join("\n"), /FULL FAILURE OUTPUT AND RECOVERY/);
          assert.equal(calls, failedCalls);
          fail = false;
          harness.result({ ...value, details: { urlCount: 2, successful: 2 } });
          assert.match(harness.render().join("\n"), /RECOVERED DOWNSTREAM/);
        },
      );
    });

it("keeps downstream component caches and mouse handling separate from adapter wrappers", () => {
  withPresentationSettings(
    { toolCallCollapsedStyle: "preview", toolCallBackground: "off", toolCallTiming: false },
    () => {
      let mouse = 0;
      let reused = false;
      const seen: TuiMouseEvent[] = [];
      const native = {
        render: () => ["OPAQUE LIVE CONTENT"],
        invalidate() {},
        handleMouse(event: TuiMouseEvent) {
          mouse++;
          seen.push(event);
          return { handled: true };
        },
      };
      const renderers = createWebAccessRenderers(
        "web_search",
        {
          renderCall: (_args, _theme, context) => {
            reused ||= context.lastComponent === native;
            return native;
          },
        },
        {
          collapsedStyle: "preview",
          mode: "off",
          selfShell: false,
          scheduleAnimation: () => undefined,
        },
      );
      const harness = createToolPresentationHarness(renderers);
      harness.call({ query: "example" });
      harness.invalidate();
      const rows = harness.render(80);
      const event: TuiMouseEvent = {
        type: "click",
        button: "left",
        x: 0,
        y: 0,
        screenX: 0,
        screenY: 0,
        width: 80,
        height: rows.length,
        shift: false,
        alt: false,
        ctrl: false,
      };
      harness.component?.handleMouse?.(event);
      assert.equal(reused, true);
      assert.equal(mouse, 1);
      harness.call({ query: "example" }, { expanded: true });
      const expandedRows = harness.render(80);
      harness.component?.handleMouse?.({
        ...event,
        y: expandedRows.length - 1,
        height: expandedRows.length,
      });
      assert.equal(mouse, 1, "raw Arguments rows do not route clicks to downstream");
      harness.component?.handleMouse?.({ ...event, height: expandedRows.length });
      assert.equal(mouse, 2);
      assert.equal(seen.at(-1)?.y, 0);
      assert.equal(seen.at(-1)?.height, 1, "downstream receives only its own row bounds");
    },
  );
});
