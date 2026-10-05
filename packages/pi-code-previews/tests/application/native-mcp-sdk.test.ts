/** Native MCP remains an independent public SDK extension; presentation never composes it. */
import assert from "node:assert/strict";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { makePiManagedRuntime, nodeFilePlatformLayer } from "pi-cosmic-core";
import { afterEach, vi } from "vitest";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { codePreviewApplicationLayer } from "../../src/layer";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { nativeManagerFixture } from "../support/native-mcp";
import { step } from "../support/effect-test";
import { createToolPresentationHarness } from "../../testing";

afterEach(() => setCodePreviewSettings(defaultCodePreviewSettings));

const serializeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

interface PresentationRegistrations {
  readonly tools: string[];
  resolvers: number;
}

function presentationFactory(
  agentDir: string,
  report: PresentationRegistrations,
): ExtensionFactory {
  return (pi) =>
    codePreviewsWithDependencies(
      {
        ...pi,
        registerTool(definition) {
          report.tools.push(definition.name);
          pi.registerTool(definition);
        },
        registerToolRenderer(resolver) {
          report.resolvers++;
          pi.registerToolRenderer(resolver);
        },
      },
      {
        makeRuntime: (api) =>
          makePiManagedRuntime(api, codePreviewApplicationLayer, {
            agentDirectory: () => agentDir,
            packageName: "pi-code-previews",
          }),
        registerCommands: (api) =>
          api.registerCommand("code-previews", { handler: () => Promise.resolve() }),
        loadSettings: () =>
          Effect.sync(() => {
            const preview = {
              ...defaultCodePreviewSettings,
              tools: [],
              syntaxHighlighting: false,
              toolCallCollapsedStyle: "compact" as const,
              toolCallBackground: "off" as const,
            };
            setCodePreviewSettings(preview);
            return preview;
          }),
        initializeSyntax: () => Effect.void,
        registerRenderers: () => undefined,
      },
    );
}

for (const builtinFirst of [false, true])
  it.live(
    `public loader keeps the independent native MCP manager in either order: builtin first=${builtinFirst}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "code-previews-mcp-sdk-" });
        const agentDir = `${cwd}/agent`;
        yield* fs.makeDirectory(agentDir, { recursive: true });
        yield* fs.writeFileString(
          `${agentDir}/mcp.json`,
          serializeJson({
            mcpServers: { disabled: { command: "must-not-execute", enabled: false } },
          }),
        );
        vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        const settings = SettingsManager.inMemory({
          retry: { enabled: false },
          compaction: { enabled: false },
        });
        const models = yield* step(() =>
          ModelRuntime.create({
            authPath: `${cwd}/auth.json`,
            modelsPath: null,
            modelsStorePath: `${cwd}/models.json`,
            refreshOnCreate: false,
            allowModelNetwork: false,
          }),
        );
        const report: PresentationRegistrations = { tools: [], resolvers: 0 };
        const loader = new DefaultResourceLoader({
          cwd,
          agentDir,
          settingsManager: settings,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          extensionsOverride: (base) => ({
            ...base,
            extensions: base.extensions.toSorted((a, b) => {
              const rank = (path: string) =>
                path === "builtin:mcp" ? (builtinFirst ? 0 : 1) : builtinFirst ? 1 : 0;
              return rank(a.path) - rank(b.path);
            }),
          }),
          extensionFactories: [
            { name: "code-previews", factory: presentationFactory(agentDir, report) },
            { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
          ],
        });
        yield* step(() => loader.reload());
        const order = loader.getExtensions().extensions.map((extension) => extension.path);
        assert.deepEqual(
          order,
          builtinFirst
            ? ["builtin:mcp", "<inline:code-previews>"]
            : ["<inline:code-previews>", "builtin:mcp"],
        );
        const { session } = yield* step(() =>
          createAgentSession({
            cwd,
            agentDir,
            modelRuntime: models,
            settingsManager: settings,
            sessionManager: SessionManager.inMemory(cwd),
            resourceLoader: loader,
          }),
        );
        yield* Effect.addFinalizer(() =>
          step(() =>
            session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
          ).pipe(Effect.ensuring(Effect.sync(() => session.dispose()))),
        );
        const errors: string[] = [];
        yield* step(() =>
          session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) }),
        );
        const managers = session.extensionRunner
          .getRegisteredCommands()
          .filter((command) => command.name === "mcp");
        assert.equal(managers.length, 1);
        assert.equal(managers[0]?.sourceInfo.path, "builtin:mcp");
        assert.deepEqual(report.tools, []);
        assert.equal(report.resolvers, 1);
        assert.deepEqual(errors, []);
        assert.equal(yield* fs.exists(`${agentDir}/mcp-auth.json`), false);
        const historical = session.extensionRunner.resolveToolRenderers(
          "mcp__docs__lookup",
          () => undefined,
        );
        assert.ok(historical);
        const h = createToolPresentationHarness(historical);
        h.call({ query: "historical input" });
        assert.ok(h.render(200).join("\n").includes("mcp__docs__lookup"));
        yield* step(() => session.reload());
        assert.deepEqual(report.tools, []);
        assert.deepEqual(errors, []);
      }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
  );

it.live(
  "independent native execution retains permissions, images, cancellation, catalog withdrawal and cleanup",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "code-previews-mcp-pipeline-" });
      const agentDir = `${cwd}/agent`;
      yield* fs.makeDirectory(agentDir, { recursive: true });
      const manager = nativeManagerFixture();
      let provider: ExtensionAPI | undefined;
      let block = false;
      let resultHooks = 0;
      const report: PresentationRegistrations = { tools: [], resolvers: 0 };
      const settings = SettingsManager.inMemory({
        retry: { enabled: false },
        compaction: { enabled: false },
      });
      const models = yield* step(() =>
        ModelRuntime.create({
          authPath: `${cwd}/auth.json`,
          modelsPath: null,
          modelsStorePath: `${cwd}/models.json`,
          refreshOnCreate: false,
          allowModelNetwork: false,
        }),
      );
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          { name: "code-previews", factory: presentationFactory(agentDir, report) },
          { name: "mcp", builtin: true, factory: manager.factory },
          {
            name: "provider",
            factory: (pi) => {
              provider = pi;
              pi.registerMcpServer("docs", { command: "never-executed-by-owned-fixture" });
              pi.on("tool_call", (event) =>
                event.toolName.startsWith("mcp__") && block
                  ? { block: true, reason: "Permission refused" }
                  : undefined,
              );
              pi.on("tool_result", () => {
                resultHooks++;
              });
            },
          },
        ],
      });
      yield* step(() => loader.reload());
      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage(
        opaqueFixture({
          role: "assistant",
          content: [{ type: "toolCall", name: "probe", arguments: {}, id: "parent-call" }],
          stopReason: "toolUse",
          timestamp: 0,
        }),
      );
      const { session } = yield* step(() =>
        createAgentSession({
          cwd,
          agentDir,
          modelRuntime: models,
          settingsManager: settings,
          sessionManager,
          resourceLoader: loader,
        }),
      );
      yield* Effect.addFinalizer(() =>
        step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).pipe(
          Effect.ensuring(Effect.sync(() => session.dispose())),
        ),
      );
      yield* step(() => session.bindExtensions({ mode: "print" }));
      const name = "mcp__docs__lookup";
      const original = manager.definitions.get(name);
      assert.ok(original);
      const before = { ...original };
      const renderers = session.extensionRunner.resolveToolRenderers(name, () => undefined);
      assert.ok(renderers);
      const h = createToolPresentationHarness(renderers);
      const context = session.extensionRunner.createToolContext("parent-call", undefined);
      const returned = yield* step(() => context.executeTool(name, {}));
      assert.equal(returned.isError, false);
      assert.deepEqual(returned.result.content, [
        { type: "text", text: "TEXT_RETAINED" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ]);
      assert.deepEqual(returned.result.structuredContent, { retained: true });
      assert.ok(resultHooks > 0);
      h.call({}, { expanded: true });
      h.result(returned.result, { expanded: true, showImages: false });
      assert.ok(h.render(200).join("\n").includes("TEXT_RETAINED"));
      assert.deepEqual({ ...original }, before);
      assert.deepEqual(report.tools, []);
      const failed = yield* step(() => context.executeTool(name, { mode: "error" }));
      assert.equal(failed.isError, true);
      block = true;
      const executed = manager.executions();
      const blocked = yield* step(() => context.executeTool(name, {}));
      assert.equal(blocked.isError, true);
      assert.equal(manager.executions(), executed);
      block = false;
      const controller = new AbortController();
      const pending = context.executeTool(name, { mode: "abort" }, { signal: controller.signal });
      controller.abort();
      assert.equal((yield* step(() => pending)).isError, true);
      manager.catalog("docs", ["added"]);
      assert.equal(session.getAllTools().find((tool) => tool.name === name)?.exposure, "hidden");
      assert.ok(session.extensionRunner.resolveToolRenderers("mcp__docs__added", () => undefined));
      provider!.unregisterMcpServer("docs");
      yield* step(() =>
        session.extensionRunner.emit({
          type: "mcp_servers_change",
          servers: provider!.getMcpServers(),
        }),
      );
      assert.equal(
        session.getAllTools().find((tool) => tool.name === "mcp__docs__added")?.exposure,
        "hidden",
      );
      yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      assert.equal(manager.closed(), 1);
      assert.equal(report.resolvers, 1);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
