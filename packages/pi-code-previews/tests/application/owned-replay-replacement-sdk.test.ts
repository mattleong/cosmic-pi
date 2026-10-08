// Actual /resume and interactive /fork replacement boundaries, without provider calls.
import assert from "node:assert/strict";
import {
  createAgentSessionFromServices,
  createAgentSessionRuntime,
  createAgentSessionServices,
  initTheme,
  SessionManager,
  ToolExecutionComponent,
  type AgentSession,
  type CreateAgentSessionRuntimeFactory,
  type ToolDefinition,
  type ToolRenderers,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, Image, setCapabilities, Text } from "@earendil-works/pi-tui";
import { beforeAll, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import { opaqueFixture } from "pi-cosmic-core/testing";
import { registerCodePreviewReplay } from "../../index";
import { drawToolRow } from "../../testing";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { step } from "../support/effect-test";
import { QUIET_RESOURCES } from "pi-cosmic-core/testing/sdk";
import { offlineModels } from "../support/sdk-session";
import { quietSettings } from "pi-cosmic-core/testing/sdk";
import { setPlainPreviewSettings } from "../support/renderer-host";

beforeAll(() => initTheme("dark", false));

/** Pi invokes these Promise-shaped replacement callbacks outside the test fiber. */
const runSdkHostCallback = <A>(effect: Effect.Effect<A>) => Effect.runPromise(effect);

const toolName = "owned_replay_replacement";
const args = { input: "FULL_INPUT", nested: { lines: ["INPUT_HEAD", "INPUT_TAIL"] } };
const output = Array.from({ length: 20 }, (_, index) => `FULL_OUTPUT_${index}`).join("\n");
const recovery = "Read retained evidence from /tmp/owned-replay-receipt.txt";
const result = {
  role: "toolResult" as const,
  toolCallId: "historical-owned-call",
  toolName,
  content: [
    { type: "text" as const, text: output },
    { type: "text" as const, text: recovery },
    {
      type: "image" as const,
      mimeType: "image/png",
      data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=",
    },
  ],
  details: { retainedPath: "/tmp/owned-replay-receipt.txt", evidence: "FULL_DETAILS" },
  isError: false,
  timestamp: 3,
};
const authority = (session: AgentSession) => ({
  active: session.getActiveToolNames(),
  callable: session.getCallableToolNames(),
  tools: session.getAllTools(),
});
const setStyle = (style: "preview" | "compact") =>
  setPlainPreviewSettings({ toolCallCollapsedStyle: style });
const draw = (row: ToolExecutionComponent, expanded = false) => drawToolRow(row, expanded, 180);

/** Reconstruct exclusively from SDK-restored messages, not the fixture inputs. */
function historicalRows(session: AgentSession) {
  const assistant = session.messages.find((message) => message.role === "assistant");
  assert.ok(assistant?.role === "assistant");
  const call = assistant.content.find((part) => part.type === "toolCall");
  assert.ok(call?.type === "toolCall");
  const restored = session.messages.find(
    (message) => message.role === "toolResult" && message.toolCallId === call.id,
  );
  assert.ok(restored?.role === "toolResult");
  assert.deepEqual(call.arguments, args);
  assert.deepEqual(restored, result);
  const resolve = () =>
    session.extensionRunner.resolveToolRenderers(call.name, () =>
      session.getToolDefinition(call.name),
    );
  const makeRow = (renderers: ToolRenderers | undefined) => {
    const row = new ToolExecutionComponent(
      call.name,
      call.id,
      call.arguments,
      { showImages: true },
      renderers,
      opaqueFixture({ requestRender() {} }),
      session.sessionManager.getCwd(),
    );
    row.setArgsComplete();
    row.updateResult(restored);
    return row;
  };
  const cold = resolve();
  // One row is drawn cold; another is constructed but not drawn until after retirement.
  const row = makeRow(cold);
  const undrawn = makeRow(cold);
  // No render callback for this facade runs until its originating owner is retired.
  const lazy = resolve();
  const image = row.children.find((child) => child instanceof Image);
  assert.ok(image, "Pi keeps the native image child outside the renderer shell");
  return { row, undrawn, lateRow: () => makeRow(lazy), restored, image };
}

it.live(
  "SDK resume and user-entry fork adopt the same historical rows without transferring owner authority",
  () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "owned-replacement-sdk-" });
      const originalSettings = codePreviewSettings;
      const originalCapabilities = getCapabilities();
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          setCodePreviewSettings(originalSettings);
          setCapabilities(originalCapabilities);
        }),
      );
      setCapabilities({ ...originalCapabilities, images: "kitty" });
      setStyle("preview");
      const persisted = SessionManager.create(directory, `${directory}/sessions`);
      persisted.appendMessage({ role: "user", content: "Inspect the owned result", timestamp: 1 });
      persisted.appendMessage({
        role: "assistant",
        content: [{ type: "toolCall", id: result.toolCallId, name: toolName, arguments: args }],
        api: "openai-responses",
        provider: "openai",
        model: "historical-fixture",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "toolUse",
        timestamp: 2,
      });
      persisted.appendMessage(result);
      const selectedText = "Continue after the historical owned result";
      const forkEntry = persisted.appendMessage({
        role: "user",
        content: selectedText,
        timestamp: 4,
      });
      const sessionFile = persisted.getSessionFile();
      assert.ok(sessionFile);
      assert.equal(yield* fs.exists(sessionFile), true);
      const models = yield* offlineModels(directory);
      const settings = quietSettings();
      let executions = 0;
      let observedArgs: unknown;
      let observedResult: unknown;
      const tool: ToolDefinition<any, any, any> = {
        name: toolName,
        label: "Owned replay",
        description: "SDK historical renderer fixture",
        parameters: opaqueFixture({ type: "object", properties: {} }),
        exposure: "model-only",
        defaultActive: false,
        execute: () => {
          executions += 1;
          return Promise.resolve({ content: [], details: undefined });
        },
        renderCall: (input) => {
          observedArgs = input;
          return new Text(`OWNED_INPUT ${JSON.stringify(input)}`, 0, 0);
        },
        renderResult: (value) => {
          observedResult = value;
          return new Text(
            value.content.flatMap((part) => (part.type === "text" ? [part.text] : [])).join("\n"),
            0,
            0,
          );
        },
      };
      let startupStyle: "compact" | "preview" = "preview";
      let binding: AgentSession | undefined;
      const beforePublish = new Map<string, ReturnType<typeof authority>>();
      const starts: string[] = [];
      const shutdowns: string[] = [];
      const createRuntime: CreateAgentSessionRuntimeFactory = ({
        cwd,
        agentDir,
        sessionManager,
        sessionStartEvent,
      }) =>
        runSdkHostCallback(
          Effect.gen(function* () {
            const services = yield* step(() =>
              createAgentSessionServices({
                cwd,
                agentDir,
                modelRuntime: models,
                settingsManager: settings,
                resourceLoaderOptions: {
                  ...QUIET_RESOURCES,
                  extensionFactories: [
                    {
                      name: "fixture-owner",
                      factory: (pi) => {
                        pi.registerCommand("fixture-owner", {
                          description: "Owned replay anchor",
                          handler: () => Promise.resolve(),
                        });
                        const replay = registerCodePreviewReplay(pi, {
                          command: "fixture-owner",
                          tools: [toolName],
                        });
                        pi.on("session_start", (event, ctx) => {
                          try {
                            // The owner loads its trusted appearance only at startup, not factory time.
                            setStyle(startupStyle);
                            const wrapped = replay.shell(tool, {
                              compactSummary: () => ({
                                subject: "OWNED_SUMMARY",
                                outcome: "returned",
                              }),
                            });
                            assert.equal(wrapped.execute, tool.execute);
                            assert.equal(wrapped.parameters, tool.parameters);
                            pi.registerTool(wrapped);
                            assert.ok(binding);
                            assert.equal(binding.sessionId, ctx.sessionManager.getSessionId());
                            beforePublish.set(binding.sessionId, authority(binding));
                            replay.publish();
                            starts.push(event.reason);
                          } finally {
                            replay.finishStartup();
                          }
                        });
                        pi.on("session_shutdown", (event) => {
                          replay.retire();
                          shutdowns.push(event.reason);
                        });
                      },
                    },
                  ],
                },
              }),
            );
            const created = yield* step(() =>
              createAgentSessionFromServices({
                services,
                sessionManager,
                ...(sessionStartEvent && { sessionStartEvent }),
              }),
            );
            return { ...created, services, diagnostics: services.diagnostics };
          }),
        );
      const runtime = yield* step(() =>
        createAgentSessionRuntime(createRuntime, {
          cwd: directory,
          agentDir: directory,
          sessionManager: SessionManager.inMemory(directory),
        }),
      );
      yield* Effect.addFinalizer(() => step(() => runtime.dispose()));
      const errors: string[] = [];
      const bind = (session: AgentSession) => {
        binding = session;
        return session.bindExtensions({
          mode: "print",
          onError: (error) => errors.push(error.error),
        });
      };
      yield* step(() => bind(runtime.session));
      const initial = runtime.session;
      const initialAuthority = authority(initial);
      const retained: ReturnType<typeof historicalRows>[] = [];
      runtime.setRebindSession((session) =>
        runSdkHostCallback(
          Effect.gen(function* () {
            assert.equal(session.getToolDefinition(toolName), undefined);
            const rows = historicalRows(session);
            retained.push(rows);
            const coldText = rows.row.render(180).join("\n");
            assert.ok(coldText.includes("FULL_INPUT"));
            assert.ok(coldText.includes("FULL_OUTPUT_19"));
            assert.ok(!coldText.includes("OWNED_INPUT"));
            assert.ok(!coldText.includes("OWNED_SUMMARY"));
            yield* step(() => bind(session));
            // Crucially keep and draw the exact component constructed before bindExtensions.
            const readyText = draw(rows.row);
            assert.ok(
              readyText.includes(startupStyle === "compact" ? "OWNED_SUMMARY" : "OWNED_INPUT"),
            );
            assert.deepEqual(authority(session), beforePublish.get(session.sessionId));
          }),
        ),
      );

      startupStyle = "compact";
      assert.deepEqual(yield* step(() => runtime.switchSession(sessionFile)), { cancelled: false });
      const resumed = runtime.session;
      const resumedRows = retained[0]!;
      // SDK restoration may append its own model/thinking entries before presentation begins.
      const resumedFile = yield* fs.readFileString(sessionFile);
      assert.notEqual(resumed, initial);
      assert.equal(resumed.sessionFile, sessionFile);
      assert.notEqual(resumed.sessionManager, persisted);
      assert.deepEqual(starts, ["startup", "resume"]);
      assert.deepEqual(shutdowns, ["resume"]);
      assert.deepEqual(authority(resumed), initialAuthority);
      // Ambient settings may change before the next draw; first readiness, not draw time, wins.
      setStyle("preview");
      assert.ok(draw(resumedRows.row).includes("OWNED_SUMMARY"));

      startupStyle = "preview";
      setStyle("compact");
      assert.deepEqual(yield* step(() => runtime.fork(forkEntry)), {
        cancelled: false,
        selectedText,
      });
      const forked = runtime.session;
      const forkedRows = retained[1]!;
      assert.notEqual(forked, resumed);
      assert.notEqual(forked.sessionFile, sessionFile);
      assert.ok(forked.sessionFile?.startsWith(`${directory}/sessions/`));
      assert.equal(forked.sessionManager.getHeader()?.parentSession, sessionFile);
      assert.equal(
        forked.messages.some(
          (message) => message.role === "user" && message.content === selectedText,
        ),
        false,
      );
      assert.ok(
        forked.messages.some(
          (message) => message.role === "toolResult" && message.toolCallId === result.toolCallId,
        ),
      );
      assert.deepEqual(starts, ["startup", "resume", "fork"]);
      assert.deepEqual(shutdowns, ["resume", "fork"]);
      assert.deepEqual(authority(forked), initialAuthority);
      assert.ok(!draw(forkedRows.row).includes("OWNED_SUMMARY"));
      // Adopted rows keep their retired owner's compact style, even if never drawn while ready.
      for (const row of [resumedRows.row, resumedRows.undrawn])
        assert.ok(draw(row).includes("OWNED_SUMMARY"));
      const lazyOldRow = resumedRows.lateRow();
      const lazyText = draw(lazyOldRow, true);
      assert.ok(!lazyText.includes("OWNED_INPUT"));
      assert.ok(!lazyText.includes("OWNED_SUMMARY"));
      assert.ok(lazyText.includes("FULL_INPUT"));
      assert.ok(lazyText.includes("FULL_OUTPUT_19"));
      assert.ok(lazyText.includes(recovery));

      for (const rows of retained) {
        for (const expanded of [true, false, true]) {
          const text = draw(rows.row, expanded);
          if (expanded) {
            for (const input of ["FULL_INPUT", "INPUT_HEAD", "INPUT_TAIL"])
              assert.ok(text.includes(input));
            for (const line of output.split("\n")) assert.ok(text.includes(line));
            assert.ok(text.includes(recovery));
            assert.deepEqual(observedArgs, args);
            assert.deepEqual(observedResult, { content: result.content, details: result.details });
          }
          assert.ok(rows.row.children.includes(rows.image));
          assert.deepEqual(rows.restored, result);
        }
      }
      assert.deepEqual(authority(forked), beforePublish.get(forked.sessionId));
      const registered = forked.getAllTools().filter((entry) => entry.name === toolName);
      assert.equal(registered.length, 1);
      assert.equal(registered[0]?.exposure, "model-only");
      assert.equal(forked.getActiveToolNames().includes(toolName), false);
      assert.equal(forked.getCallableToolNames().includes(toolName), false);
      assert.equal(forked.getToolDefinition(toolName)?.execute, tool.execute);
      assert.equal(executions, 0);
      assert.deepEqual(errors, []);
      assert.equal(yield* fs.readFileString(sessionFile), resumedFile);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  15_000,
);
