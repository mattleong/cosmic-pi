/** Real public Pi loader and native factory, with isolated default configuration. */
import assert from "node:assert/strict";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ExtensionFactory,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer, makePiManagedRuntime } from "pi-cosmic-core";
import { mcpPreviewsWithDependencies } from "../../src/application/lifecycle";
import { registerMcpPreviewsCommand } from "../../src/commands/register";
import { mcpPreviewApplicationLayer } from "../../src/layer";
import { styleNativeMcp } from "../../src/tools/native-mcp-render";
import { nativeManagerFixture } from "../support/native-mcp";
import { vi } from "vitest";
import mcpPreviews from "../../index";
import { getNativeMcpStatus } from "../../src/application/native-mcp-registration";
import { step } from "../support/effect-test";

const serializeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

for (const builtinFirst of [false, true])
  for (const obsolete of [false, "invalid"] as const)
    it.live(
      `installation composes defaults despite obsolete ${obsolete} setting, builtin first=${builtinFirst}`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-previews-sdk-" });
          const agentDir = `${cwd}/agent`;
          yield* fs.makeDirectory(agentDir, { recursive: true });
          yield* fs.makeDirectory(`${cwd}/.pi`, { recursive: true });
          yield* fs.writeFileString(
            `${agentDir}/code-previews.json`,
            serializeJson({ nativeMcpPreviews: obsolete }),
          );
          // Native defaults retain disabled servers without connecting a process or opening auth.
          yield* fs.writeFileString(
            `${agentDir}/mcp.json`,
            serializeJson({
              mcpServers: {
                disabled: { command: "must-not-execute", enabled: false },
                remote: { url: "https://mcp.invalid/mcp", enabled: false },
              },
            }),
          );
          vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
          vi.stubEnv("CODE_PREVIEW_NATIVE_MCP", "false");
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
          const builtin = {
            name: "mcp",
            builtin: true,
            replaceable: true,
            factory: createMcpExtension(),
          };
          const owner = { name: "mcp-previews", factory: mcpPreviews };
          const loader = new DefaultResourceLoader({
            cwd,
            agentDir,
            settingsManager: settings,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: builtinFirst ? [builtin, owner] : [owner, builtin],
          });
          yield* step(() => loader.reload());
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
            .filter((command) => /^mcp(?::\d+)?$/u.test(command.invocationName));
          assert.equal(managers.length, 1);
          assert.equal(managers[0]?.sourceInfo.path, "<inline:mcp-previews>");
          assert.equal(getNativeMcpStatus().state, "owned");
          assert.deepEqual(errors, []);
          assert.equal(
            yield* fs.exists(`${agentDir}/mcp-auth.json`),
            false,
            "no custom or automatic credentials are created for disabled servers",
          );
          yield* step(() => session.reload());
          assert.equal(getNativeMcpStatus().state, "owned");
          assert.deepEqual(errors, []);
        }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
    );

it.live(
  "fresh callback decoration preserves native admission, dynamic catalog and Pi permission hooks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "mcp-previews-pipeline-" });
      const agentDir = `${cwd}/agent`;
      yield* fs.makeDirectory(agentDir, { recursive: true });
      const manager = nativeManagerFixture();
      const natives = new Map<ToolDefinition<any, any, any>, ToolDefinition<any, any, any>>();
      const registered: ToolDefinition<any, any, any>[] = [];
      let provider: ExtensionAPI | undefined;
      let block = false;
      let resultHooks = 0;
      const owner: ExtensionFactory = (pi) =>
        mcpPreviewsWithDependencies(
          {
            ...pi,
            registerTool: (definition) => {
              registered.push(definition);
              pi.registerTool(definition);
            },
          },
          {
            makeRuntime: (api) => makePiManagedRuntime(api, mcpPreviewApplicationLayer),
            registerCommands: registerMcpPreviewsCommand,
            loadSettings: () => Promise.resolve(),
            nativeMcp: {
              createFactory: () => manager.factory,
              style: (definition, schedule) => {
                const styled = styleNativeMcp(definition, schedule);
                natives.set(styled, definition);
                return styled;
              },
            },
          },
        );
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
          { name: "mcp-previews", factory: owner },
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
        fauxAssistantMessage(fauxToolCall("probe", {}, { id: "parent-call" }), {
          stopReason: "toolUse",
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
      const context = session.extensionRunner.createToolContext("parent-call", undefined);
      const tool = registered.findLast((definition) => definition.name === "mcp__docs__lookup");
      assert.ok(tool);
      const native = natives.get(tool);
      assert.ok(native);
      assert.equal(tool.execute, native.execute);
      assert.equal(tool.annotations, native.annotations);
      const returned = yield* step(() => context.executeTool(tool.name, {}));
      assert.equal(returned.isError, false);
      assert.deepEqual(returned.result.content, [
        { type: "text", text: "TEXT_RETAINED" },
        { type: "image", data: "aW1hZ2U=", mimeType: "image/png" },
      ]);
      assert.deepEqual(returned.result.structuredContent, { retained: true });
      assert.ok(resultHooks > 0);
      const failed = yield* step(() => context.executeTool(tool.name, { mode: "error" }));
      assert.equal(failed.isError, true);
      block = true;
      const executed = manager.executions();
      const blocked = yield* step(() => context.executeTool(tool.name, {}));
      assert.equal(blocked.isError, true);
      assert.equal(manager.executions(), executed, "permissions block before native execution");
      block = false;
      const controller = new AbortController();
      const pending = context.executeTool(
        tool.name,
        { mode: "abort" },
        { signal: controller.signal },
      );
      controller.abort();
      assert.equal((yield* step(() => pending)).isError, true);

      manager.catalog("docs", ["added"]);
      assert.equal(
        session.getAllTools().find((entry) => entry.name === tool.name)?.exposure,
        "hidden",
      );
      assert.ok(natives.has(registered.findLast((entry) => entry.name === "mcp__docs__added")!));
      // Once admitted, a later command collision cannot skip registered-server removals.
      provider!.registerCommand("mcp", { handler: () => Promise.resolve() });
      provider!.unregisterMcpServer("docs");
      yield* step(() =>
        session.extensionRunner.emit({
          type: "mcp_servers_change",
          servers: provider!.getMcpServers(),
        }),
      );
      assert.equal(
        session.getAllTools().find((entry) => entry.name === "mcp__docs__added")?.exposure,
        "hidden",
      );
      yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      assert.equal(manager.closed(), 1);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
