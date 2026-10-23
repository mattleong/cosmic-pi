import assert from "node:assert/strict";
import {
  createMcpExtension,
  SessionManager,
  type ExtensionAPI,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { vi } from "vitest";
import { nativeManagerFixture } from "../support/native-mcp";
import { step } from "../support/effect-test";
import { codePreviewsUnderTest, offlineModels, scopedSession } from "../support/sdk-session";
import { quietLoader, quietSettings } from "pi-cosmic-core/testing/sdk";
import { createToolPresentationHarness } from "../../testing";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import * as Order from "effect/Order";

const serializeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Json));

interface PresentationRegistrations {
  readonly tools: string[];
  resolvers: number;
}

function presentationFactory(
  agentDir: string,
  report: PresentationRegistrations,
): ExtensionFactory {
  return codePreviewsUnderTest(
    agentDir,
    {
      tools: [],
      syntaxHighlighting: false,
      toolCallCollapsedStyle: "compact",
      toolCallBackground: "off",
    },
    {
      api: (pi) => ({
        registerTool(definition) {
          report.tools.push(definition.name);
          pi.registerTool(definition);
        },
        registerToolRenderer(resolver) {
          report.resolvers++;
          pi.registerToolRenderer(resolver);
        },
      }),
    },
  );
}

for (const builtinFirst of [false])
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
        const settings = quietSettings();
        const models = yield* offlineModels(cwd);
        const report: PresentationRegistrations = { tools: [], resolvers: 0 };
        const loader = yield* quietLoader({
          cwd,
          agentDir,
          settingsManager: settings,
          extensionsOverride: (base) => ({
            ...base,
            extensions: Arr.sort(
              base.extensions,
              Order.mapInput(Order.Number, ({ path }: { readonly path: string }) =>
                path === "builtin:mcp" ? (builtinFirst ? 0 : 1) : builtinFirst ? 1 : 0,
              ),
            ),
          }),
          extensionFactories: [
            { name: "code-previews", factory: presentationFactory(agentDir, report) },
            { name: "mcp", builtin: true, replaceable: true, factory: createMcpExtension() },
          ],
        });
        const order = Arr.map(loader.getExtensions().extensions, (extension) => extension.path);
        assert.deepEqual(
          order,
          builtinFirst
            ? ["builtin:mcp", "<inline:code-previews>"]
            : ["<inline:code-previews>", "builtin:mcp"],
        );
        const session = yield* scopedSession({ cwd, agentDir, models, settings, loader });
        const errors: string[] = [];
        yield* step(() =>
          session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) }),
        );
        const managers = Arr.filter(
          session.extensionRunner.getRegisteredCommands(),
          (command) => command.name === "mcp",
        );
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
        assert.ok(Fn.pipe(Arr.join(h.render(200), "\n"), Str.includes("mcp__docs__lookup")));
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
      const settings = quietSettings();
      const models = yield* offlineModels(cwd);
      const loader = yield* quietLoader({
        cwd,
        agentDir,
        settingsManager: settings,
        extensionFactories: [
          { name: "code-previews", factory: presentationFactory(agentDir, report) },
          { name: "mcp", builtin: true, factory: manager.factory },
          {
            name: "provider",
            factory: (pi) => {
              provider = pi;
              pi.registerMcpServer("docs", { command: "never-executed-by-owned-fixture" });
              pi.on("tool_call", (event) =>
                Fn.pipe(event.toolName, Str.startsWith("mcp__")) && block
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
      const sessionManager = SessionManager.inMemory(cwd);
      sessionManager.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", name: "probe", arguments: {}, id: "parent-call" }],
        api: "faux",
        provider: "faux",
        model: "faux",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 0,
      });
      const session = yield* scopedSession({
        cwd,
        agentDir,
        models,
        settings,
        loader,
        sessionManager,
      });
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
      assert.ok(Fn.pipe(Arr.join(h.render(200), "\n"), Str.includes("TEXT_RETAINED")));
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
      // Stands in for the host's abort signal, which codemode passes to `executeTool`.
      const controller = new AbortController();
      const pending = context.executeTool(name, { mode: "abort" }, { signal: controller.signal });
      controller.abort();
      assert.equal((yield* step(() => pending)).isError, true);
      manager.catalog("docs", ["added"]);
      assert.equal(
        Option.getOrUndefined(Arr.findFirst(session.getAllTools(), (tool) => tool.name === name))
          ?.exposure,
        "hidden",
      );
      assert.ok(session.extensionRunner.resolveToolRenderers("mcp__docs__added", () => undefined));
      provider!.unregisterMcpServer("docs");
      yield* step(() =>
        session.extensionRunner.emit({
          type: "mcp_servers_change",
          servers: provider!.getMcpServers(),
        }),
      );
      assert.equal(
        Option.getOrUndefined(
          Arr.findFirst(session.getAllTools(), (tool) => tool.name === "mcp__docs__added"),
        )?.exposure,
        "hidden",
      );
      yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      yield* step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }));
      assert.equal(manager.closed(), 1);
      assert.equal(report.resolvers, 1);
    }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
);
