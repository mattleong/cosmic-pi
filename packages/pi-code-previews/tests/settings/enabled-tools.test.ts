import assert from "node:assert/strict";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { getEffectiveCodePreviewToolSet, requiredCodePreviewTools } from "../../src/tools/policy";

test("a tool whose collapsed output a preview setting hides stays enabled, with that setting", () => {
  const settings = {
    ...defaultCodePreviewSettings,
    readContentPreview: false,
    grepResultPreview: false,
  };
  const required = requiredCodePreviewTools(settings);
  assert.equal(required.get("read"), "readContentPreview");
  assert.equal(required.get("grep"), "grepResultPreview");
  // Hiding grep output also hides `grep` run through bash, so bash stays on for it.
  assert.equal(required.get("bash"), "grepResultPreview");
  assert.equal(required.has("write"), false);
  assert.deepEqual(
    Arr.sort([...getEffectiveCodePreviewToolSet(["write"], settings)], Order.String),
    ["bash", "grep", "read", "write"],
  );
});

test("bash names its own result setting first when that is what hides its output", () => {
  const required = requiredCodePreviewTools({
    ...defaultCodePreviewSettings,
    bashResultPreview: false,
    lsResultPreview: false,
  });
  assert.equal(required.get("bash"), "bashResultPreview");
});
