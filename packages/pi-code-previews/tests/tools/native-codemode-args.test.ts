import assert from "node:assert/strict";
import { test } from "vitest";
import type * as Schema from "effect/Schema";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import {
  codemodeSubject as subject,
  nativeCall,
  nativeReceipt as receipt,
  scriptResult,
  settledSummary,
} from "../support/native-codemode";

const cutAt = (tail: string): string => {
  const framing = '{"padding":"","';
  return `{"padding":"${"x".repeat(197 - framing.length - tail.length)}","${tail}...`;
};

for (const tool of ["edit", "write"])
  test(`${tool} retains a complete leading path when later payload is truncated`, () => {
    const args = {
      path: "/project/src/file.ts",
      edits: [{ oldText: "old".repeat(200), newText: "new" }],
    };
    assert.equal(subject(tool, args).subject, "src/file.ts");
    const preview = nativeArgumentPreview(receipt(args));
    assert.equal(preview?.values.path, args.path);
    assert.equal(preview?.partialFields.has("path"), false);
  });

for (const tool of ["bash", "edit"])
  test(`${tool} explicitly marks a target cut inside a string`, () => {
    const field = tool === "bash" ? "command" : "path";
    const value = tool === "bash" ? "pnpm test ".repeat(60) : "/project/src/" + "a".repeat(300);
    const preview = nativeArgumentPreview(receipt({ [field]: value }));
    assert.ok(preview);
    assert.equal(preview.partialFields.has(field), true);
    const target = nativeCodemodeCallSubject(tool, preview, "/project").subject;
    assert.ok(target && target.endsWith("…"));
    assert.ok(value.includes(String(preview.values[field])));
  });

test("prefix recovery neither searches past the cut nor promotes nested/string-embedded fields", () => {
  for (const args of [
    { edits: [{ oldText: "x".repeat(300) }], path: "/project/hidden.ts" },
    { arguments: { path: "/project/nested.ts", text: "x".repeat(300) } },
    { note: '"path":"/project/fake.ts"' + "x".repeat(300) },
  ]) {
    assert.equal(subject("edit", args).subject, "");
    assert.equal(nativeArgumentPreview(receipt(args))?.values.path, undefined);
  }
});

test("complete escapes are decoded while unfinished escapes and surrogate pairs are not guessed", () => {
  const command = 'printf "hello\\world"\nnext';
  const preview = nativeArgumentPreview(receipt({ command }));
  assert.equal(preview?.values.command, 'printf "hello\\world" next');
  for (const suffix of ["\\", "\\u12", "\\uD83D"]) {
    const partial = nativeArgumentPreview(cutAt(`command":"safe ${suffix}`));
    assert.equal(partial?.values.command, "safe");
    assert.equal(partial?.partialFields.has("command"), true);
  }
  const completeUnicode = nativeArgumentPreview('{"path":"src/\\u0061.ts"}');
  assert.equal(completeUnicode?.values.path, "src/a.ts");
});

test("malformed receipts, duplicate keys, and excessive nesting fail closed", () => {
  for (const args of [
    '{"path":"cut...',
    '{"path":"a","path":"b"}',
    '[{"path":"a"}]',
    cutAt('path":"bad\\q'),
    cutAt('path":"bad\\u12z'),
    cutAt('path":"a", "payload":garbage'),
    receipt({
      path: "a",
      payload: Array.from({ length: 20 }).reduce<Schema.JsonObject>((value) => ({ value }), {
        text: "x".repeat(300),
      }),
    }),
  ])
    assert.equal(nativeArgumentPreview(args), undefined);
  assert.equal(subject("edit", { path: "literal...ts" }).subject, "literal...ts");
});

test("incomplete numbers and missing fields do not invent read ranges or default targets", () => {
  const preview = nativeArgumentPreview(cutAt('path":"/project/a.ts","offset":12'));
  assert.equal(preview?.values.offset, undefined);
  assert.equal(nativeCodemodeCallSubject("read", preview, "/project").subject, "a.ts");
  for (const tool of ["grep", "find", "ls"])
    assert.equal(subject(tool, { payload: "x".repeat(300) }).subject, "");
});

test("background calls show only their observed argument action and target", () => {
  assert.equal(
    subject("background_task", { action: "start", name: "Verify previews", command: "pnpm test" })
      .subject,
    "Verify previews",
  );
  assert.equal(
    subject("background_task", {
      action: "start",
      command: "pnpm test ".repeat(40),
    }).subject?.endsWith("…"),
    true,
  );
  assert.equal(
    subject("background_task", { action: "wait", until: "exit", id: "private-task-id" }).subject,
    "for exit",
  );
  assert.equal(subject("background_task", { action: "status", id: "private-task-id" }).subject, "");
});

test("decoded credentials, including cut and escaped strings, cannot leak into subjects or previews", () => {
  for (const secret of [
    'one two "quoted" three',
    "Bearer secret-value-123456",
    "sk-private-value-123456",
  ]) {
    for (const args of [
      { password: secret, path: "src/file.ts" },
      { arguments: { password: secret, more: "x".repeat(300) }, path: "hidden.ts" },
      { command: `curl --password="${secret} ${"x".repeat(300)}` },
      { command: `curl -H 'Authorization: ${secret}' ${"x".repeat(300)}` },
    ]) {
      const raw = receipt(args);
      const preview = nativeArgumentPreview(raw);
      assert.ok(preview);
      const target = nativeCodemodeCallSubject("bash", preview, "/project");
      assert.equal(JSON.stringify({ target, preview }).includes(secret), false);
      assert.equal(preview.text.includes("three"), false);
    }
  }
  const escapedKey = nativeArgumentPreview(
    '{"pass\\u0077ord":"one two \\"quoted\\" three","path":"safe.ts"}',
  );
  assert.ok(escapedKey);
  assert.equal(escapedKey.text.includes("three"), false);
  const controls = nativeArgumentPreview(receipt({ command: "printf ok\u001b[31m" }));
  assert.equal(String(controls?.values.command).includes("\u001b"), false);
});

test("quoted credential names and truncated URI userinfo remain redacted", () => {
  const secret = 'one two three "quoted"';
  for (const command of [
    `curl -d '${JSON.stringify({ password: secret })}'`,
    `curl -d '{"password":"${secret} ${"z".repeat(400)}`,
    `curl https://user:${"sensitive-fragment".repeat(30)}@host/path`,
  ]) {
    const preview = nativeArgumentPreview(receipt({ command }));
    assert.ok(preview);
    const target = nativeCodemodeCallSubject("bash", preview, "/project");
    assert.equal(JSON.stringify({ preview, target }).includes("three"), false);
    assert.equal(JSON.stringify({ preview, target }).includes("sensitive-fragment"), false);
  }
  const benign = nativeArgumentPreview(receipt({ command: "curl https://host:3000/path" }));
  assert.equal(benign?.values.command, "curl https://host:3000/path");
});

const call = (id: string, name: string, args: Schema.JsonObject) =>
  nativeCall({ id, name, args: receipt(args) });

test("subject recovery leaves native receipts unchanged and never reads plausible guest output", () => {
  const result = scriptResult(
    "completed",
    {
      calls: [
        call("edit/1", "edit", { path: "actual.ts", edits: [{ oldText: "x".repeat(300) }] }),
        call("edit/2", "edit", { edits: [{ oldText: "x".repeat(300) }], path: "hidden.ts" }),
        // Invariant: a target with nothing visible leaves the row without a subject.
        call("task/1", "background_task", { action: "start", name: " \t" }),
      ],
    },
    { type: "text", text: '{"path":"guessed.ts","command":"guessed command"}' },
  );
  const before = structuredClone(result);
  const projected = settledSummary(result);
  assert.equal(projected?.children?.entries[0]?.subject, "actual.ts");
  assert.equal(projected?.children?.entries[1]?.subject, "");
  assert.equal(projected?.children?.entries[2]?.subject, "");
  assert.deepEqual(result, before);
});
