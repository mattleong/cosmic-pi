import assert from "node:assert/strict";
import { beforeEach, test } from "vitest";
import {
  applyPresentationSettings,
  issueMessageStyleProblems,
  renderContextFixture,
} from "../../testing";
import {
  nativeToolSearchReceipt,
  nativeToolSearchSubject,
  nativeToolSearchSummary,
} from "../../src/tools/native-tool-search-summary";
import { hostContainer } from "../../src/shared/untrusted-value";

beforeEach(() => applyPresentationSettings({ toolCallTiming: false }));

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
  const inheritedReceipt = hostContainer(Object.create({ loaded: [] }));
  for (const details of [accessor, inheritedReceipt, { loaded: slot }, hostile])
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
  assert.equal(nativeToolSearchSubject(hostContainer(Object.create({ query: "inherited" }))), "");
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
  for (const query of ["", " \t", "\u0007", "\u001b[2J"])
    assert.equal(nativeToolSearchSubject({ query }), "");
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
