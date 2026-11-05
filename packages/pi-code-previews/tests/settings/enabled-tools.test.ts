import assert from "node:assert/strict";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { SourceInfo } from "@earendil-works/pi-coding-agent";
import { getEffectiveCodePreviewToolSet, requiredCodePreviewTools } from "../../src/tools/policy";
import { ALL_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../../src/tools/names";
import type { CodePreviewToolStatus } from "../../src/tools/status";
import { enabledToolsSummary } from "../../src/settings/ui/submenus";

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

test("the Enabled tools value counts the previews in effect, as the list shows them", () => {
  const settings = { ...defaultCodePreviewSettings, readContentPreview: false };
  const owner = {
    path: "",
    source: "npm:pi-ripgrep",
    scope: "user",
    origin: "package",
  } satisfies SourceInfo;
  const statuses = new Map<CodePreviewToolName, CodePreviewToolStatus>([
    ["grep", { state: "skipped-conflict", owner }],
  ]);
  const required = requiredCodePreviewTools(settings);
  // read is configured off but a setting keeps it on; grep is configured on but owned elsewhere.
  const configured = new Set<CodePreviewToolName>(["bash", "grep", "write"]);
  assert.equal(
    enabledToolsSummary(configured, statuses, required),
    `3 of ${ALL_CODE_PREVIEW_TOOLS.length}`,
  );
  assert.equal(enabledToolsSummary(new Set(), new Map(), new Map()), "none");
  assert.equal(enabledToolsSummary(new Set(ALL_CODE_PREVIEW_TOOLS), new Map(), new Map()), "all");
});
