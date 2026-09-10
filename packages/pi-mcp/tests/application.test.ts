import { it } from "@effect/vitest";
import * as FileSystem from "effect/FileSystem";
import { nodeFilePlatformLayer } from "pi-cosmic-core";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { describe, expect, vi } from "vitest";
import { registerMcpApplication } from "../src/application/register.ts";
import { McpAuth } from "../src/auth/service.ts";
import { McpConfigStore } from "../src/config/store.ts";
import { DEFAULT_MCP_SETTINGS } from "../src/config/schema.ts";
import { McpGatewayReplySchema, type McpGatewayReply } from "../src/tools/model.ts";
import * as Schema from "effect/Schema";
import { boundaryError } from "../src/client/errors.ts";
const host = <A>(run: () => PromiseLike<A>) => Effect.tryPromise(run);
import { McpExecution } from "../src/tools/service.ts";
import { makeMcpLayer } from "../src/layer.ts";

// This test runs the PUBLIC pinned Pi SDK agent loop. The provider and MCP execution
// service are in-memory fakes; Pi registration, middleware, agent finalization and
// session storage use their real implementations. No private source extraction.
describe("pinned Pi MCP application", () => {
  it.live(
    "composes all live services for untrusted local status without connection or credential admission",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-mcp-live-layer-" });
        vi.stubEnv("PI_CODING_AGENT_DIR", directory);
        yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
        yield* Effect.gen(function* () {
          const execution = yield* McpExecution;
          expect(execution.isAvailable()).toBe(false);
          for (const input of [
            null,
            [],
            { action: null },
            { action: "invalid" },
            { extra: true },
            { server: "missing" },
            { action: "status", extra: true },
            { action: undefined },
          ]) {
            expect(
              yield* Effect.result(
                execution.execute(input, { maxOutputBytes: 4_096, images: false }),
              ),
            ).toMatchObject({
              _tag: "Failure",
              failure: { kind: "invalid-input", outcome: "not-sent" },
            });
          }
          const status = yield* execution.execute({}, { maxOutputBytes: 4_096, images: false });
          expect(status.reply).toMatchObject({
            action: "status",
            outcome: "completed",
            data: { result: { trusted: false, servers: [], metadata: [] } },
          });
          expect(
            yield* Effect.result(
              execution.execute(
                { action: "connect", server: "missing" },
                { maxOutputBytes: 4_096, images: false },
              ),
            ),
          ).toMatchObject({ _tag: "Failure", failure: { outcome: "not-sent" } });
        }).pipe(
          Effect.provide(
            makeMcpLayer({ cwd: directory, projectTrusted: false, isTrusted: () => false }),
          ),
        );
      }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );

  it.live("persists tool-reported failure as isError=true without losing completed details", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const directory = yield* fs.makeTempDirectoryScoped({ prefix: "pi-mcp-agent-" });
      vi.stubEnv("PI_CODING_AGENT_DIR", directory);
      yield* Effect.addFinalizer(() => Effect.sync(() => vi.unstubAllEnvs()));
      const failure: McpGatewayReply = {
        action: "tools.call",
        outcome: "completed",
        isError: true,
        data: {
          content: [{ type: "text", text: "Rejected by MCP tool" }],
          structuredContent: { accepted: false },
        },
        resultId: "recoverable",
        notices: [],
      };
      const config = {
        revision: 1,
        trusted: true,
        settings: DEFAULT_MCP_SETTINGS,
        servers: {},
        diagnostics: [],
      };
      const fake = fauxProvider({ provider: "mcp-test-faux", tokensPerSecond: 0 });
      fake.setResponses([
        fauxAssistantMessage(
          fauxToolCall(
            "mcp",
            { action: "tools.call", server: "fixture", tool: "reject" },
            { id: "owned-call" },
          ),
          { stopReason: "toolUse" },
        ),
        fauxAssistantMessage("The tool rejected the request."),
      ]);
      const models = yield* host(() =>
        ModelRuntime.create({
          credentials: new InMemoryCredentialStore(),
          modelsStore: new InMemoryModelsStore(),
          modelsPath: null,
          refreshOnCreate: false,
          allowModelNetwork: false,
        }),
      );
      models.registerNativeProvider(fake.provider);
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => models.unregisterProvider(fake.provider.id)),
      );
      let acquired = 0;
      let released = 0;
      const application = Layer.mergeAll(
        Layer.effect(
          McpExecution,
          Effect.acquireRelease(
            Effect.sync(() => {
              acquired++;
              return {
                execute: () => Effect.succeed({ reply: failure, images: [] }),
                login: () => Effect.succeed({ state: "ready" as const }),
                logout: () => Effect.void,
                available: Effect.succeed(true),
                isAvailable: () => true,
              };
            }),
            () =>
              Effect.sync(() => {
                released++;
              }),
          ),
        ),
        Layer.succeed(McpConfigStore, {
          snapshot: Effect.succeed(config),
          subscribe: () => Effect.void,
          reload: Effect.succeed(config),
          setServer: () => Effect.succeed(config),
          removeServer: () => Effect.succeed(config),
          setSettings: () => Effect.succeed(config),
        }),
        Layer.succeed(McpAuth, {
          access: () => Effect.succeed(undefined),
          status: () => Effect.succeed({ state: "none" }),
          login: () => Effect.succeed({ state: "ready" }),
          logout: () => Effect.void,
          revoke: Effect.void,
        }),
      );
      const settings = SettingsManager.inMemory({
        compaction: { enabled: false },
        retry: { enabled: false },
      });
      const loader = new DefaultResourceLoader({
        cwd: directory,
        agentDir: directory,
        settingsManager: settings,
        noExtensions: true,
        noSkills: true,
        noPromptTemplates: true,
        noThemes: true,
        noContextFiles: true,
        extensionFactories: [
          (pi) =>
            registerMcpApplication(pi, {
              makeLayer: () => application,
              loadSettings: () => Promise.resolve(),
              wrapTool: (tool) => tool,
            }),
        ],
      });
      yield* host(() => loader.reload());
      expect(acquired).toBe(0);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const { session } = yield* Effect.acquireRelease(
            host(() =>
              createAgentSession({
                cwd: directory,
                agentDir: directory,
                model: fake.getModel(),
                modelRuntime: models,
                settingsManager: settings,
                sessionManager: SessionManager.inMemory(directory),
                resourceLoader: loader,
                noTools: "builtin",
              }),
            ),
            ({ session }) =>
              host(() =>
                session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }),
              ).pipe(Effect.orDie, Effect.ensuring(Effect.sync(() => session.dispose()))),
          );
          yield* host(() => session.bindExtensions({ mode: "print" }));
          expect(acquired).toBe(1);
          yield* host(() => session.prompt("Call the fixture tool."));
          const result = session.messages.find(
            (message) => message.role === "toolResult" && message.toolCallId === "owned-call",
          );
          expect(result).toMatchObject({ role: "toolResult", isError: true, details: failure });
          if (result?.role !== "toolResult")
            return yield* boundaryError("protocol", "not-sent", "Expected the MCP tool result");
          expect(result.content).toEqual([
            {
              type: "text",
              text: Schema.encodeSync(Schema.fromJsonString(McpGatewayReplySchema))(failure),
            },
          ]);
          expect(
            session.sessionManager
              .getEntries()
              .some(
                (entry) =>
                  entry.type === "message" &&
                  entry.message.role === "toolResult" &&
                  entry.message.isError &&
                  entry.message.details.resultId === "recoverable",
              ),
          ).toBe(true);
          expect(fake.state.callCount).toBe(2);
        }),
      );
      expect(released).toBe(1);
    }).pipe(Effect.provide(nodeFilePlatformLayer)),
  );
});
