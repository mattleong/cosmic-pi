import assert from "node:assert/strict";
import type { AgentToolResult, ToolRenderers } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { it } from "vitest";
import { createToolPresentationHarness, withPresentationSettings } from "../../../testing";
import { createWebAccessRenderers } from "../../../src/third-party/web-access/render";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { stripAnsi } from "../../support/render";

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

for (const known of [true, false])
  it(`preview/on/${known ? "known" : "unknown"} preserves complete expansion and opaque downstream extras`, () => {
    withPresentationSettings(
      { toolCallCollapsedStyle: "preview", toolCallBackground: "on", toolCallTiming: false },
      () => {
        const details = Object.freeze(
          known
            ? { urlCount: 7, successful: 7, responseId: "private-reference" }
            : { version: "future" },
        );
        const value: AgentToolResult<unknown> = { content, details };
        const harness = createToolPresentationHarness(
          createWebAccessRenderers("fetch_content", downstream, {
            mode: "on",
            collapsedStyle: "preview",
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

for (const failure of ["construct", "draw"] as const)
  it(`preview contains ${failure} failures without replaying the broken renderer or losing raw evidence`, () => {
    withPresentationSettings(
      { toolCallCollapsedStyle: "preview", toolCallBackground: "off", toolCallTiming: false },
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
            collapsedStyle: "preview",
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

const resultOnly: ToolRenderers = {
  renderResult: () => new Text("Sources and cited passages", 0, 0),
};

const indent = (row: string) => row.length - Str.trimStart(row).length;

interface SourceCheckArgs {
  readonly claim: string;
  readonly sources?: number;
}

for (const style of ["preview", "compact"] as const)
  it(`${style}: a heading that shows the only argument whole leaves Arguments out`, () => {
    withPresentationSettings(
      { toolCallCollapsedStyle: style, toolCallBackground: "off", toolCallTiming: false },
      () => {
        const claim = "The provider supports cancellation";
        const render = (input: SourceCheckArgs) => {
          const harness = createToolPresentationHarness(
            createWebAccessRenderers("source_check", resultOnly, {
              mode: "off",
              collapsedStyle: style,
              selfShell: false,
              scheduleAnimation: () => undefined,
            }),
          );
          harness.call(input, { expanded: true });
          harness.result(
            { content: [{ type: "text", text: "Sources and cited passages" }], details: {} },
            { expanded: true },
          );
          return Arr.map(harness.render(100), stripAnsi);
        };
        const only = render({ claim });
        assert.equal(Arr.filter(only, (row) => Str.includes(claim)(row)).length, 1);
        assert.ok(!Arr.some(only, (row) => Str.trim(row) === "Arguments"));
        // The provider's result is a body section, indented past the heading as the others are.
        const heading = Arr.findFirst(only, (row) => Str.includes(claim)(row));
        const body = Arr.findFirst(only, (row) => Str.includes("Sources and cited")(row));
        assert.ok(
          Option.getOrElse(Option.map(body, indent), () => 0) >=
            Option.getOrElse(Option.map(heading, indent), () => 0) + 2,
        );
        const more = render({ claim, sources: 3 });
        assert.ok(Arr.some(more, (row) => Str.trim(row) === "Arguments"));
      },
    );
  });
