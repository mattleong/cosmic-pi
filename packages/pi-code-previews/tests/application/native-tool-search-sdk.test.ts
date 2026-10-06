// Actual SDK/native factory boundary; no provider, network, or discovered fixture execution.
import assert from "node:assert/strict";
import {
  createAgentSession,
  createToolSearchExtension,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  type InlineExtension,
} from "@earendil-works/pi-coding-agent";
import { beforeAll } from "vitest";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { makePiManagedRuntime, nodeFilePlatformLayer, stripAnsi } from "pi-cosmic-core";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { codePreviewApplicationLayer } from "../../src/layer";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { getCodePreviewToolStatuses } from "../../src/tools/status";
import { nativeToolSearchReceipt } from "../../src/tools/native-tool-search-summary";
import { step } from "../support/effect-test";

beforeAll(() => initTheme("dark", false));

for (const order of ["native-first", "previews-first"] as const)
  for (const style of ["preview", "compact"] as const)
    it.live(
      `independently loaded tool search keeps native ownership and retained ${style} replay (${order})`,
      () =>
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const directory = yield* fs.makeTempDirectoryScoped({
            prefix: "preview-tool-search-sdk-",
          });
          const models = yield* step(() =>
            ModelRuntime.create({
              authPath: `${directory}/auth.json`,
              modelsPath: null,
              modelsStorePath: `${directory}/models-cache.json`,
              refreshOnCreate: false,
              allowModelNetwork: false,
            }),
          );
          const settings = SettingsManager.inMemory({
            compaction: { enabled: false },
            retry: { enabled: false },
          });
          let rendererRegistrations = 0;
          let fixtureExecutions = 0;
          const previews: InlineExtension = {
            name: "code-previews",
            factory: (pi) =>
              codePreviewsWithDependencies(
                {
                  ...pi,
                  registerTool() {
                    throw new Error("presentation execution registration");
                  },
                  setActiveTools() {
                    throw new Error("presentation activation");
                  },
                  registerToolRenderer(resolver) {
                    rendererRegistrations++;
                    pi.registerToolRenderer(resolver);
                  },
                },
                {
                  makeRuntime: (api) =>
                    makePiManagedRuntime(api, codePreviewApplicationLayer, {
                      agentDirectory: () => directory,
                      packageName: "pi-code-previews",
                    }),
                  registerCommands: (api) =>
                    api.registerCommand("code-previews", {
                      description: "Presentation fixture",
                      handler: () => Promise.resolve(),
                    }),
                  loadSettings: () =>
                    Effect.sync(() => {
                      const preview = {
                        ...defaultCodePreviewSettings,
                        tools: ["tool_search" as const],
                        syntaxHighlighting: false,
                        toolCallTiming: false,
                        toolCallCollapsedStyle: style,
                        toolCallBackground:
                          style === "preview" ? ("on" as const) : ("off" as const),
                      };
                      setCodePreviewSettings(preview);
                      return preview;
                    }),
                  initializeSyntax: () => Effect.void,
                  registerRenderers: () => undefined,
                },
              ),
          };
          // CLI-equivalent native factory, independently loaded without interception or source fixtures.
          const native: InlineExtension = {
            name: "tool-search",
            factory: createToolSearchExtension(),
            replaceable: true,
            builtin: true,
          };
          const loader = new DefaultResourceLoader({
            cwd: directory,
            agentDir: directory,
            settingsManager: settings,
            noSkills: true,
            noPromptTemplates: true,
            noThemes: true,
            noContextFiles: true,
            extensionFactories: [
              ...(order === "native-first" ? [native, previews] : [previews, native]),
              {
                name: "harmless-deferred-fixture",
                factory(pi) {
                  pi.registerTool({
                    name: "nebula_fixture",
                    label: "Harmless deferred fixture",
                    description: "Find nebula fixture documentation",
                    exposure: "deferred",
                    parameters: { type: "object", properties: {} } as const,
                    execute() {
                      fixtureExecutions++;
                      return Promise.resolve({
                        content: [{ type: "text" as const, text: "must not run" }],
                        details: undefined,
                      });
                    },
                  });
                },
              },
            ],
          });
          yield* step(() => loader.reload());
          const { session } = yield* step(() =>
            createAgentSession({
              cwd: directory,
              agentDir: directory,
              modelRuntime: models,
              settingsManager: settings,
              sessionManager: SessionManager.inMemory(directory),
              resourceLoader: loader,
            }),
          );
          yield* Effect.addFinalizer(() =>
            step(() =>
              session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  session.dispose();
                  setCodePreviewSettings(defaultCodePreviewSettings);
                }),
              ),
            ),
          );
          const definition = session.getToolDefinition("tool_search");
          assert.ok(definition);
          const original = {
            execute: definition.execute,
            parameters: definition.parameters,
            exposure: definition.exposure,
            defaultActive: definition.defaultActive,
          };
          const active = session.getActiveToolNames();
          const callable = session.getCallableToolNames();
          assert.equal(active.includes("tool_search"), false);
          assert.equal(active.includes("nebula_fixture"), false);
          const metadata = session.getAllTools().find((tool) => tool.name === "tool_search");
          assert.ok(metadata);
          assert.deepEqual(metadata.sourceInfo, {
            source: "builtin",
            path: "builtin:tool-search",
            scope: "temporary",
            origin: "top-level",
          });
          assert.equal(metadata.exposure, "model-only");
          assert.equal(definition.defaultActive, false);
          assert.equal(callable.includes("tool_search"), false);
          const args = { query: "HISTORICAL_QUERY", limit: 3, extra: "EXACT_EXTRA" };
          const result = {
            content: [
              {
                type: "text" as const,
                text: "HISTORICAL_OUTPUT\nRead the complete tool instructions: RECOVERY_TEXT",
              },
            ],
            details: { loaded: ["nebula_fixture"] },
            isError: false,
          };
          const before = structuredClone(result);
          // One real Pi row, constructed before bindExtensions/session_start, not resolved again.
          const renderers = session.extensionRunner.resolveToolRenderers(
            "tool_search",
            () => definition,
          );
          assert.equal(renderers?.renderShell, "self");
          const row = new ToolExecutionComponent(
            "tool_search",
            "historical-search",
            args,
            { showImages: false },
            renderers,
            opaqueFixture({ requestRender() {} }),
            directory,
          );
          row.updateResult(result);
          row.render(100);
          yield* step(() => session.bindExtensions({ mode: "print" }));
          assert.equal(rendererRegistrations, 1);
          assert.equal(getCodePreviewToolStatuses().get("tool_search")?.state, "installed");
          assert.equal(session.getToolDefinition("tool_search"), definition);
          assert.deepEqual(
            {
              execute: definition.execute,
              parameters: definition.parameters,
              exposure: definition.exposure,
              defaultActive: definition.defaultActive,
            },
            original,
          );
          assert.deepEqual(session.getActiveToolNames(), active);
          assert.deepEqual(session.getCallableToolNames(), callable);
          for (const expanded of [false, true, false, true]) {
            row.setExpanded(expanded);
            row.invalidate();
            const rendered = stripAnsi(row.render(100).join("\n"));
            assert.match(rendered, /HISTORICAL_QUERY/);
            if (expanded)
              for (const marker of [
                "EXACT_EXTRA",
                "HISTORICAL_OUTPUT",
                "RECOVERY_TEXT",
                '"limit": 3',
              ])
                assert.ok(rendered.includes(marker), marker);
            else {
              assert.match(rendered, /\b1\b/);
              assert.doesNotMatch(rendered, /HISTORICAL_OUTPUT|RECOVERY_TEXT/);
            }
          }
          assert.deepEqual(result, before);
          assert.deepEqual(
            session.getActiveToolNames(),
            active,
            "rendering a historical loaded receipt must not activate tools",
          );
          assert.equal(fixtureExecutions, 0);

          // Deliberate native execution only after explicit activation. Search activates metadata
          // matches; it does not execute them. This is not a presentation or replay operation.
          session.setActiveToolsByName([...active, "tool_search"]);
          assert.equal(session.getCallableToolNames().includes("tool_search"), false);
          const search = session.agent.state.tools.find((tool) => tool.name === "tool_search");
          assert.ok(search);
          const loaded = yield* step(() =>
            search.execute("deliberate-native-search", { query: "nebula", limit: 1 }, undefined),
          );
          assert.deepEqual(nativeToolSearchReceipt(loaded.details), { loaded: ["nebula_fixture"] });
          assert.ok(session.getActiveToolNames().includes("nebula_fixture"));
          const again = yield* step(() =>
            search.execute("deliberate-native-repeat", { query: "nebula", limit: 1 }, undefined),
          );
          assert.deepEqual(nativeToolSearchReceipt(again.details), { loaded: [] });
          assert.equal(fixtureExecutions, 0);
          assert.equal(session.getToolDefinition("tool_search"), definition);
        }).pipe(Effect.scoped, Effect.provide(nodeFilePlatformLayer)),
    );
