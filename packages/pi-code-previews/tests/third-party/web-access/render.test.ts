import assert from "node:assert/strict";
import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { it } from "vitest";
import { createToolPresentationHarness, withPresentationSettings } from "../../../testing";
import { createWebAccessRenderers } from "../../../src/third-party/web-access/render";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

const downstream: ToolRenderers = {
  renderCall: () => new Text("DOWNSTREAM CALL EXTRAS", 0, 0),
  renderResult: (result) =>
    new Text(
      `DOWNSTREAM RESULT EXTRAS\n${result.content[0]?.type === "text" ? Fn.pipe(result.content[0].text, Str.slice(0, 200)) : ""}`,
      0,
      0,
    ),
};
const args = Object.freeze({
  urls: Array.from({ length: 7 }, (_, index) => `https://example.test/${index}`),
  prompt: `Exact prompt ${Fn.pipe("padding ", Str.repeat(80))}ARGUMENT_TAIL`,
  mode: "raw",
  auth: "browser-profile",
  proxy: "https://proxy.test",
});
const image = Object.freeze({ type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" });
const content: AgentToolResult<unknown>["content"] = [
  Object.freeze({
    type: "text" as const,
    text: `${Fn.pipe("Page text ", Str.repeat(100))}OUTPUT_TAIL`,
  }),
  Object.freeze({
    type: "text" as const,
    text: "RECOVERY_TAIL use the stored reference private-reference",
  }),
  image,
];
Object.freeze(content);

for (const style of ["preview"] as const)
  for (const mode of ["on"] as const)
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
            const value: AgentToolResult<unknown> = { content, details };
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
            for (const frame of Arr.filter(frames, (entry) => entry.expanded)) {
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
                assert.ok(Fn.pipe(frame.text, Str.includes(marker)), marker);
            }
            assert.equal(value.content, content);
            assert.equal(value.details, details);
            assert.equal(value.content[2], image);
          },
        );
      });

for (const style of ["preview"] as const)
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
          assert.match(Arr.join(harness.render(), "\n"), /FULL FAILURE OUTPUT AND RECOVERY/);
          const failedCalls = calls;
          harness.invalidate();
          harness.call(args, { expanded: false });
          harness.call(args, { expanded: true });
          assert.match(Arr.join(harness.render(), "\n"), /FULL FAILURE OUTPUT AND RECOVERY/);
          assert.equal(calls, failedCalls);
          fail = false;
          harness.result({ ...value, details: { urlCount: 2, successful: 2 } });
          assert.match(Arr.join(harness.render(), "\n"), /RECOVERED DOWNSTREAM/);
        },
      );
    });
