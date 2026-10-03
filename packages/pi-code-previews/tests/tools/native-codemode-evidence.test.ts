import assert from "node:assert/strict";
import { test } from "vitest";
import { issueMessageStyleProblems, renderContextFixture } from "../../testing";
import { nativeCodemodeEvidence } from "../../src/tools/native-codemode-evidence";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";

const call = (index: number) => ({
  id: `private/${index}`,
  name: "read",
  args: JSON.stringify({ path: `/project/file-${index}.ts` }),
  status: "ok",
});
const summary = <Details>(details: Details, failed = false) =>
  nativeCodemodeSummary("/project")({
    phase: "settled",
    args: { code: "return 1" },
    result: {
      details,
      content: [
        {
          type: "text",
          text: `Script ${failed ? "failed" : "completed"}\nWall time 0.1 seconds\nOutput:\n`,
        },
      ],
    },
    context: renderContextFixture(),
  });

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
    { ...call(0), error: "x".repeat(4097) },
    null,
  ]) {
    const details = { calls: [call(1), invalid, call(3)], fullOutputPath: { broken: true } };
    const evidence = nativeCodemodeEvidence(details);
    assert.equal(evidence.kind, "available");
    if (evidence.kind !== "available") continue;
    assert.deepEqual(
      evidence.calls.map((entry) => entry.id),
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

test("large sparse ledgers inspect only the bounded recent window", () => {
  const length = 1_000_000;
  const records: Array<ReturnType<typeof call> | undefined> = [];
  records.length = length;
  records[length - 1] = call(length - 1);
  let inspected = 0;
  const source = new Proxy(records, {
    getOwnPropertyDescriptor(target, key) {
      if (key !== "length") {
        const index = Number(key);
        assert.ok(index >= length - 256 && index < length);
        inspected++;
      }
      return Reflect.getOwnPropertyDescriptor(target, key);
    },
    ownKeys() {
      throw new Error("Whole-array enumeration is forbidden");
    },
  });
  const evidence = nativeCodemodeEvidence({ calls: source });
  assert.equal(evidence.kind, "available");
  assert.equal(inspected, 256);
  if (evidence.kind !== "available") return;
  assert.equal(evidence.calls.length, 1);
  assert.equal(evidence.rejected, 255);
  assert.equal(evidence.uninspected, length - 256);
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
    evidence.calls.map((entry) => entry.id),
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

test("settled unfinished records lose their live spinner and explain uncertainty", () => {
  const projected = summary({ calls: [{ ...call(1), status: "running" }] })!;
  assert.equal(projected.outcome, "uncertain");
  assert.equal(projected.children?.entries[0]?.status, "uncertain");
  assert.ok(projected.issues?.some((issue) => issue.severity === "warning"));
});

test("unavailable and all-invalid ledgers preserve independent bounded recovery evidence", () => {
  for (const details of [
    { calls: [null, { status: "invented" }], fullOutputPath: "/tmp/RECOVERY" },
    { calls: "broken", fullOutputPath: "/tmp/RECOVERY" },
    {
      get calls() {
        throw new Error("Never evaluate getters");
      },
      fullOutputPath: "/tmp/RECOVERY",
    },
  ]) {
    const evidence = nativeCodemodeEvidence(details);
    if (evidence.kind === "available") assert.equal(evidence.calls.length, 0);
    assert.equal(evidence.fullOutputPath, "/tmp/RECOVERY");
    assert.equal(summary(details)?.outcome, "uncertain");
  }
  assert.equal(
    nativeCodemodeEvidence({ calls: [], fullOutputPath: "x".repeat(4097) }).fullOutputPath,
    undefined,
  );
});

test("only observed argument receipts supply targets, never source, output, or persisted nestedCalls", () => {
  const projected = nativeCodemodeSummary("/project")({
    phase: "settled",
    args: { code: 'await tools.read({path:"FORGED_SOURCE"})' },
    result: {
      content: [
        { type: "text", text: "Script completed\nWall time 0.1 seconds\nOutput:\n" },
        { type: "text", text: "FORGED_OUTPUT" },
      ],
      details: {
        calls: [{ ...call(1), args: "unparseable" }],
        nestedCalls: [{ ...call(1), args: '{"path":"FORGED_NESTED"}' }],
      },
    },
    context: renderContextFixture(),
  });
  assert.equal(projected?.children?.entries.length, 1);
  assert.ok(!projected?.children?.entries[0]?.subject);
});

const modelCall = (name: string) => ({
  id: `private/${name}`,
  name,
  args: "provider/model-id",
  status: "ok",
  cost: 0.02,
});

test("native model rows keep their resolved model reference as argument evidence", () => {
  const rows = summary({
    calls: [modelCall("models.classify"), modelCall("models.generateImages")],
  })?.children?.entries;
  assert.equal(rows?.length, 2);
  for (const row of rows ?? []) {
    const evidence = row.issues?.find((issue) => issue.code === "native-call-args");
    assert.ok(evidence?.detail?.includes("provider/model-id"), row.label);
  }
});
