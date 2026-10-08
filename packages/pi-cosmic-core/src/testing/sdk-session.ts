/**
 * Real Pi SDK sessions for end-to-end tests: the actual agent loop and extension runner with faux
 * inference, offline in-memory models, and only the extensions under test. Test-runner neutral.
 */
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
  type CreateAgentSessionOptions,
  type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import { step } from "./steps.ts";

/** A faux provider in offline in-memory models; it is unregistered when the scope closes. */
export const fauxModels = (provider: string) =>
  Effect.gen(function* () {
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
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => models.unregisterProvider(fake.provider.id)),
    );
    return { fake, models };
  });

/** In-memory settings without compaction or retries. */
export const quietSettings = (overrides: Parameters<typeof SettingsManager.inMemory>[0] = {}) =>
  SettingsManager.inMemory({
    compaction: { enabled: false },
    retry: { enabled: false },
    ...overrides,
  });

/** Loads only the given extensions: no skills, prompts, themes, or context files. */
export const QUIET_RESOURCES = {
  noSkills: true,
  noPromptTemplates: true,
  noThemes: true,
  noContextFiles: true,
} as const;

/** A reloaded loader over `QUIET_RESOURCES`. */
export const quietLoader = (options: ConstructorParameters<typeof DefaultResourceLoader>[0]) => {
  const loader = new DefaultResourceLoader({ ...QUIET_RESOURCES, ...options });
  return step(() => loader.reload()).pipe(Effect.as(loader));
};

/** A session bound in print mode; its scope aborts it, emits `session_shutdown`, then disposes it. */
export const scopedPrintSession = (options: CreateAgentSessionOptions) =>
  Effect.gen(function* () {
    const { session } = yield* Effect.acquireRelease(
      step(() => createAgentSession(options)),
      ({ session }) =>
        step(() => session.abort()).pipe(
          Effect.andThen(
            step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })),
          ),
          Effect.ensuring(Effect.sync(() => session.dispose())),
        ),
    );
    yield* step(() => session.bindExtensions({ mode: "print" }));
    return session;
  });

interface FauxCodemodeSessionOptions {
  readonly prefix: string;
  readonly provider: string;
  /** The extension under test, loaded beside Pi's builtin codemode in the session directory. */
  readonly extension: {
    readonly name: string;
    readonly factory: (cwd: string) => ExtensionFactory;
  };
  /** Adjusts the offline models before the session starts. */
  readonly prepareModels?: (models: ModelRuntime) => void;
  readonly prompt?: string;
  readonly reply?: string;
}

/**
 * A scoped in-memory Pi session with native `codemode` and one extension under test. Inference is
 * faux, model network is off, and credentials, models, settings, and the session stay in memory.
 */
export const fauxCodemodeSession = (options: FauxCodemodeSessionOptions) =>
  Effect.gen(function* () {
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
    /** One model-issued tool call through the real agent loop, then a final reply. */
    const call = (name: string, args: JsonObject, callId?: string) =>
      Effect.gen(function* () {
        const toolCall = fauxToolCall(
          name,
          args,
          callId === undefined ? undefined : { id: callId },
        );
        fake.setResponses([
          fauxAssistantMessage(toolCall, { stopReason: "toolUse" }),
          fauxAssistantMessage(options.reply ?? "Workflow fixture finished"),
        ]);
        yield* step(() => session.prompt(options.prompt ?? "Exercise the workflow fixture"));
        const message = session.agent.state.messages.findLast(
          (candidate) => candidate.role === "toolResult" && candidate.toolName === name,
        );
        if (!message || message.role !== "toolResult")
          return yield* Effect.die(new Error("The real agent loop returned no tool result."));
        const text = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
        return { message, text, isError: message.isError };
      });
    return {
      session,
      fake,
      call,
      run: (code: string, callId?: string) => call("codemode", { code }, callId),
    };
  });
