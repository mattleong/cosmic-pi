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
  type CodePreviewSessionCapability,
} from "./capability";
import { CodePreviewSchedulerService, type CodePreviewSchedulerServiceContract } from "./scheduler";
import type { CodePreviewToolName } from "../tools/names";
import { registerWritePreviewTool } from "../tools/renderers/registration";
import { getEnabledCodePreviewTools } from "../tools/selection";
import { capturePreviewHostTools } from "../boundary/host-tool-renderers";
import {
  CodePreviewPresentationOwner,
  createCodePreviewRendererResolver,
  publishPreviewToolStatuses,
} from "./tool-renderers";

export type CodePreviewRuntime = PiManagedRuntime<CodePreviewApplication, CodePreviewRuntimeError>;

type SessionInput = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly settingsAdmission: SettingsAdmission;
  readonly presentation: CodePreviewPresentationOwner;
  capability?: CodePreviewSessionCapability;
  readonly signal?: AbortSignal;
  readonly notifyFailure: () => void;
};

function retirePresentation(input: SessionInput): void {
  input.presentation.retire();
  if (input.capability) clearCodePreviewSessionCapability(input.capability);
}

class CodePreviewRendererRegistrationError extends Schema.TaggedError<CodePreviewRendererRegistrationError>()(
  "CodePreviewRendererRegistrationError",
  { operation: Schema.Literals(["register-renderers"]), message: Schema.String },
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
  /** Execution registration is limited to write's real before-write hook. */
  readonly registerRenderers: typeof registerWritePreviewTool;
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
  registerRenderers: registerWritePreviewTool,
};

/** Pi registration; dependencies are the seam for lifecycle/finalizer tests. */
export function codePreviewsWithDependencies(
  pi: ExtensionAPI,
  dependencies: CodePreviewExtensionDependencies = defaultDependencies,
): Promise<void> {
  const ownedTools = new Set<CodePreviewToolName>();
  const installedTools = new Set<CodePreviewToolName>();
  // Transcript replay may precede session_start. Those rows belong to the first startup only.
  let presentation = new CodePreviewPresentationOwner();
  let started = false;
  pi.registerToolRenderer(createCodePreviewRendererResolver(pi, () => presentation, ownedTools));
  dependencies.registerCommands(pi);

  const startup = (input: SessionInput) =>
    Effect.gen(function* () {
      yield* dependencies.loadSettings(input.settingsAdmission, input.cwd, input.projectTrusted);
      const scheduler = yield* CodePreviewSchedulerService;
      yield* registerRenderersAtHostBoundary(() => {
        publishPreviewToolStatuses(
          capturePreviewHostTools(pi),
          getEnabledCodePreviewTools(),
          ownedTools,
        );
        dependencies.registerRenderers(pi, input.cwd, { ownedTools, installedTools });
      });
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
      const capability: CodePreviewSessionCapability = {
        run: (effect, signal) =>
          slot.isCurrent(token)
            ? slot.run(effect, signal)
            : rejectInactiveCodePreviewSession("run"),
        defer: (task) =>
          input.presentation.live
            ? scheduler.defer(() => {
                if (input.presentation.live) task();
              })
            : () => undefined,
        schedule: (interval, tick) =>
          input.presentation.scheduleAnimation(interval, tick) ?? (() => undefined),
      };
      input.capability = capability;
      installCodePreviewSessionCapability(capability);
      // No cold row sees settings or a scheduler until trusted loading and registration succeed.
      input.presentation.publish(input.cwd, getEnabledCodePreviewTools(), scheduler);
      if (codePreviewSettings.syntaxHighlighting)
        slot.fork(dependencies.initializeSyntax(codePreviewSettings.shikiTheme), input.signal);
    },
    onDeactivated: retirePresentation,
    onStartFailure: (input) => {
      retirePresentation(input);
      input.notifyFailure();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const notifyFailure = () =>
      notifyAtHostBoundary(ctx, "Code Previews couldn't start", "warning");
    const capturedHost = captureSessionHost(ctx);
    const projectTrusted = isProjectTrusted(ctx);
    if (capturedHost["_tag"] === "Unavailable") {
      presentation.retire();
      notifyFailure();
      return slot.shutdown().then(() => undefined);
    }
    // Admission queries public metadata synchronously, before any settings I/O.
    try {
      capturePreviewHostTools(pi);
    } catch {
      presentation.retire();
      notifyFailure();
      return slot.shutdown().then(() => undefined);
    }
    if (capturedHost.aborted) notifyFailure();
    if (started || !presentation.live) {
      presentation.retire();
      presentation = new CodePreviewPresentationOwner();
    }
    started = true;
    const base: SessionInput = {
      cwd: capturedHost.cwd,
      projectTrusted,
      settingsAdmission: makeSettingsAdmission(),
      presentation,
      notifyFailure,
    };
    const input: SessionInput = capturedHost.signal
      ? { ...base, signal: capturedHost.signal }
      : base;
    return slot.start(input, capturedHost.signal).then(() => undefined);
  });
  pi.on("session_shutdown", () => {
    presentation.retire();
    return slot.shutdown();
  });
  return Promise.resolve();
}
