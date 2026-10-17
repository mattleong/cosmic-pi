import assert from "node:assert/strict";
import { test } from "vitest";
import type * as Schema from "effect/Schema";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import { codemodeSubject as subject, nativeReceipt as receipt } from "../support/native-codemode";

const cutAt = (tail: string): string => {
  const framing = '{"padding":"","';
  return `{"padding":"${"x".repeat(197 - framing.length - tail.length)}","${tail}...`;
};

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
