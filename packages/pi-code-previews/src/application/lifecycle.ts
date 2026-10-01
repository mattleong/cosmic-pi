/** Effect-managed Pi boundary for code previews. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
  type PiManagedRuntime,
} from "pi-cosmic-core";
import {
  codePreviewApplicationLayer,
  type CodePreviewApplication,
  type CodePreviewRuntimeError,
} from "../layer";
import { registerCodePreviewsCommand } from "../commands/register";
import { makeSettingsAdmission, type SettingsAdmission } from "../config/coordinator";
import type { CodePreviewSettings } from "../config/schema";
import { CodePreviewSettingsService } from "../config/store";
import { codePreviewSettings } from "../config/state";
import { CodePreviewSyntaxService } from "../syntax/service";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
} from "./capability";
import { CodePreviewSchedulerService, type CodePreviewSchedulerServiceContract } from "./scheduler";
import type { CodePreviewToolName } from "../tools/names";
import { registerToolRenderers } from "../tools/renderers/registration";
import {
  nativeCodemodeRegistration,
  type NativeCodemodeSnapshot,
} from "../tools/native-codemode-registration";
import { getEnabledCodePreviewTools } from "../tools/selection";
export type CodePreviewRuntime = PiManagedRuntime<CodePreviewApplication, CodePreviewRuntimeError>;

type SessionInput = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly settingsAdmission: SettingsAdmission;
  readonly nativeCodemode: NativeCodemodeSnapshot;
  readonly presentation: { live: boolean };
  readonly signal?: AbortSignal;
  readonly notifyFailure: () => void;
};

class CodePreviewRendererRegistrationError extends Schema.TaggedError<CodePreviewRendererRegistrationError>()(
  "CodePreviewRendererRegistrationError",
  {
    operation: Schema.Literals(["register-renderers"]),
    message: Schema.String,
  },
) {}

function registerRenderersAtHostBoundary(register: () => void) {
  return Effect.try({
    try: register,
    catch: () =>
      new CodePreviewRendererRegistrationError({
        operation: "register-renderers",
        message: "Code preview renderer registration failed.",
      }),
  });
}

export interface CodePreviewExtensionDependencies {
  readonly makeRuntime: (pi: ExtensionAPI) => CodePreviewRuntime;
  readonly loadSettings: (
    admission: SettingsAdmission,
    cwd: string,
    projectTrusted: boolean,
  ) => Effect.Effect<CodePreviewSettings, never, CodePreviewSettingsService>;
  readonly initializeSyntax: (
    theme: string,
  ) => Effect.Effect<void, never, CodePreviewSyntaxService>;
  readonly registerCommands: typeof registerCodePreviewsCommand;
  readonly registerRenderers: typeof registerToolRenderers;
}

const defaultDependencies: CodePreviewExtensionDependencies = {
  makeRuntime: (pi) =>
    makePiManagedRuntime(pi, codePreviewApplicationLayer, {
      agentDirectory: getAgentDir,
      packageName: "pi-code-previews",
    }),
  loadSettings: (admission, cwd, projectTrusted) =>
    CodePreviewSettingsService.use((service) =>
      service.load(admission, { projectCwd: cwd, projectTrusted }),
    ),
  initializeSyntax: (theme) => CodePreviewSyntaxService.use((service) => service.initialize(theme)),
  registerCommands: registerCodePreviewsCommand,
  registerRenderers: registerToolRenderers,
};

/** Pi registration; `dependencies` is the seam for lifecycle/finalizer tests. */
export function codePreviewsWithDependencies(
  pi: ExtensionAPI,
  dependencies: CodePreviewExtensionDependencies = defaultDependencies,
): Promise<void> {
  const ownedTools = new Set<CodePreviewToolName>();
  const installedTools = new Set<CodePreviewToolName>();
  const nativeCodemode = nativeCodemodeRegistration();
  dependencies.registerCommands(pi);

  const startup = (input: SessionInput) =>
    Effect.gen(function* () {
      yield* dependencies.loadSettings(input.settingsAdmission, input.cwd, input.projectTrusted);
      const scheduler = yield* CodePreviewSchedulerService;
      yield* registerRenderersAtHostBoundary(() =>
        dependencies.registerRenderers(pi, input.cwd, {
          ownedTools,
          installedTools,
          projectTrusted: input.projectTrusted,
        }),
      );
      yield* registerRenderersAtHostBoundary(() =>
        nativeCodemode.register(
          pi,
          input.nativeCodemode,
          getEnabledCodePreviewTools().has("codemode"),
          (interval, tick) =>
            input.presentation.live
              ? scheduler.schedule(interval, () => {
                  if (input.presentation.live) tick();
                })
              : undefined,
          input.cwd,
        ),
      );
      return scheduler;
    });
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    CodePreviewApplication,
    Effect.Error<ReturnType<typeof startup>>,
    CodePreviewRuntimeError,
    CodePreviewSchedulerServiceContract
  >({
    makeRuntime: () => dependencies.makeRuntime(pi),
    startup,
    onActivated: (input, token, scheduler) => {
      installCodePreviewSessionCapability({
        run: (effect, signal) =>
          slot.isCurrent(token)
            ? slot.run(effect, signal)
            : rejectInactiveCodePreviewSession("run"),
        defer: scheduler.defer,
        schedule: scheduler.schedule,
      });
      if (codePreviewSettings.syntaxHighlighting)
        slot.fork(dependencies.initializeSyntax(codePreviewSettings.shikiTheme), input.signal);
    },
    onDeactivated: (input) => {
      input.presentation.live = false;
      clearCodePreviewSessionCapability();
    },
    onStartFailure: (input) => {
      input.presentation.live = false;
      clearCodePreviewSessionCapability();
      input.notifyFailure();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const notifyFailure = () =>
      notifyAtHostBoundary(ctx, "Code Previews couldn't start", "warning");
    const capturedHost = captureSessionHost(ctx);
    if (capturedHost["_tag"] === "Unavailable") {
      notifyFailure();
      return slot.shutdown().then(() => undefined);
    }
    if (capturedHost.aborted) notifyFailure();
    const projectTrusted = isProjectTrusted(ctx);
    const settingsAdmission = makeSettingsAdmission();
    let nativeSnapshot: NativeCodemodeSnapshot;
    try {
      nativeSnapshot = nativeCodemode.capture(pi);
    } catch {
      notifyFailure();
      return slot.shutdown().then(() => undefined);
    }
    const input: SessionInput = capturedHost.signal
      ? {
          cwd: capturedHost.cwd,
          projectTrusted,
          settingsAdmission,
          nativeCodemode: nativeSnapshot,
          presentation: { live: true },
          signal: capturedHost.signal,
          notifyFailure,
        }
      : {
          cwd: capturedHost.cwd,
          projectTrusted,
          settingsAdmission,
          nativeCodemode: nativeSnapshot,
          presentation: { live: true },
          notifyFailure,
        };
    return slot.start(input, capturedHost.signal).then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());

  return Promise.resolve();
}
