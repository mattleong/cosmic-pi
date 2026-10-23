import assert from "node:assert/strict";
import { test } from "vitest";
import type * as Schema from "effect/Schema";
import { nativeArgumentPreview } from "../../src/tools/native-codemode-args";
import { nativeCodemodeCallSubject } from "../../src/tools/native-codemode-subject";
import { codemodeSubject as subject, nativeReceipt as receipt } from "../support/native-codemode";
import * as Str from "effect/String";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";

const cutAt = (tail: string): string => {
  const framing = '{"padding":"","';
  return `{"padding":"${Fn.pipe("x", Str.repeat(197 - framing.length - tail.length))}","${tail}...`;
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
      payload: Arr.reduce<unknown, Schema.JsonObject>(
        Array.from({ length: 20 }),
        {
          text: Fn.pipe("x", Str.repeat(300)),
        },
        (value) => ({ value }),
      ),
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
      { arguments: { password: secret, more: Fn.pipe("x", Str.repeat(300)) }, path: "hidden.ts" },
      { command: `curl --password="${secret} ${Fn.pipe("x", Str.repeat(300))}` },
      { command: `curl -H 'Authorization: ${secret}' ${Fn.pipe("x", Str.repeat(300))}` },
    ]) {
      const raw = receipt(args);
      const preview = nativeArgumentPreview(raw);
      assert.ok(preview);
      const target = nativeCodemodeCallSubject("bash", preview, "/project");
      assert.equal(Fn.pipe(JSON.stringify({ target, preview }), Str.includes(secret)), false);
      assert.equal(Fn.pipe(preview.text, Str.includes("three")), false);
    }
  }
  const escapedKey = nativeArgumentPreview(
    '{"pass\\u0077ord":"one two \\"quoted\\" three","path":"safe.ts"}',
  );
  assert.ok(escapedKey);
  assert.equal(Fn.pipe(escapedKey.text, Str.includes("three")), false);
  const controls = nativeArgumentPreview(receipt({ command: "printf ok\u001b[31m" }));
  assert.equal(Fn.pipe(String(controls?.values.command), Str.includes("\u001b")), false);
});

test("quoted credential names and truncated URI userinfo remain redacted", () => {
  const secret = 'one two three "quoted"';
  for (const command of [
    `curl -d '${JSON.stringify({ password: secret })}'`,
    `curl -d '{"password":"${secret} ${Fn.pipe("z", Str.repeat(400))}`,
    `curl https://user:${Fn.pipe("sensitive-fragment", Str.repeat(30))}@host/path`,
  ]) {
    const preview = nativeArgumentPreview(receipt({ command }));
    assert.ok(preview);
    const target = nativeCodemodeCallSubject("bash", preview, "/project");
    assert.equal(Fn.pipe(JSON.stringify({ preview, target }), Str.includes("three")), false);
    assert.equal(
      Fn.pipe(JSON.stringify({ preview, target }), Str.includes("sensitive-fragment")),
      false,
    );
  }
  const benign = nativeArgumentPreview(receipt({ command: "curl https://host:3000/path" }));
  assert.equal(benign?.values.command, "curl https://host:3000/path");
});

test("nested read ranges treat numeric strings like the numbers Pi coerces them to", () => {
  const path = "/project/a.ts";
  const ranged = subject("read", { path, offset: 120 }).subject;
  assert.notEqual(ranged, subject("read", { path }).subject);
  assert.equal(
    subject("read", { path, offset: "120", limit: "40" }).subject,
    subject("read", { path, offset: 120, limit: 40 }).subject,
  );
  const cut = (tail: string) => {
    const head = `{"path":"${path}","padding":"`;
    const cutReceipt = `${head}${Fn.pipe("x", Str.repeat(197 - head.length - tail.length - 2))}",${tail}...`;
    return nativeCodemodeCallSubject("read", nativeArgumentPreview(cutReceipt), "/project").subject;
  };
  for (const tail of ['"offset":"120","limit":"4', '"offset":120,"limit":4'])
    assert.equal(cut(tail), ranged, tail);
});
