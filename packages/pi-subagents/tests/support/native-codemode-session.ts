// Public SDK host boundary: real agent loop, nested tool hooks and native QuickJS; no inference.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type AuthOperationOptions,
  type JsonObject,
  type ModelType,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { registerSubagentErrorReceipts } from "../../src/boundary/host-tool-result.ts";
import { makeSubagentBackendRegistry, SubagentBackendRegistry } from "../../src/backend/service.ts";
import type { BackendDriver } from "../../src/backend/model.ts";
import { SubagentProfileService } from "../../src/profiles/service.ts";
import { SubagentService, type SubagentServiceContract } from "../../src/run/service.ts";
import { registerSubagentTools } from "../../src/tools/subagent.ts";
import { declaredCandidate } from "../fixtures/profiles.ts";
import { profileServiceFor } from "../tools/fixtures/tool-harness.ts";
import { step } from "./effect-test.ts";

const driver: BackendDriver = {
  host: "local",
  runtime: "claude",
  capabilities: [],
  supportsContext: (context) => context === "fresh",
  preflight: () => Effect.void,
  spawn: () => Effect.die("The session fixture delegates spawning to its owned service boundary."),
};
const registry = makeSubagentBackendRegistry([driver]);
const profilesFor = () =>
  profileServiceFor({
    profiles: {
      scout: [declaredCandidate("sonnet", { runtime: "claude" })],
      reviewer: [declaredCandidate("sonnet", { runtime: "claude" })],
      worker: [declaredCandidate("sonnet", { runtime: "claude", writeIntent: "writer" })],
      generalist: [declaredCandidate("sonnet", { runtime: "claude" })],
    },
  });

/** An authenticated local-only classifier that launch paths must never consult. */
const CLASSIFIER_FIXTURE_PROVIDER = "workflow-classifier-test";

interface NativeCodemodeSessionOptions {
  readonly classifier?: "reviewer" | "throws";
  readonly proxy?: boolean;
}

export const nativeCodemodeSession = (
  service: SubagentServiceContract,
  options: NativeCodemodeSessionOptions = {},
) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "subagents-workflow-" });
    const fake = fauxProvider({ provider: "workflow-session-test", tokensPerSecond: 0 });
    const models = yield* step(() =>
      ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: null,
        refreshOnCreate: false,
        allowModelNetwork: false,
      }),
    );
    models.registerNativeProvider(fake.provider);
    // Availability stays fixture-only: a provider authenticated by the developer's environment
    // must never be preferred, reached, or required by these tests.
    let catalogLookups = 0;
    let classifierCalls = 0;
    const listAvailable = models.getAvailableOfType.bind(models);
    models.getAvailableOfType = <TType extends ModelType>(
      type: TType,
      providerId?: string,
      authOptions?: AuthOperationOptions,
    ) => {
      if (type !== "classifier") return listAvailable(type, providerId, authOptions);
      catalogLookups += 1;
      return listAvailable(type, providerId, authOptions).then((available) =>
        available.filter((model) => model.provider === CLASSIFIER_FIXTURE_PROVIDER),
      );
    };
    if (options.classifier)
      models.registerProvider(CLASSIFIER_FIXTURE_PROVIDER, {
        apiKey: "fixture-only-key",
        baseUrl: "http://127.0.0.1:9",
        models: [
          {
            type: "classifier",
            id: "jev-fixture",
            name: "Workflow classifier fixture",
            api: "workflow-classifier-test",
            input: ["text"],
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
            contextWindow: 16_000,
          },
        ],
        classifiers: {
          "workflow-classifier-test": {
            classify: (model) => {
              classifierCalls += 1;
              if (options.classifier === "throws")
                return Promise.reject(new Error("Profile selection must not call a classifier"));
              return Promise.resolve({
                api: model.api,
                provider: model.provider,
                model: model.id,
                timestamp: 1,
                stopReason: "stop",
                answers: {
                  profile: {
                    type: "choice",
                    choice: "reviewer",
                    probabilities: { reviewer: 1 },
                    confidence: 1,
                  },
                },
              });
            },
          },
        },
      });
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        models.unregisterProvider(fake.provider.id);
        if (options.classifier) models.unregisterProvider(CLASSIFIER_FIXTURE_PROVIDER);
      }),
    );
    const profiles = profilesFor();
    const settings = SettingsManager.inMemory({
      defaultTools: ["+codemode"],
      compaction: { enabled: false },
      retry: { enabled: false },
    });
    const loader = new DefaultResourceLoader({
      cwd: directory,
      agentDir: directory,
      settingsManager: settings,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      noContextFiles: true,
      extensionFactories: [
        { name: "codemode", builtin: true, factory: createCodemodeExtension() },
        {
          name: "subagents-workflow-test",
          factory: (pi) => {
            const receipts = registerSubagentErrorReceipts(pi);
            const owner = receipts.activate();
            pi.on("session_shutdown", () => receipts.deactivate());
            registerSubagentTools(
              pi,
              {
                environment: { cwd: directory, projectTrusted: false },
                ...(options.proxy && {
                  proxyCall: () =>
                    Promise.reject(new Error("Proxy calls are model-only in this fixture.")),
                }),
                run: (effect, signal) =>
                  Effect.runPromise(
                    effect.pipe(
                      Effect.provideService(SubagentService, service),
                      Effect.provideService(SubagentProfileService, profiles),
                      Effect.provideService(SubagentBackendRegistry, registry),
                    ),
                    signal ? { signal } : undefined,
                  ),
              },
              { receipts, owner },
            );
          },
        },
      ],
    });
    yield* step(() => loader.reload());
    const { session } = yield* Effect.acquireRelease(
      step(() =>
        createAgentSession({
          cwd: directory,
          agentDir: directory,
          model: fake.getModel(),
          modelRuntime: models,
          settingsManager: settings,
          sessionManager: SessionManager.inMemory(directory),
          resourceLoader: loader,
        }),
      ),
      ({ session }) =>
        step(() => session.abort()).pipe(
          Effect.andThen(
            step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })),
          ),
          Effect.ensuring(Effect.sync(() => session.dispose())),
        ),
    );
    yield* step(() => session.bindExtensions({ mode: "print" }));
    const call = (name: string, args: JsonObject, callId?: string) =>
      Effect.gen(function* () {
        fake.setResponses([
          fauxAssistantMessage(
            fauxToolCall(name, args, callId === undefined ? undefined : { id: callId }),
            { stopReason: "toolUse" },
          ),
          fauxAssistantMessage("Workflow fixture finished"),
        ]);
        yield* step(() => session.prompt("Exercise the workflow fixture"));
        const message = session.agent.state.messages.findLast(
          (message) => message.role === "toolResult" && message.toolName === name,
        );
        if (!message || message.role !== "toolResult")
          return yield* Effect.die(new Error("The real agent loop returned no tool result."));
        return {
          message,
          text: message.content
            .filter((part) => part.type === "text")
            .map((part) => part.text)
            .join("\n"),
          isError: message.isError,
        };
      });
    return {
      session,
      call,
      run: (code: string, callId?: string) => call("codemode", { code }, callId),
      /** Authenticated classifier catalog lookups made through the session's registry. */
      catalogLookups: () => catalogLookups,
      classifierCalls: () => classifierCalls,
    };
  });
