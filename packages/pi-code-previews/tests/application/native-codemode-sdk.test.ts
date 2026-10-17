import assert from "node:assert/strict";
import {
  createCodemodeExtension,
  defineTool,
  type AgentSession,
  type ToolDefinition,
  type ToolRendererResolver,
} from "@earendil-works/pi-coding-agent";
import { it } from "@effect/vitest";
import { vi } from "vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { getCodePreviewToolStatuses } from "../../src/tools/status";
import { step } from "../support/effect-test";
import { codePreviewsUnderTest, offlineModels, scopedSession } from "../support/sdk-session";
import { quietLoader, quietSettings } from "pi-cosmic-core/testing/sdk";
import { createToolPresentationHarness, renderContextFixture } from "../../testing";
import { nativeCodemodeSummary } from "../../src/tools/native-codemode-summary";
import type { CompactSummary } from "../../src/tools/compact-summary";
import { executeDescriptor } from "../support/tool-identity";

interface BoundSession {
  session?: AgentSession;
}

function assertScriptFailure(summary: CompactSummary | undefined, marker: string): void {
  assert.equal(summary?.outcome, "error");
  assert.ok(summary?.issues?.some((issue) => issue.message.includes(marker)));
}

function assertSpillIssues(summary: CompactSummary | undefined): void {
  assert.ok(summary?.issues?.some((issue) => issue.code === "native-output-truncated"));
  assert.ok(summary?.issues?.some((issue) => issue.code === "native-output-save-failed"));
}

it.live(
  "native SDK renderer selection preserves independently loaded builtin execution/store/hooks",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "preview-native-sdk-" });
      const models = yield* offlineModels(directory);
      const settings = quietSettings({ defaultTools: ["+codemode"] });
      const bound: BoundSession = {};
      const nativeDefinitions: ToolDefinition[] = [];
      const rendererRegistrations: ToolRendererResolver[] = [];
      const hooks: string[] = [];
      const presentation = codePreviewsUnderTest(
        directory,
        {
          tools: ["codemode"],
          syntaxHighlighting: false,
          toolCallCollapsedStyle: "compact",
          toolCallBackground: "off",
        },
        {
          api: (pi) => ({
            registerTool() {
              throw new Error("presentation must not replace native execution");
            },
            registerToolRenderer(resolver) {
              rendererRegistrations.push(resolver);
              pi.registerToolRenderer(resolver);
            },
          }),
        },
      );
      const loader = yield* quietLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: settings,
        extensionFactories: [
          {
            name: "code-previews-test",
            factory: presentation,
          },
          {
            name: "codemode",
            builtin: true,
            factory: (pi) =>
              createCodemodeExtension()({
                ...pi,
                registerTool(tool) {
                  nativeDefinitions.push(defineTool(tool));
                  pi.registerTool(tool);
                },
              }),
          },
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
                  const native = nativeDefinitions.findLast((tool) => tool.name === "codemode");
                  assert.ok(native);
                  return native.execute(id, args, signal, update, {
                    ...ctx,
                    tools: ctx.tools,
                    sessionManager: ctx.sessionManager,
                    modelRegistry: ctx.modelRegistry,
                    executeTool(name, rawArgs) {
                      return Effect.runPromise(
                        Effect.gen(function* () {
                          const session = bound.session;
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
                                text: blocked?.block ? (blocked.reason ?? "Blocked") : input.value,
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
                if (event.toolName !== "echo") return undefined;
                hooks.push("call");
                if (event.input.value === "block")
                  return { block: true, reason: "Fixture permission denied" };
                event.input.value = `hook:${String(event.input.value)}`;
                return undefined;
              });
              pi.on("tool_result", (event) => {
                if (event.toolName !== "echo") return undefined;
                hooks.push("result");
                return { content: [...event.content, { type: "text", text: "RESULT_HOOK" }] };
              });
            },
          },
        ],
      });
      const native = nativeDefinitions[0]!;
      assert.ok(native);
      const original = {
        execute: executeDescriptor(native),
        parameters: native.parameters,
        prepareLoadout: native.prepareLoadout,
        exposure: native.exposure,
        defaultActive: native.defaultActive,
      };
      const session = yield* scopedSession({ cwd: directory, models, settings, loader });
      bound.session = session;
      const initialActive = session.getActiveToolNames();
      yield* step(() => session.bindExtensions({ mode: "print" }));
      assert.deepEqual(session.getActiveToolNames(), initialActive);
      assert.equal(getCodePreviewToolStatuses().get("codemode")?.state, "installed");
      assert.equal(rendererRegistrations.length, 1);
      assert.equal(nativeDefinitions.length, 1);
      const visible = session.getAllTools().find((tool) => tool.name === "codemode");
      assert.ok(visible);
      assert.equal(visible.sourceInfo.source, "builtin");
      assert.equal(visible.sourceInfo.path, "builtin:codemode");
      assert.equal(session.getCallableToolNames().includes("codemode"), false);
      const probe = session.agent.state.tools.find((tool) => tool.name === "native_probe");
      assert.ok(probe);
      const updates: unknown[] = [];
      const run = (code: string) =>
        probe.execute("native-test", { code }, undefined, (update) => updates.push(update));
      const saved = yield* step(() =>
        run("store('answer', 41); text(await tools.echo({value:'hello'}));"),
      );
      const text = saved.content
        .filter((part) => part.type === "text")
        .map((part) => part.text)
        .join("\n");
      assert.ok(text.includes("hook:hello\nRESULT_HOOK"), text);
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
        failed.content.some((part) => part.type === "text" && part.text.includes("SCRIPT_FAILURE")),
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
      assertScriptFailure(summarize(spoofed), "REAL_FAILURE");
      const disguised = yield* step(() =>
        run("const e = new Error('GUEST_FAILURE'); e.name = 'Script aborted'; throw e;"),
      );
      assertScriptFailure(summarize(disguised), "GUEST_FAILURE");
      vi.stubEnv("TMPDIR", `${directory}/unavailable`);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const spillFailed = yield* step(() =>
        run(
          '// @options: {"max_output_tokens": 1}\ntext("long native output that exceeds the budget");',
        ),
      );
      assertSpillIssues(summarize(spillFailed));
      vi.unstubAllEnvs();
      const unchanged = yield* step(() => run("return load('answer');"));
      assert.ok(unchanged.content.some((part) => part.type === "text" && part.text === "41"));
      const image = yield* step(() =>
        run(
          "image('data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII='); text('IMAGE_OUTPUT');",
        ),
      );
      assert.ok(image.content.some((part) => part.type === "image"));
      const renderers = session.extensionRunner.resolveToolRenderers("codemode", () => native)!;
      assert.equal(renderers.renderShell, "self");
      assert.deepEqual(executeDescriptor(native), original.execute);
      assert.equal(native.parameters, original.parameters);
      assert.equal(native.prepareLoadout, original.prepareLoadout);
      assert.equal(native.exposure, original.exposure);
      assert.equal(native.defaultActive, original.defaultActive);
      assert.equal(visible.parameters, native.parameters);
      const harness = createToolPresentationHarness(renderers);
      harness.call({ code: "text('PROGRAM');" }, { expanded: true });
      harness.result(failed, { expanded: true, isError: true });
      assert.ok(harness.render(120).join("\n").includes("SCRIPT_FAILURE"));
      const imageBefore = structuredClone(image);
      for (const frame of harness.cycle({ code: "text('PROGRAM');" }, image, {
        overrides: () => ({ isError: false, showImages: false }),
      })) {
        if (frame.expanded) {
          assert.ok(frame.text.includes("IMAGE_OUTPUT"));
          assert.ok(frame.text.includes("image/png"));
        }
      }
      assert.deepEqual(image, imageBefore);
      settings.applyOverrides({ codemode: { mode: "only", inlineBudget: 0 } });
      const freshLoadout = native.prepareLoadout!({
        declared: [probe],
        callable: [probe],
        registered: [probe],
        getExposure: () => "direct",
        getNamespace: () => undefined,
        getPromptGuidelines: () => [],
      });
      assert.deepEqual(freshLoadout?.hiddenDeclarations, ["native_probe"]);
      assert.deepEqual(session.getActiveToolNames(), initialActive);
      assert.equal(nativeDefinitions.length, 1);
      assert.equal(rendererRegistrations.length, 1);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
);
