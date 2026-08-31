import assert from "node:assert/strict";
import { test } from "vitest";
import { getSecretWarnings } from "../../src/warnings/secrets";

test("getSecretWarnings detects common secret categories", () => {
  for (const value of [
    "OPENAI_API_KEY=sk-abcdefghijklmnopqrstuvwxyz",
    'OPENAI_API_KEY="sk-abcdefghijklmnopqrstuvwxyz"',
    "token=ghp_abcdefghijklmnopqrstuvwxyz123456",
    "-----BEGIN OPENSSH PRIVATE KEY-----",
    "AWS_SECRET_ACCESS_KEY=abcdefghijklmnopqrstuvwx",
    "eyJabcdefghijk.abcdefghijklmnop.abcdefghijklmnop",
  ]) {
    assert.ok(getSecretWarnings(value).length > 0, value);
  }
  assert.equal(getSecretWarnings("hello world").length, 0);
});
