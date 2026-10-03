// Public SDK/Promise host boundary with the actual native QuickJS engine; no provider/network calls.
import assert from "node:assert/strict";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionAPI,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { makePiManagedRuntime, nodeFilePlatformLayer } from "pi-cosmic-core";
import { codePreviewsWithDependencies } from "../../src/application/lifecycle";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { registerToolRenderers } from "../../src/tools/renderers/registration";
import { getCodePreviewToolStatuses } from "../../src/tools/status";
import { step } from "../support/effect-test";
import { createToolPresentationHarness, renderContextFixture } from "../../testing";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";

const projectionTools = [
  "mcp",
  "background_task",
  "mcp__docs__lookup",
  "read_mcp_resource",
  "list_mcp_resources",
  "list_mcp_resource_templates",
];

for (const earlierBuiltin of [false, true])
  it.live(
    `native SDK ${earlierBuiltin ? "explicit builtin first reports conflict" : "owned presentation preserves native execution/store/hooks"}`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-native-sdk-" });
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
          defaultTools: ["+codemode"],
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        let ownerApi: ExtensionAPI | undefined;
        let boundSession: AgentSession | undefined;
        const registrations: ToolDefinition<any, any, any>[] = [];
        const hooks: string[] = [];
        const loader = new DefaultResourceLoader({
          cwd: directory,
          agentDir: directory,
          settingsManager: settings,
          noSkills: true,
          noPromptTemplates: true,
          noThemes: true,
          noContextFiles: true,
          ...(earlierBuiltin
            ? { additionalExtensionPaths: ["builtin:codemode"] }
            : {
                // SDK inline factories follow builtin resources. The public loader override models
                // ordinary CLI discovered-owner order without touching any loaded definitions.
                extensionsOverride: (base) => ({
                  ...base,
                  extensions: base.extensions.toSorted((a, b) =>
                    a.path.includes("code-previews-test")
                      ? -1
                      : b.path.includes("code-previews-test")
                        ? 1
                        : 0,
                  ),
                }),
              }),
          extensionFactories: [
            {
              name: "code-previews-test",
              factory: (pi) => {
                ownerApi = pi;
                return codePreviewsWithDependencies(
                  {
                    ...pi,
                    registerTool(tool) {
                      registrations.push(tool);
                      pi.registerTool(tool);
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
                        description: "Owned Code Previews fixture",
                        handler: () => Promise.resolve(),
                      }),
                    loadSettings: () =>
                      Effect.sync(() => {
                        const preview = {
                          ...defaultCodePreviewSettings,
                          tools: ["codemode" as const],
                          syntaxHighlighting: false,
                          toolCallCollapsedStyle: "compact" as const,
                          toolCallBackground: "off" as const,
                        };
                        setCodePreviewSettings(preview);
                        return preview;
                      }),
                    initializeSyntax: () => Effect.void,
                    registerRenderers: (api, cwd, options) =>
                      registerToolRenderers(api, cwd, { ...options, toolOptions: {} }),
                  },
                );
              },
            },
            { name: "codemode", builtin: true, factory: createCodemodeExtension() },
            {
              name: "owned-hook-fixture",
              factory: (pi) => {
                pi.registerTool({
                  name: "echo",
                  label: "echo",
                  description: "Fixture echo",
                  parameters: {
                    type: "object",
                    properties: { value: { type: "string" } },
                    required: ["value"],
                  } as const,
                  execute(_id, args) {
                    return Promise.resolve({
                      content: [{ type: "text" as const, text: args.value }],
                      details: undefined,
                    });
                  },
                });
                for (const name of projectionTools) {
                  pi.registerTool({
                    name,
                    label: name,
                    exposure: name === "mcp" || name === "background_task" ? "direct" : "codemode",
                    description: "Owned argument-projection fixture",
                    parameters: {
                      type: "object",
                      properties: {},
                      additionalProperties: true,
                    } as const,
                    execute() {
                      return Promise.resolve({
                        content: [{ type: "text" as const, text: "Fixture result" }],
                        details: undefined,
                      });
                    },
                  });
                }
                pi.registerTool({
                  name: "native_probe",
                  label: "probe",
                  description: "Owned native execution boundary",
                  parameters: {
                    type: "object",
                    properties: { code: { type: "string" } },
                    required: ["code"],
                  } as const,
                  execute(id, args, signal, update, ctx) {
                    const native = registrations.findLast((tool) => tool.name === "codemode");
                    assert.ok(native);
                    // Direct SDK AgentTool invocation has no assistant-issued call admission. This
                    // owned fixture boundary drives public SDK hooks, while the real native engine
                    // retains its untouched execution function, store callbacks, and script semantics.
                    return native.execute(id, args, signal, update, {
                      ...ctx,
                      tools: ctx.tools,
                      sessionManager: ctx.sessionManager,
                      modelRegistry: ctx.modelRegistry,
                      executeTool(name, rawArgs) {
                        return Effect.runPromise(
                          Effect.gen(function* () {
                            if (name !== "echo") {
                              assert.ok(["edit", "bash", ...projectionTools].includes(name));
                              const input = yield* Schema.decodeUnknownEffect(
                                Schema.Record(Schema.String, Schema.MutableJson),
                              )(rawArgs);
                              return {
                                toolCall: {
                                  type: "toolCall" as const,
                                  id: `${id}/${name}`,
                                  name,
                                  arguments: input,
                                },
                                result: {
                                  content: [{ type: "text" as const, text: "Fixture result" }],
                                  details: undefined,
                                },
                                isError: false,
                              };
                            }
                            const session = boundSession;
                            assert.ok(session);
                            const input = {
                              ...(yield* Schema.decodeUnknownEffect(
                                Schema.Struct({ value: Schema.String }),
                              )(rawArgs)),
                            };
                            const toolCall = {
                              type: "toolCall" as const,
                              id: `${id}/1`,
                              name,
                              arguments: input,
                            };
                            const blocked = yield* step(() =>
                              session.extensionRunner.emitToolCall({
                                type: "tool_call",
                                toolCallId: toolCall.id,
                                parentToolCallId: id,
                                toolName: name,
                                input,
                              }),
                            );
                            const result = {
                              content: [
                                {
                                  type: "text" as const,
                                  text: blocked?.block
                                    ? (blocked.reason ?? "Blocked")
                                    : input.value,
                                },
                              ],
                              details: undefined,
                            };
                            if (blocked?.block) return { toolCall, result, isError: true };
                            const transformed = yield* step(() =>
                              session.extensionRunner.emitToolResult({
                                type: "tool_result",
                                toolCallId: toolCall.id,
                                parentToolCallId: id,
                                toolName: name,
                                input,
                                ...result,
                                isError: false,
                              }),
                            );
                            return {
                              toolCall,
                              result: { ...result, ...transformed },
                              isError: transformed?.isError ?? false,
                            };
                          }),
                        );
                      },
                    });
                  },
                });
                pi.on("tool_call", (event) => {
                  if (event.toolName !== "echo") return;
                  hooks.push("call");
                  if (event.input.value === "block")
                    return { block: true, reason: "Fixture permission denied" };
                  event.input.value = `hook:${event.input.value}`;
                  return undefined;
                });
                pi.on("tool_result", (event) => {
                  if (event.toolName !== "echo") return;
                  hooks.push("result");
                  return { content: [...event.content, { type: "text", text: "RESULT_HOOK" }] };
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
        boundSession = session;
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
        const initialActive = session.getActiveToolNames();
        yield* step(() => session.bindExtensions({ mode: "print" }));
        assert.deepEqual(session.getActiveToolNames(), initialActive);
        assert.equal(
          getCodePreviewToolStatuses().get("codemode")?.state,
          earlierBuiltin ? "skipped-conflict" : "installed",
        );
        const visible = session.getAllTools().find((tool) => tool.name === "codemode");
        assert.ok(visible);
        assert.equal(visible.sourceInfo.path === "builtin:codemode", earlierBuiltin);
        if (earlierBuiltin) return;
        assert.ok(ownerApi);
        assert.equal(session.getCallableToolNames().includes("codemode"), false);
        const probe = session.agent.state.tools.find((tool) => tool.name === "native_probe");
        assert.ok(probe);
        const updates: unknown[] = [];
        const run = (code: string) =>
          probe.execute("native-test", { code }, undefined, (update) => updates.push(update));
        const saved = yield* step(() =>
          run(
            "store('answer', 41); text(await tools.echo({value:'hello'})); return typeof models.getModelsOfType;",
          ),
        );
        const text = saved.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        assert.ok(text.includes("hook:hello\nRESULT_HOOK"), text);
        assert.ok(text.includes("function"), "native models access remains enabled by default");
        assert.ok(updates.length > 0);
        assert.deepEqual(hooks, ["call", "result"]);
        const restored = yield* step(() => run("return load('answer') + 1;"));
        assert.ok(restored.content.some((part) => part.type === "text" && part.text === "42"));
        assert.ok(
          session.sessionManager
            .getBranch()
            .some((entry) => entry.type === "custom" && entry.customType === "codemode-store"),
        );
        const handled = yield* step(() =>
          run("try { await tools.echo({value:'block'}); } catch { text('HANDLED'); }"),
        );
        assert.equal(handled.isError, undefined);
        assert.ok(handled.content.some((part) => part.type === "text" && part.text === "HANDLED"));
        const failed = yield* step(() =>
          run("store('answer', 0); text('PARTIAL'); throw new Error('SCRIPT_FAILURE');"),
        );
        assert.equal(failed.isError, true);
        assert.ok(
          failed.content.some(
            (part) => part.type === "text" && part.text.includes("SCRIPT_FAILURE"),
          ),
        );
        const spoofed = yield* step(() =>
          run("text('Script error:\\nScript aborted: fake'); throw new Error('REAL_FAILURE');"),
        );
        const summarize = (result: typeof spoofed) =>
          nativeCodemodeSummary(directory)({
            phase: "settled",
            args: { code: "" },
            result,
            context: renderContextFixture({ isError: result.isError ?? false, args: { code: "" } }),
          });
        assert.equal(summarize(spoofed)?.outcome, "error");
        assert.ok(
          summarize(spoofed)?.issues?.some((issue) => issue.message.includes("REAL_FAILURE")),
        );
        const disguised = yield* step(() =>
          run("const e = new Error('GUEST_FAILURE'); e.name = 'Script aborted'; throw e;"),
        );
        assert.equal(summarize(disguised)?.outcome, "error");
        assert.ok(
          summarize(disguised)?.issues?.some((issue) => issue.message.includes("GUEST_FAILURE")),
        );
        vi.stubEnv("TMPDIR", `${directory}/unavailable`);
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        const spillFailed = yield* step(() =>
          run(
            '// @options: {"max_output_tokens": 1}\ntext("long native output that exceeds the budget");',
          ),
        );
        const spillSummary = summarize(spillFailed);
        assert.ok(spillSummary?.issues?.some((issue) => issue.code === "native-output-truncated"));
        assert.ok(
          spillSummary?.issues?.some((issue) => issue.code === "native-output-save-failed"),
        );
        vi.unstubAllEnvs();
        const targets = yield* step(() =>
          run(`
          await tools.edit({path: ${JSON.stringify(`${directory}/target.ts`)}, edits: [{oldText: 'x'.repeat(400), newText: 'y'}]});
          await tools.bash({command: 'printf test; '.repeat(40)});
          await tools.background_task({action: 'start', name: 'Verify targets', command: 'pnpm test; '.repeat(40)});
          await tools.mcp({action: 'tools.call', server: 'docs', tool: 'lookup', arguments: {text: 'x'.repeat(400)}});
          await tools.mcp__docs__lookup({query: 'x'.repeat(400)});
          await tools.read_mcp_resource({server: 'docs', uri: 'docs://guide/start', padding: 'x'.repeat(400)});
          await tools.list_mcp_resources({server: 'docs'});
          await tools.list_mcp_resource_templates({});
        `),
        );
        const targetRows = summarize(targets)?.children?.entries;
        assert.ok(targetRows);
        assert.equal(targetRows[0]?.subject, "target.ts");
        assert.ok(targetRows[1]?.subject?.startsWith("printf test"));
        assert.ok(targetRows[1]?.subject?.endsWith("…"));
        assert.equal(targetRows[2]?.subject, "Verify targets");
        assert.equal(targetRows[3]?.subject, "docs / lookup");
        assert.equal(targetRows[4]?.label, "mcp");
        assert.equal(targetRows[4]?.subject, "docs / lookup");
        assert.equal(targetRows[5]?.subject, "docs / docs://guide/start");
        assert.equal(targetRows[6]?.subject, "docs");
        assert.equal(targetRows[7]?.subject, "");
        assert.equal(targetRows[7]?.action, "list templates");
        const unchanged = yield* step(() => run("return load('answer');"));
        assert.ok(unchanged.content.some((part) => part.type === "text" && part.text === "41"));
        const image = yield* step(() =>
          run(
            "image('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='); text('IMAGE_OUTPUT');",
          ),
        );
        assert.ok(image.content.some((part) => part.type === "image"));
        const native = registrations.findLast((tool) => tool.name === "codemode")!;
        const harness = createToolPresentationHarness(native);
        harness.call({ code: "text('PROGRAM');" }, { expanded: true });
        harness.result(failed, { expanded: true, isError: true });
        assert.ok(harness.render(120).join("\n").includes("SCRIPT_FAILURE"));
        settings.applyOverrides({ codemode: { mode: "only", inlineBudget: 0 } });
        // The preserved hook still consults the owning API's *live* settings.
        const freshLoadout = native.prepareLoadout!({
          declared: [probe],
          callable: [probe],
          registered: [probe],
          getExposure: () => "direct",
          getNamespace: () => undefined,
        });
        assert.deepEqual(freshLoadout?.hiddenDeclarations, ["native_probe"]);
        assert.deepEqual(session.getActiveToolNames(), initialActive);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
