// Public Pi reload boundary: reconstruct the actual retained host row before session_start.
import assert from "node:assert/strict";
import {
  createAgentSession,
  DefaultResourceLoader,
  initTheme,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  ToolExecutionComponent,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { beforeAll, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { registerCodePreviewReplay } from "../../index";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
} from "../../src/application/tool-renderers";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { setCodePreviewSettings } from "../../src/config/state";
import { step } from "../support/effect-test";

beforeAll(() => initTheme("dark", false));
for (const foreign of [false, true])
  it.live(
    `reload reconstructs owned history before startup without changing tool authority (foreign=${foreign})`,
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owned-replay-sdk-" });
        setCodePreviewSettings({
          ...defaultCodePreviewSettings,
          toolCallCollapsedStyle: "compact",
          toolCallTiming: false,
          syntaxHighlighting: false,
        });
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => setCodePreviewSettings(defaultCodePreviewSettings)),
        );
        const settings = SettingsManager.inMemory({
          compaction: { enabled: false },
          retry: { enabled: false },
        });
        const models = yield* step(() =>
          ModelRuntime.create({
            authPath: `${directory}/auth.json`,
            modelsPath: null,
            modelsStorePath: `${directory}/models.json`,
            refreshOnCreate: false,
            allowModelNetwork: false,
          }),
        );
        let executions = 0;
        const tool: ToolDefinition<any, any, any> = {
          name: "owned_replay",
          label: "Owned replay",
          description: "SDK fixture",
          parameters: opaqueFixture({ type: "object", properties: {} }),
          exposure: "model-only",
          execute: () => {
            executions += 1;
            return Promise.resolve({ content: [], details: undefined });
          },
          renderCall: (args) => new Text(`OWNED_INPUT ${JSON.stringify(args)}`, 0, 0),
          renderResult: (value) =>
            new Text(
              value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
              0,
              0,
            ),
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
            ...(foreign
              ? [
                  {
                    name: "foreign",
                    factory: (pi: Parameters<typeof registerCodePreviewReplay>[0]) => {
                      pi.registerTool({
                        ...tool,
                        renderCall: () => new Text("FOREIGN_RENDERER", 0, 0),
                      });
                    },
                  },
                ]
              : []),
            {
              name: "code-previews",
              factory: (pi) => {
                const owner = new CodePreviewPresentationOwner();
                pi.registerToolRenderer(
                  createCodePreviewRendererResolver(pi, () => owner, new Set()),
                );
                pi.on("session_shutdown", () => owner.retire());
              },
            },
            {
              name: "fixture-owner",
              factory: (pi) => {
                pi.registerCommand("fixture-owner", {
                  description: "Ownership anchor",
                  handler: () => Promise.resolve(),
                });
                const replay = registerCodePreviewReplay(pi, {
                  command: "fixture-owner",
                  tools: [tool.name],
                });
                pi.on("session_start", () => {
                  try {
                    pi.registerTool(
                      replay.shell(tool, {
                        compactSummary: () => ({ subject: "OWNED_SUMMARY", outcome: "returned" }),
                      }),
                    );
                    replay.publish();
                  } finally {
                    replay.finishStartup();
                  }
                });
                pi.on("session_shutdown", () => replay.retire());
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
          ).pipe(Effect.ensuring(Effect.sync(() => session.dispose()))),
        );
        const historyRow = () => {
          const renderers = session.extensionRunner.resolveToolRenderers(tool.name, () =>
            session.getToolDefinition(tool.name),
          );
          const row = new ToolExecutionComponent(
            tool.name,
            "past-call",
            { input: "FULL_INPUT" },
            { showImages: false },
            renderers,
            opaqueFixture({ requestRender() {} }),
            directory,
          );
          row.updateResult({
            content: [{ type: "text", text: "FULL_OUTPUT recovery /tmp/receipt.txt" }],
            details: undefined,
            isError: false,
          });
          return row;
        };
        // New/resumed sessions also render before bindExtensions starts their runtime.
        let retained = historyRow();
        assert.ok(!retained.render(160).join("\n").includes("OWNED_SUMMARY"));
        const errors: string[] = [];
        yield* step(() =>
          session.bindExtensions({ mode: "print", onError: (error) => errors.push(error.error) }),
        );
        const expected = foreign ? "FOREIGN_RENDERER" : "OWNED_SUMMARY";
        assert.ok(retained.render(160).join("\n").includes(expected));
        const active = session.getActiveToolNames();
        const callable = session.getCallableToolNames();
        const originalSource = session
          .getAllTools()
          .find((entry) => entry.name === tool.name)?.sourceInfo;
        yield* step(() =>
          session.reload({
            beforeSessionStart: () => {
              retained = historyRow();
              assert.ok(!retained.render(160).join("\n").includes("OWNED_SUMMARY"));
            },
          }),
        );
        assert.ok(retained.render(160).join("\n").includes(expected));
        const frames = [true, false, true].map((expanded) => {
          retained.setExpanded(expanded);
          retained.invalidate();
          return { expanded, text: retained.render(160).join("\n") };
        });
        for (const { text } of frames.filter((frame) => frame.expanded))
          assert.ok(text.includes("FULL_OUTPUT recovery /tmp/receipt.txt"));
        for (const { text } of frames.filter((frame) => frame.expanded && !foreign))
          assert.ok(text.includes("FULL_INPUT"));
        assert.deepEqual(session.getActiveToolNames(), active);
        assert.deepEqual(session.getCallableToolNames(), callable);
        const registered = session.getAllTools().filter((entry) => entry.name === tool.name);
        assert.equal(registered.length, 1);
        assert.deepEqual(registered[0]?.sourceInfo, originalSource);
        assert.equal(registered[0]?.exposure, "model-only");
        assert.equal(executions, 0);
        assert.deepEqual(errors, []);
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
    15_000,
  );
