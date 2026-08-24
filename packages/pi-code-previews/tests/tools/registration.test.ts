import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  SourceInfo,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { afterEach, test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { ALL_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../../src/tools/names";
import { registerToolRenderers } from "../../src/tools/renderers/registration";
import { getCodePreviewToolStatuses } from "../../src/tools/status";

const builtinSource: SourceInfo = {
  path: "builtin",
  source: "builtin",
  scope: "temporary",
  origin: "top-level",
};

const extensionSource: SourceInfo = {
  path: "/extensions/owner.ts",
  source: "owner",
  scope: "user",
  origin: "top-level",
};

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

function toolInfo(name: string, sourceInfo: SourceInfo = builtinSource): ToolInfo {
  return {
    name,
    description: `${name} tool`,
    // SAFETY: Registration discovery reads only the tool name and source metadata.
    parameters: {} as ToolInfo["parameters"],
    sourceInfo,
  };
}

function piFixture(
  options: {
    getAllTools?: () => ToolInfo[];
    registerTool?: (tool: ToolDefinition) => void;
    activeNames?: string[];
  } = {},
): ExtensionAPI {
  const activeNames = options.activeNames ?? ["read", "custom-tool"];
  const fixture = {
    getAllTools:
      options.getAllTools ?? (() => ALL_CODE_PREVIEW_TOOLS.map((tool) => toolInfo(tool))),
    registerTool: options.registerTool ?? (() => undefined),
    getActiveTools: () => {
      throw new Error(`active tool API called: ${activeNames.join(",")}`);
    },
    setActiveTools: () => {
      throw new Error("active tool API called");
    },
  };
  // SAFETY: Registration tests invoke only the four ExtensionAPI methods in this fixture.
  return fixture as typeof fixture & ExtensionAPI;
}

function enableOnly(...tools: CodePreviewToolName[]): void {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: [...tools] });
}

test("registration leaves active tool names untouched and never calls active-tool APIs", () => {
  enableOnly("bash", "read");
  const activeNames = ["read", "custom-tool"];
  const installed: string[] = [];
  const pi = piFixture({
    activeNames,
    registerTool: (tool) => installed.push(tool.name),
  });

  registerToolRenderers(pi, "/project", { toolOptions: {} });

  assert.deepEqual(installed, ["bash", "read"]);
  assert.deepEqual(activeNames, ["read", "custom-tool"]);
});

test("definition construction failure occurs before the first registration mutation", () => {
  enableOnly("bash", "read");
  let mutations = 0;
  const toolOptions = Object.defineProperty({}, "bash", {
    get() {
      throw new Error("prebuild failure");
    },
  });

  assert.throws(
    () =>
      registerToolRenderers(piFixture({ registerTool: () => mutations++ }), "/project", {
        toolOptions,
      }),
    /prebuild failure/,
  );
  assert.equal(mutations, 0);
});

test("a registration failure is bounded, later tools continue, and retry installs only failures", () => {
  enableOnly(...ALL_CODE_PREVIEW_TOOLS);
  const attempts: string[] = [];
  const installedTools = new Set<CodePreviewToolName>();
  let failRead = true;
  const pi = piFixture({
    registerTool: (tool) => {
      attempts.push(tool.name);
      if (tool.name === "read" && failRead) throw new Error("raw private registration failure");
    },
  });

  assert.doesNotThrow(() =>
    registerToolRenderers(pi, "/project", { installedTools, toolOptions: {} }),
  );
  assert.deepEqual(attempts, [...ALL_CODE_PREVIEW_TOOLS]);
  assert.deepEqual(
    [...installedTools],
    ALL_CODE_PREVIEW_TOOLS.filter((tool) => tool !== "read"),
  );
  assert.deepEqual(getCodePreviewToolStatuses().get("read"), { state: "registration-error" });
  assert.equal(
    JSON.stringify([...getCodePreviewToolStatuses().values()]).includes("raw private"),
    false,
  );

  failRead = false;
  attempts.length = 0;
  registerToolRenderers(pi, "/project", { installedTools, toolOptions: {} });

  assert.deepEqual(attempts, ["read"]);
  assert.deepEqual(installedTools, new Set(ALL_CODE_PREVIEW_TOOLS));
  for (const tool of ALL_CODE_PREVIEW_TOOLS)
    assert.deepEqual(getCodePreviewToolStatuses().get(tool), { state: "installed" });
});

test("a mutate-then-refresh failure remains owned and retries successfully", () => {
  enableOnly("read");
  const ownedTools = new Set<CodePreviewToolName>();
  const installedTools = new Set<CodePreviewToolName>();
  const visible = new Map<string, ToolInfo>([["read", toolInfo("read")]]);
  let attempts = 0;
  let failRefresh = true;
  const pi = piFixture({
    getAllTools: () => [...visible.values()],
    registerTool: (tool) => {
      attempts++;
      // Pi 0.84 mutates the extension registry before refreshing the visible tool registry.
      visible.set(tool.name, toolInfo(tool.name, extensionSource));
      if (failRefresh) throw new Error("refresh failed after mutation");
    },
  });

  registerToolRenderers(pi, "/project", { ownedTools, installedTools, toolOptions: {} });
  assert.equal(attempts, 1);
  assert.deepEqual(ownedTools, new Set(["read"]));
  assert.equal(installedTools.size, 0);
  assert.deepEqual(getCodePreviewToolStatuses().get("read"), {
    state: "registration-error",
  });

  failRefresh = false;
  registerToolRenderers(pi, "/project", { ownedTools, installedTools, toolOptions: {} });
  assert.equal(attempts, 2);
  assert.deepEqual(installedTools, new Set(["read"]));
  assert.deepEqual(getCodePreviewToolStatuses().get("read"), { state: "installed" });
});

test("registration skips conflicts without constructing or tracking them", () => {
  enableOnly("grep");
  const installedTools = new Set<CodePreviewToolName>();
  let mutations = 0;
  const pi = piFixture({
    getAllTools: () => [toolInfo("grep", extensionSource)],
    registerTool: () => mutations++,
  });

  registerToolRenderers(pi, "/project", { installedTools, toolOptions: {} });

  assert.equal(mutations, 0);
  assert.equal(installedTools.size, 0);
  assert.deepEqual(getCodePreviewToolStatuses().get("grep"), {
    state: "skipped-conflict",
    owner: extensionSource,
  });
});

test("getAllTools is mandatory and discovery failures escape before mutation", () => {
  enableOnly("bash");
  let mutations = 0;
  const pi = piFixture({
    getAllTools: () => {
      throw new Error("tool discovery failed");
    },
    registerTool: () => mutations++,
  });

  assert.throws(
    () => registerToolRenderers(pi, "/project", { toolOptions: {} }),
    /tool discovery failed/,
  );
  assert.equal(mutations, 0);
});
