import assert from "node:assert/strict";
import type {
  ExtensionAPI,
  SourceInfo,
  ToolDefinition,
  ToolInfo,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer, provideBuiltLayer } from "pi-cosmic-core";
import { extensionApiFixture, opaqueFixture } from "pi-cosmic-core/testing";
import { afterEach, test } from "vitest";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../../src/application/capability";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { CORE_CODE_PREVIEW_TOOLS, type CodePreviewToolName } from "../../src/tools/names";
import {
  createBuiltinPreviewRenderers,
  registerWritePreviewTool,
} from "../../src/tools/renderers/registration";
import { getEnabledCodePreviewTools } from "../../src/tools/selection";
import { getCodePreviewToolStatuses } from "../../src/tools/status";

const builtinSource: SourceInfo = {
  path: "builtin:write",
  source: "builtin",
  scope: "temporary",
  origin: "top-level",
};
const extensionSource: SourceInfo = {
  path: "/extensions/code-previews.ts",
  source: "code-previews",
  scope: "user",
  origin: "top-level",
};
const foreignSource: SourceInfo = { ...extensionSource, path: "/extensions/foreign.ts" };
const anchor = { name: "code-previews", source: "extension" as const, sourceInfo: extensionSource };

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

function toolInfo(name: string, sourceInfo: SourceInfo = builtinSource): ToolInfo {
  return {
    name,
    description: `${name} tool`,
    parameters: opaqueFixture({}),
    exposure: "direct",
    sourceInfo,
  };
}
function piFixture(options: Partial<ExtensionAPI> = {}): ExtensionAPI {
  return extensionApiFixture({
    getAllTools: () => [toolInfo("write")],
    getCommands: () => [anchor],
    getActiveTools: () => [...CORE_CODE_PREVIEW_TOOLS],
    registerTool: () => undefined,
    setActiveTools: () => {
      throw new Error("active tools must not be changed");
    },
    ...options,
  });
}
function enableOnly(...tools: CodePreviewToolName[]): void {
  setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: [...tools] });
}
/** The session the resolver publishes, enabling whatever the current settings enable. */
const presentation = () => ({
  cwd: "/project",
  selfShell: true,
  scheduleAnimation: () => () => undefined,
  enabledTools: [...getEnabledCodePreviewTools()],
});

test("all enabled core presentations are renderer-only and only write installs an execution hook", () => {
  enableOnly(...CORE_CODE_PREVIEW_TOOLS);
  const installed: string[] = [];
  const pi = piFixture({ registerTool: (tool) => installed.push(tool.name) });
  for (const name of CORE_CODE_PREVIEW_TOOLS) {
    const renderers = createBuiltinPreviewRenderers(name, presentation());
    assert.ok(renderers);
    assert.equal("execute" in renderers, false);
    assert.equal("parameters" in renderers, false);
  }
  registerWritePreviewTool(pi, "/project");
  assert.deepEqual(installed, ["write"]);
});

test("disabled names neither create presentations nor register write", () => {
  enableOnly("read");
  const pi = piFixture({ registerTool: () => assert.fail("unexpected hook") });
  registerWritePreviewTool(pi, "/project");
  assert.equal(createBuiltinPreviewRenderers("write", presentation()), undefined);
});

it.effect.each([
  ["without a preview session", "next", false],
  ["for content it cannot preview", new TextEncoder().encode("next"), true],
] as const)("an installed write hook writes natively %s", ([, content, session]) =>
  Effect.gen(function* () {
    enableOnly("write");
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-native-write-" });
    const hooks: ToolDefinition<any, any, any>[] = [];
    registerWritePreviewTool(piFixture({ registerTool: (tool) => hooks.push(tool) }), directory);
    const [hook] = hooks;
    assert.ok(hook);
    // A session that refuses all work proves the hook never takes a snapshot of its own.
    if (session)
      installCodePreviewSessionCapability({
        run: () => Promise.reject(new Error("no preview work expected")),
        defer: () => () => undefined,
        schedule: () => () => undefined,
      });
    yield* Effect.addFinalizer(() => Effect.sync(() => clearCodePreviewSessionCapability()));
    const result = yield* Effect.tryPromise(() =>
      hook.execute(
        "native-write",
        { path: "a.txt", content },
        undefined,
        undefined,
        opaqueFixture({ cwd: directory }),
      ),
    );
    assert.equal(yield* fs.readFileString(`${directory}/a.txt`), "next");
    // Unobserved prior contents never support a new-file claim.
    assert.equal(result.details, undefined);
  }).pipe(provideBuiltLayer(nodeFilePlatformLayer)),
);

test.each([false, true])("write registration preserves active selection: %s", (active) => {
  enableOnly("write");
  const definitions: ToolDefinition<any, any, any>[] = [];
  registerWritePreviewTool(
    piFixture({
      getActiveTools: () => (active ? ["write"] : ["read"]),
      registerTool: (tool) => definitions.push(tool),
    }),
    "/project",
  );
  assert.equal(definitions.length, 1);
  assert.equal(definitions[0]?.defaultActive, active);
});

test.each([
  ["absent", []],
  ["foreign", [toolInfo("write", foreignSource)]],
  ["wrong builtin source", [toolInfo("write", { ...builtinSource, path: "builtin:other" })]],
  ["ambiguous", [toolInfo("write"), toolInfo("write", foreignSource)]],
] as const)("%s write stays unchanged", (_, tools) => {
  enableOnly("write");
  const ownedTools = new Set<CodePreviewToolName>();
  const installedTools = new Set<CodePreviewToolName>();
  registerWritePreviewTool(
    piFixture({
      getAllTools: () => [...tools],
      registerTool: () => assert.fail("unexpected registration"),
    }),
    "/project",
    { ownedTools, installedTools },
  );
  assert.equal(ownedTools.size, 0);
  assert.equal(installedTools.size, 0);
});

test.each(["discovery", "active selection", "registration"])(
  "%s failure is bounded and retryable",
  (boundary) => {
    enableOnly("write");
    let failing = true;
    const installedTools = new Set<CodePreviewToolName>();
    const fail = () => {
      if (failing) throw new Error("raw private failure");
    };
    const pi = piFixture({
      getAllTools: () => {
        if (boundary === "discovery") fail();
        return [toolInfo("write")];
      },
      getActiveTools: () => {
        if (boundary === "active selection") fail();
        return ["write"];
      },
      registerTool: () => {
        if (boundary === "registration") fail();
      },
    });
    registerWritePreviewTool(pi, "/project", { installedTools });
    assert.equal(installedTools.size, 0);
    assert.deepEqual(getCodePreviewToolStatuses().get("write"), { state: "registration-error" });
    failing = false;
    registerWritePreviewTool(pi, "/project", { installedTools });
    assert.deepEqual(installedTools, new Set(["write"]));
  },
);

test("mutate-then-refresh failure stays owned and retries without reinstalling a settled hook", () => {
  enableOnly("write");
  const ownedTools = new Set<CodePreviewToolName>();
  const installedTools = new Set<CodePreviewToolName>();
  let visible = toolInfo("write");
  let failRefresh = true;
  let mutations = 0;
  const pi = piFixture({
    getAllTools: () => [visible],
    registerTool: (tool) => {
      mutations++;
      visible = toolInfo(tool.name, extensionSource);
      if (failRefresh) throw new Error("refresh failed after mutation");
    },
  });
  registerWritePreviewTool(pi, "/project", { ownedTools, installedTools });
  assert.deepEqual(ownedTools, new Set(["write"]));
  assert.equal(installedTools.size, 0);
  failRefresh = false;
  registerWritePreviewTool(pi, "/project", { ownedTools, installedTools });
  registerWritePreviewTool(pi, "/project", { ownedTools, installedTools });
  assert.equal(mutations, 2);
  assert.deepEqual(installedTools, new Set(["write"]));
  // Even settled prior ownership cannot authorize a later foreign replacement.
  visible = toolInfo("write", foreignSource);
  registerWritePreviewTool(pi, "/project", { ownedTools, installedTools });
  assert.equal(mutations, 2);
  assert.deepEqual(getCodePreviewToolStatuses().get("write"), {
    state: "skipped-conflict",
    owner: foreignSource,
  });
});

test.each(["foreign replacement", "missing anchor", "ambiguous anchor", "metadata failure"])(
  "prior ownership declines %s",
  (scenario) => {
    enableOnly("write");
    const ownedTools = new Set<CodePreviewToolName>(["write"]);
    const installedTools = new Set<CodePreviewToolName>();
    registerWritePreviewTool(
      piFixture({
        getAllTools: () => [
          toolInfo("write", scenario === "foreign replacement" ? foreignSource : extensionSource),
        ],
        getCommands: () => {
          if (scenario === "metadata failure") throw new Error("metadata unavailable");
          return scenario === "missing anchor"
            ? []
            : scenario === "ambiguous anchor"
              ? [anchor, anchor]
              : [anchor];
        },
        registerTool: () => assert.fail("prior membership is not ownership proof"),
      }),
      "/project",
      { ownedTools, installedTools },
    );
    assert.equal(installedTools.size, 0);
  },
);
