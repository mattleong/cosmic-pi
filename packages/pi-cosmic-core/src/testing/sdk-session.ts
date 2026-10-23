import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
  InMemoryCredentialStore,
  InMemoryModelsStore,
  parseToolCallArguments,
  validateToolArguments,
  type JsonObject,
  type Tool,
} from "@earendil-works/pi-ai";
import {
  createAgentSession,
  createCodemodeExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type CreateAgentSessionOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import { step } from "./steps.ts";

export const fauxModels = Effect.fn("SdkSession.fauxModels")(function* (provider: string) {
  const fake = fauxProvider({ provider, tokensPerSecond: 0 });
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
  yield* Effect.addFinalizer(() => Effect.sync(() => models.unregisterProvider(fake.provider.id)));
  return { fake, models };
});

/**
 * The result text Pi returns when it rejects a call before the tool runs: providers parse the
 * model's argument text with `parseToolCallArguments`, and the agent loop reports
 * `validateToolArguments`'s parse or schema failure. Throws if Pi would accept the arguments.
 */
export const piArgumentRejection = (
  tool: Pick<Tool, "name" | "parameters">,
  argumentsText: string,
): string => {
  let rejection: unknown;
  try {
    validateToolArguments(
      { ...tool, description: tool.name },
      {
        type: "toolCall",
        id: "rejected",
        name: tool.name,
        ...parseToolCallArguments(argumentsText),
      },
    );
  } catch (error) {
    rejection = error;
  }
  if (rejection instanceof Error) return rejection.message;
  throw new Error(`Pi accepted the arguments for tool "${tool.name}"`);
};

export const quietSettings = (overrides: Parameters<typeof SettingsManager.inMemory>[0] = {}) =>
  SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...overrides,
  });

export const QUIET_RESOURCES = {
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

export const quietLoader = (options: ConstructorParameters<typeof DefaultResourceLoader>[0]) => {
  const loader = new DefaultResourceLoader({ ...QUIET_RESOURCES, ...options });
  return step(() => loader.reload()).pipe(Effect.as(loader));
};

export const scopedPrintSession = Effect.fn("SdkSession.scopedPrintSession")(function* (
  options: CreateAgentSessionOptions,
) {
  const { session } = yield* Effect.acquireRelease(
    step(() => createAgentSession(options)),
    ({ session: created }) =>
      step(() => created.abort()).pipe(
        Effect.andThen(
          step(() => created.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })),
        ),
        Effect.ensuring(Effect.sync(() => created.dispose())),
      ),
  );
  yield* step(() => session.bindExtensions({ mode: "print" }));
  return session;
});

interface FauxCodemodeSessionOptions {
  readonly prefix: string;
  readonly provider: string;
  readonly extension: {
    readonly name: string;
    readonly factory: (cwd: string) => ExtensionFactory;
  };
  readonly prepareModels?: (models: ModelRuntime) => void;
  readonly prompt?: string;
  readonly reply?: string;
}

export const fauxCodemodeSession = Effect.fn("SdkSession.fauxCodemodeSession")(function* (
  options: FauxCodemodeSessionOptions,
) {
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: options.prefix });
  const { fake, models } = yield* fauxModels(options.provider);
  options.prepareModels?.(models);
  const settings = quietSettings({ defaultTools: ["+codemode"] });
  const loader = yield* quietLoader({
    cwd: directory,
    agentDir: directory,
    settingsManager: settings,
    extensionFactories: [
      { name: "codemode", builtin: true, factory: createCodemodeExtension() },
      { name: options.extension.name, factory: options.extension.factory(directory) },
    ],
  });
  const session = yield* scopedPrintSession({
    cwd: directory,
    agentDir: directory,
    model: fake.getModel(),
    modelRuntime: models,
    settingsManager: settings,
    sessionManager: SessionManager.inMemory(directory),
    resourceLoader: loader,
  });
  const call = Effect.fn("FauxCodemodeSession.call")(function* (
    name: string,
    args: JsonObject,
    callId?: string,
  ) {
    const toolCall = fauxToolCall(name, args, callId === undefined ? undefined : { id: callId });
    fake.setResponses([
      fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
      fauxAssistantMessage(options.reply ?? "Workflow fixture finished"),
    ]);
    yield* step(() => session.prompt(options.prompt ?? "Exercise the workflow fixture"));
    const message = Option.getOrUndefined(
      Arr.findLast(
        session.agent.state.messages,
        (candidate) => candidate.role === "toolResult" && candidate.toolName === name,
      ),
    );
    if (message?.role !== "toolResult")
      return yield* Effect.die(new Error("The real agent loop returned no tool result."));
    const text = Fn.pipe(
      message.content,
      Arr.filter((part) => part.type === "text"),
      Arr.map((part) => part.text),
      Arr.join("\n"),
    );
    return { message, text, isError: message.isError };
  });
  return {
    session,
    fake,
    call,
    run: (code: string, callId?: string) => call("codemode", { code }, callId),
  };
});
