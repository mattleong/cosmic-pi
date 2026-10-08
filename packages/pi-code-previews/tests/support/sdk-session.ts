// Public Pi SDK session scaffolding: offline models, quiet resources, and scoped session disposal.
import {
  createAgentSession,
  ModelRuntime,
  SessionManager,
  type DefaultResourceLoader,
  type ExtensionAPI,
  type ExtensionFactory,
  type SettingsManager,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import { makePiManagedRuntime } from "pi-cosmic-core";
import {
  codePreviewsWithDependencies,
  type CodePreviewExtensionDependencies,
} from "../../src/application/lifecycle";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import type { CodePreviewSettings } from "../../src/config/schema";
import { setCodePreviewSettings } from "../../src/config/state";
import { codePreviewApplicationLayer } from "../../src/layer";
import { step } from "./effect-test";

/** Models stored under `directory` that never refresh or reach the network. */
export const offlineModels = (directory: string) =>
  step(() =>
    ModelRuntime.create({
      authPath: `${directory}/auth.json`,
      modelsPath: null,
      modelsStorePath: `${directory}/models.json`,
      refreshOnCreate: false,
      allowModelNetwork: false,
    }),
  );

/** A session whose scope emits shutdown, disposes it, and restores default preview settings. */
export const scopedSession = (options: {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly models: ModelRuntime;
  readonly settings: SettingsManager;
  readonly loader: DefaultResourceLoader;
  readonly sessionManager?: SessionManager;
}) =>
  Effect.gen(function* () {
    const { session } = yield* step(() =>
      createAgentSession({
        cwd: options.cwd,
        agentDir: options.agentDir ?? options.cwd,
        modelRuntime: options.models,
        settingsManager: options.settings,
        sessionManager: options.sessionManager ?? SessionManager.inMemory(options.cwd),
        resourceLoader: options.loader,
      }),
    );
    yield* Effect.addFinalizer(() =>
      step(() => session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" })).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            session.dispose();
            setCodePreviewSettings(defaultCodePreviewSettings);
          }),
        ),
      ),
    );
    return session;
  });

/** Code Previews loading `preview` over the defaults, with an anchor command and no syntax work. */
export const codePreviewsUnderTest =
  (
    agentDir: string,
    preview: Partial<CodePreviewSettings>,
    options: {
      /** Host API overrides, such as recording or refusing registrations. */
      readonly api?: (pi: ExtensionAPI) => Partial<ExtensionAPI>;
      readonly registerRenderers?: CodePreviewExtensionDependencies["registerRenderers"];
    } = {},
  ): ExtensionFactory =>
  (pi) =>
    codePreviewsWithDependencies(
      { ...pi, ...options.api?.(pi) },
      {
        makeRuntime: (api) =>
          makePiManagedRuntime(api, codePreviewApplicationLayer, {
            agentDirectory: () => agentDir,
            packageName: "pi-code-previews",
          }),
        registerCommands: (api) =>
          api.registerCommand("code-previews", { handler: () => Promise.resolve() }),
        loadSettings: () =>
          Effect.sync(() => {
            const settings = { ...defaultCodePreviewSettings, ...preview };
            setCodePreviewSettings(settings);
            return settings;
          }),
        initializeSyntax: () => Effect.void,
        registerRenderers: options.registerRenderers ?? (() => undefined),
      },
    );
