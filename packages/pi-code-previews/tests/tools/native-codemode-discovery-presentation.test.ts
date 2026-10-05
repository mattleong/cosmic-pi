import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { test } from "vitest";
import {
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
  withPresentationSettings,
} from "../../testing";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";
import { nativeDiscoveryNote } from "../../src/tools/native-codemode-discovery";
import { createNativeCodemodeRenderers } from "../../src/tools/native-codemode-render";
import { compactStatus } from "../../src/tools/compact-summary";

const discovery = 'text(await describeNamespace("mcp__chrome_devtools"));';
const mixed = `${discovery}\ntext(await tools.read({ path: "/project/source.ts" }));`;
const dispatch = (name = "read", status = "ok", id = "private/1") => ({
  id,
  name,
  status,
  args: '{"path":"/project/source.ts"}',
  durationMs: 4,
});
const result = (calls: unknown[] = [], state = "completed"): AgentToolResult<unknown> => ({
  content: [
    { type: "text", text: `Script ${state}\nWall time 0.027 seconds\nOutput:\n` },
    { type: "text", text: "OUTPUT_HEAD\nOUTPUT_TAIL\nRECOVERY_TAIL" },
  ],
  details: { calls },
});
const summarize = (code: string, value: AgentToolResult<unknown>, isError = false) =>
  nativeCodemodeSummary("/project")({
    args: { code },
    phase: "settled",
    result: value,
    context: renderContextFixture({ args: { code }, isError, isPartial: false }),
  });

test("pure discovery replaces only a confirmed-empty dispatch counter with a source-intent hint", () => {
  for (const code of [discovery, 'text(await describeTool("read"));']) {
    const projected = summarize(code, result())!;
    assert.ok(projected.action);
    assert.deepEqual(projected.counters, []);
    assert.deepEqual(projected.children?.entries, []);
    assert.equal(projected.outcome, "success");
    assert.deepEqual(issueMessageStyleProblems(nativeDiscoveryNote), []);
  }
  assert.equal(summarize("return 1;", result())?.counters?.length, 1);
  assert.equal(summarize(mixed, result())?.counters?.length, 1);
});

test("mixed discovery keeps exactly the observed dispatches, not synthetic helper calls", () => {
  const value = result([dispatch("read"), dispatch("mcp__docs__lookup", "ok", "private/2")]);
  const before = structuredClone(value);
  const projected = summarize(mixed, value)!;
  assert.ok(projected.action);
  assert.match(projected.counters?.[0] ?? "", /\b2\b/);
  assert.equal(projected.children?.total, 2);
  assert.equal(projected.children?.entries.length, 2);
  assert.ok(projected.children?.entries.every((child) => child.status === "returned"));
  assert.deepEqual(value, before);
  const noSourceIntent = summarize("return 1;", {
    ...value,
    content: [...value.content, { type: "text", text: discovery }],
  })!;
  assert.equal(noSourceIntent.action, undefined);
});

test("source intent cannot hide unavailable or incomplete ledgers or rewrite outcomes", () => {
  for (const details of [
    undefined,
    {},
    { calls: [null] },
    { calls: Array.from({ length: 257 }, () => dispatch()) },
  ]) {
    const projected = summarize(discovery, { ...result(), details })!;
    assert.equal(projected.outcome, "uncertain");
    assert.equal(
      projected.issues?.find((issue) => issue.code === "native-call-evidence-incomplete")?.severity,
      "warning",
    );
  }
  for (const status of ["running", "cancelled"])
    assert.equal(summarize(discovery, result([dispatch("read", status)]))?.outcome, "uncertain");
  assert.equal(summarize(discovery, result(), true)?.outcome, "uncertain");
  assert.equal(summarize(discovery, result([], "failed"), true)?.outcome, "error");
  assert.equal(summarize(discovery, result([dispatch("read", "error")]))?.outcome, "warning");
  assert.equal(
    summarize(discovery, {
      ...result(),
      content: [{ type: "text", text: "unknown native header" }],
    }),
    undefined,
  );
  assert.equal(compactStatus("settled", summarize(discovery, result())!), "success");
});

for (const style of ["compact", "preview"] as const)
  for (const mode of ["off", "on", "border"] as const)
    test(`${style}/${mode} retains discovery intent, real calls, full source/output/recovery, and images through expansion`, () => {
      withPresentationSettings(
        {
          syntaxHighlighting: false,
          toolCallCollapsedStyle: style,
          toolCallBackground: mode,
          toolCallTiming: false,
        },
        () => {
          const renderers = createNativeCodemodeRenderers("/project", {
            mode,
            collapsedStyle: style,
            scheduleAnimation: () => undefined,
          });
          const code = `${mixed}\n// SOURCE_TAIL`;
          const value = result([
            dispatch("read"),
            dispatch("mcp__docs__lookup", "ok", "private/2"),
          ]);
          const image = { type: "image" as const, data: "aW1hZ2U=", mimeType: "image/png" };
          value.content.push(image);
          const before = structuredClone(value);
          const projected = summarize(code, value)!;
          const heading = projected.action!;
          const harness = createToolPresentationHarness(renderers);
          for (const frame of harness.cycle({ code }, value, {
            invalidate: "before",
            overrides: () => ({ showImages: false }),
          })) {
            assert.ok(frame.text.includes(heading));
            if (!frame.expanded) assert.ok(frame.text.includes(projected.counters![0]!));
            else
              for (const marker of [
                "SOURCE_TAIL",
                "OUTPUT_HEAD",
                "OUTPUT_TAIL",
                "RECOVERY_TAIL",
                "source.ts",
                "image/png",
                nativeDiscoveryNote,
              ])
                assert.ok(frame.text.includes(marker), marker);
          }
          assert.deepEqual(value, before);
          assert.equal(value.content.at(-1), image);
        },
      );
    });

for (const style of ["compact", "preview"] as const)
  test(`${style} keeps the source-intent note when an unknown header declines semantic completion`, () => {
    withPresentationSettings(
      {
        syntaxHighlighting: false,
        toolCallCollapsedStyle: style,
        toolCallBackground: "off",
        toolCallTiming: false,
      },
      () => {
        const value = {
          ...result(),
          content: [{ type: "text" as const, text: "Unrecognized native header\nRAW_OUTPUT_TAIL" }],
        };
        const code = `${discovery}\n// SOURCE_TAIL`;
        assert.equal(summarize(code, value), undefined);
        const harness = createToolPresentationHarness(
          createNativeCodemodeRenderers("/project", {
            collapsedStyle: style,
            scheduleAnimation: () => undefined,
          }),
        );
        for (const frame of harness.cycle({ code }, value)) {
          assert.equal(frame.text.includes(nativeDiscoveryNote), frame.expanded);
          if (frame.expanded)
            for (const marker of ["SOURCE_TAIL", "RAW_OUTPUT_TAIL"])
              assert.ok(frame.text.includes(marker), marker);
        }
      },
    );
  });

test("discovery annotations survive a failed theme without changing source or result", () => {
  withPresentationSettings(
    {
      syntaxHighlighting: false,
      toolCallCollapsedStyle: "preview",
      toolCallBackground: "off",
      toolCallTiming: false,
    },
    () => {
      const broken = opaqueFixture({
        ...plainTheme,
        fg: () => {
          throw new Error("theme failed");
        },
      });
      const harness = createToolPresentationHarness(
        createNativeCodemodeRenderers("/project", { scheduleAnimation: () => undefined }),
        { theme: broken },
      );
      const code = `${discovery}\n// SOURCE_TAIL`;
      harness.call({ code }, { expanded: true });
      harness.result(result());
      for (const marker of ["SOURCE_TAIL", "OUTPUT_TAIL", "RECOVERY_TAIL", nativeDiscoveryNote])
        assert.ok(harness.render(80).join("\n").includes(marker), marker);
    },
  );
});
