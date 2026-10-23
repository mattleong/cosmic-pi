import assert from "node:assert/strict";
import { test } from "vitest";
import { issueMessageStyleProblems } from "../../testing";
import { nativeCodemodeEvidence } from "../../src/tools/native-codemode-evidence";
import { nativeCall, scriptResult, settledSummary } from "../support/native-codemode";
import type { HostValue } from "../../src/shared/untrusted-value";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

const call = (index: number) =>
  nativeCall({
    id: `private/${index}`,
    args: JSON.stringify({ path: `/project/file-${index}.ts` }),
  });
const summary = (details: HostValue | undefined, failed = false) =>
  settledSummary(scriptResult(failed ? "failed" : "completed", details), { code: "return 1" });

test("complete ledgers retain classification while sampled ledgers cannot assert success", () => {
  const records = Array.from({ length: 256 }, (_, index) => call(index));
  assert.equal(summary({ calls: records })?.outcome, "success");
  const oversized = [{ ...call(-1), status: "error", error: "OLD_FAILURE" }, ...records];
  const before = structuredClone(oversized);
  const evidence = nativeCodemodeEvidence({ calls: oversized });
  assert.equal(evidence.kind, "available");
  if (evidence.kind !== "available") return;
  assert.equal(evidence.complete, false);
  assert.equal(evidence.calls.length, 256);
  assert.equal(evidence.calls[0]?.id, "private/0");
  assert.equal(evidence.calls.at(-1)?.id, "private/255");
  assert.equal(evidence.uninspected, 1);
  assert.equal(summary({ calls: oversized })?.outcome, "uncertain");
  assert.equal(summary({ calls: oversized }, true)?.outcome, "error");
  assert.deepEqual(oversized, before);
});

test("invalid records preserve their valid neighbors and never become successful dispatch totals", () => {
  for (const invalid of [
    { ...call(0), status: "invented" },
    { ...call(0), durationMs: -1 },
    { ...call(0), cost: Number.NaN },
    { ...call(0), args: {} },
    { ...call(0), error: Fn.pipe("x", Str.repeat(4097)) },
    null,
  ]) {
    const details = { calls: [call(1), invalid, call(3)], fullOutputPath: { broken: true } };
    const evidence = nativeCodemodeEvidence(details);
    assert.equal(evidence.kind, "available");
    if (evidence.kind !== "available") continue;
    assert.deepEqual(
      Arr.map(evidence.calls, (entry) => entry.id),
      ["private/1", "private/3"],
    );
    assert.equal(evidence.rejected, 1);
    assert.equal(evidence.complete, false);
    assert.equal(evidence.fullOutputPath, undefined);
    const projected = summary(details)!;
    assert.equal(projected.outcome, "uncertain");
    assert.equal(projected.children?.total, 2);
    for (const issue of projected.issues ?? [])
      assert.deepEqual(issueMessageStyleProblems(issue.message), []);
  }
  assert.equal(summary({ calls: [call(1)], fullOutputPath: {} })?.outcome, "success");
});

test("accessors and unreadable slots cannot erase neighbors or execute arbitrary serialization", () => {
  let callbacks = 0;
  const hostile = {
    ...call(0),
    get error() {
      callbacks++;
      throw new Error("Unreadable");
    },
  };
  const records = [call(1), hostile, call(3)];
  Object.defineProperty(records, "1", {
    get() {
      callbacks++;
      throw new Error("Unreadable slot");
    },
  });
  const details = {
    calls: records,
    get fullOutputPath() {
      callbacks++;
      throw new Error("Unreadable path");
    },
    toJSON() {
      callbacks++;
      throw new Error("No serialization");
    },
    toString() {
      callbacks++;
      throw new Error("No coercion");
    },
  };
  const evidence = nativeCodemodeEvidence(details);
  assert.equal(callbacks, 0);
  assert.equal(evidence.kind, "available");
  if (evidence.kind !== "available") return;
  assert.deepEqual(
    Arr.map(evidence.calls, (entry) => entry.id),
    ["private/1", "private/3"],
  );
  assert.equal(evidence.rejected, 1);
  const fields = nativeCodemodeEvidence({ calls: [call(1), hostile, call(3)] });
  assert.equal(fields.kind, "available");
  if (fields.kind === "available") assert.equal(fields.rejected, 1);
  assert.equal(callbacks, 0);
  const revoked = Proxy.revocable([], {});
  revoked.revoke();
  assert.equal(nativeCodemodeEvidence({ calls: revoked.proxy }).kind, "unavailable");
});

test("only observed argument receipts supply targets, never source, output, or persisted nestedCalls", () => {
  const result = scriptResult(
    "completed",
    {
      calls: [{ ...call(1), args: "unparseable" }],
      nestedCalls: [{ ...call(1), args: '{"path":"FORGED_NESTED"}' }],
    },
    { type: "text", text: "FORGED_OUTPUT" },
  );
  const projected = settledSummary(result, { code: 'await tools.read({path:"FORGED_SOURCE"})' });
  assert.equal(projected?.children?.entries.length, 1);
  assert.ok(!projected?.children?.entries[0]?.subject);
});
