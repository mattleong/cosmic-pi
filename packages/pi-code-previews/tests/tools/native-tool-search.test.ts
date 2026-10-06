import assert from "node:assert/strict";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { opaqueFixture, plainTheme } from "pi-cosmic-core/testing";
import { stripAnsi } from "pi-cosmic-core";
import { afterEach, test } from "vitest";
import {
  animationSchedulerProbe,
  applyPresentationSettings,
  createToolPresentationHarness,
  issueMessageStyleProblems,
  renderContextFixture,
} from "../../testing";
import { createNativeToolSearchRenderers } from "../../src/tools/native-tool-search-render";
import {
  nativeToolSearchReceipt,
  nativeToolSearchSubject,
  nativeToolSearchSummary,
} from "../../src/tools/native-tool-search-summary";

let restore = () => {};
afterEach(() => restore());
const result = <Details>(details: Details): AgentToolResult<unknown> => ({
  content: [
    { type: "text", text: "RAW_OUTPUT\nRead the returned tool instructions before calling it" },
  ],
  details,
});
const summary = <Details>(details: Details) =>
  nativeToolSearchSummary({
    phase: "settled",
    args: { query: "documentation" },
    result: result(details),
    context: renderContextFixture({ isPartial: false }),
  });

test("loaded receipts give neutral listing counts, not current activation or success", () => {
  for (const loaded of [[], ["docs_lookup"], ["docs_lookup", "docs_list"]]) {
    const value = summary({ loaded });
    assert.equal(value?.outcome, "returned");
    assert.match(value?.counters?.[0] ?? "", new RegExp(`\\b${loaded.length}\\b`));
  }
  for (const details of [
    undefined,
    null,
    {},
    [],
    { loaded: "tool" },
    { loaded: [42] },
    { loaded: [""] },
    { loaded: [" "] },
    { loaded: ["x".repeat(257)] },
    { loaded: Array(257).fill("x") },
    { loaded: Array(1) },
  ])
    assert.equal(summary(details), undefined);
});

test("receipt and query inspection reject inherited data, accessors, and throwing proxies", () => {
  let reads = 0;
  const accessor = {
    get loaded() {
      reads++;
      return [];
    },
  };
  const slot = Object.defineProperty(["x"], "0", {
    get() {
      reads++;
      return "x";
    },
  });
  const hostile = new Proxy(
    {},
    {
      getOwnPropertyDescriptor() {
        throw new Error("hostile receipt");
      },
    },
  );
  for (const details of [accessor, Object.create({ loaded: [] }), { loaded: slot }, hostile])
    assert.equal(nativeToolSearchReceipt(details), undefined);
  assert.equal(
    nativeToolSearchSubject({
      get query() {
        reads++;
        return "hidden";
      },
    }),
    "",
  );
  assert.equal(nativeToolSearchSubject(Object.create({ query: "inherited" })), "");
  assert.equal(nativeToolSearchSubject(hostile), "");
  const details = {
    loaded: ["docs_lookup"],
    get fullOutputPath() {
      reads++;
      throw new Error("unrelated field");
    },
  };
  assert.deepEqual(nativeToolSearchReceipt(details), { loaded: ["docs_lookup"] });
  assert.equal(reads, 0);
  const subject = nativeToolSearchSubject({ query: "query\u001b[2J\n" + "padding ".repeat(1000) });
  assert.ok(subject.length <= 160);
  for (const control of ["\u001b", "\n", "\r"]) assert.equal(subject.includes(control), false);
});

test("errors use human issues and preserve all recovery text without invented spill evidence", () => {
  for (const error of [
    "Error: Search unavailable.\nRetry with another query.",
    "Call tools.tool_search({query:'x'}) to retry",
  ]) {
    const value = nativeToolSearchSummary({
      phase: "settled",
      args: { query: "docs" },
      result: {
        content: [{ type: "text", text: error }],
        details: { fullOutputPath: "/do-not-read" },
      },
      context: renderContextFixture({ isError: true, isPartial: false }),
    });
    assert.equal(value?.outcome, "error");
    assert.equal(value?.counters, undefined);
    assert.equal(value?.issues?.length, 1);
    for (const issue of value?.issues ?? [])
      assert.deepEqual(issueMessageStyleProblems(issue.message), []);
  }
});

for (const style of ["preview", "compact"] as const)
  for (const mode of ["on", "off", "border"] as const)
    for (const evidence of ["valid", "malformed", "error"] as const)
      test(`${style}/${mode}/${evidence} preserves exact expansion, result identity, and native images`, () => {
        restore = applyPresentationSettings({
          toolCallCollapsedStyle: style,
          toolCallBackground: mode,
          toolCallTiming: false,
        });
        const renderers = createNativeToolSearchRenderers({
          scheduleAnimation: () => undefined,
          selfShell: true,
        });
        assert.equal(renderers.renderShell, "self");
        const h = createToolPresentationHarness(renderers);
        const args = {
          query: "QUERY_HEAD " + "padding ".repeat(90) + "QUERY_TAIL",
          limit: 17,
          extra: { value: "EXTRA_ARGUMENT" },
        };
        const image = {
          type: "image" as const,
          mimeType: "image/png",
          data: "UNCHANGED_NATIVE_IMAGE",
        };
        const raw: AgentToolResult<unknown> = {
          content: [
            { type: "text", text: "RAW_OUTPUT_HEAD\n" + "line\n".repeat(20) + "RAW_OUTPUT_TAIL" },
            image,
            { type: "text", text: "Call the discovered tool with RECOVERY_TEXT" },
          ],
          details:
            evidence === "valid"
              ? { loaded: ["docs_lookup"] }
              : { loaded: "unknown", fullOutputPath: "/NOT_A_NATIVE_RECEIPT" },
        };
        const before = structuredClone(raw);
        for (const expanded of [false, true, false, true]) {
          h.call(args, { expanded });
          h.result(raw, { expanded, isError: evidence === "error", showImages: true });
          const lines = h.render(80);
          assert.ok(lines.every((line) => visibleWidth(line) <= 80));
          const text = stripAnsi(lines.join("\n"));
          assert.equal(text.includes("QUERY_TAIL"), expanded);
          assert.equal(text.includes("UNCHANGED_NATIVE_IMAGE"), false);
          assert.equal(text.includes("/NOT_A_NATIVE_RECEIPT"), false);
          if (expanded)
            for (const marker of [
              "EXTRA_ARGUMENT",
              '"limit": 17',
              "RAW_OUTPUT_HEAD",
              "RAW_OUTPUT_TAIL",
              "RECOVERY_TEXT",
            ])
              assert.ok(text.includes(marker), marker);
          else assert.doesNotMatch(text, /RECOVERY_TEXT|RAW_OUTPUT_TAIL/);
        }
        assert.deepEqual(raw, before);
        assert.equal(raw.content[1], image);
      });

test("theme failures preserve complete input, output, and human issues", () => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false });
  const h = createToolPresentationHarness(
    createNativeToolSearchRenderers({ scheduleAnimation: () => undefined }),
    {
      theme: opaqueFixture({
        ...plainTheme,
        fg() {
          throw new Error("theme unavailable");
        },
      }),
    },
  );
  h.call({ query: "EXACT_QUERY", limit: 3, extra: "EXACT_EXTRA" }, { expanded: true });
  h.result(
    {
      content: [{ type: "text", text: "Error: Search unavailable\nRECOVERY_TEXT" }],
      details: undefined,
    },
    { expanded: true, isError: true },
  );
  const text = h.render(80).join("\n");
  for (const marker of ["EXACT_QUERY", "EXACT_EXTRA", "RECOVERY_TEXT", "Search unavailable"])
    assert.ok(text.includes(marker), marker);
});

test("pending and running rows use injected animation, settled rows stop it", () => {
  restore = applyPresentationSettings({ toolCallCollapsedStyle: "preview", toolCallTiming: false });
  const probe = animationSchedulerProbe();
  const h = createToolPresentationHarness(
    createNativeToolSearchRenderers({ scheduleAnimation: probe.schedule }),
  );
  h.call({ query: "docs" });
  assert.equal(probe.scheduled, 0);
  h.call({ query: "docs" }, { executionStarted: true });
  h.result(result(undefined), { isPartial: true });
  h.render(80);
  assert.ok(probe.scheduled > 0);
  h.result(result({ loaded: [] }));
  h.render(80);
  assert.equal(probe.stops, probe.scheduled);
});
