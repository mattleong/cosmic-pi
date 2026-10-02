// Public SDK host boundary: real agent loop, nested tool hooks and native QuickJS; no inference.
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  type JsonObject,
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
import * as Path from "effect/Path";
import {
  BackgroundTaskService,
  type BackgroundTaskServiceContract,
} from "../../src/task/service.ts";
import { registerBackgroundTaskTool } from "../../src/tools/background-task.ts";

/** One promise-shaped SDK step inside a test Effect. */
const step = <A>(evaluate: () => PromiseLike<A>): Effect.Effect<A> => Effect.promise(evaluate);

/**
 * A scoped in-memory Pi session with native `codemode` and the registered `background_task`
 * definition. Tests supply only the owned task service; the runner adds Path. Inference is faux,
 * model network is off, and credentials, models, settings, and the session stay in memory.
 */
export const nativeCodemodeSession = (service: BackgroundTaskServiceContract) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    // Tool calls run with the test's own services plus the owned task boundary.
    const runTool = Effect.runPromiseWith(yield* Effect.context<never>());
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "background-task-workflow-" });
    const fake = fauxProvider({ provider: "background-task-workflow-test", tokensPerSecond: 0 });
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
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => models.unregisterProvider(fake.provider.id)),
    );
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
          name: "background-task-workflow-test",
          factory: (pi) =>
            registerBackgroundTaskTool(pi, {
              run: (effect, signal) =>
                runTool(
                  effect.pipe(
                    Effect.provideService(BackgroundTaskService, service),
                    Effect.provide(Path.layer),
                  ),
                  signal ? { signal } : undefined,
                ),
            }),
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
    /** One model-issued tool call through the real agent loop, then a final assistant turn. */
    const call = (name: string, args: JsonObject) =>
      Effect.gen(function* () {
        fake.setResponses([
          fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
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
    return { session, call, run: (code: string) => call("codemode", { code }) };
  });
