import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  captureSessionHost,
  invokeHostCallback,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { makePiManagedRuntime, type PiManagedRuntime } from "pi-cosmic-core/runtime";
import { makePiSessionRuntimeSlot } from "pi-cosmic-core/runtime/session-runtime";
import {
  codePreviewApplicationLayer,
  type CodePreviewApplication,
  type CodePreviewRuntimeError,
} from "../layer";
import { registerCodePreviewsCommand } from "../commands/register";
import { nextSettingsAdmission, type SettingsAdmission } from "../config/coordinator";
import type { CodePreviewSettings } from "../config/schema";
import { CodePreviewSettingsService, describeSettingsProblem } from "../config/store";
import { codePreviewSettings, codePreviewSettingsProblems } from "../config/state";
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

type CodePreviewRuntime = PiManagedRuntime<CodePreviewApplication, CodePreviewRuntimeError>;

type SessionInput = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly prewarmSyntax: boolean;
  readonly settingsAdmission: SettingsAdmission;
  readonly presentation: CodePreviewPresentationOwner;
  capability?: CodePreviewSessionCapability;
  readonly signal: AbortSignal | undefined;
  readonly notifyFailure: () => void;
  readonly warn: (message: string) => void;
};

function retirePresentation(input: SessionInput): void {
  input.presentation.retire();
  if (input.capability) clearCodePreviewSessionCapability(input.capability);
}

class CodePreviewRendererRegistrationError extends Schema.TaggedError<
  CodePreviewRendererRegistrationError,
  { readonly brand: unique symbol }
>()("CodePreviewRendererRegistrationError", { message: Schema.String }) {}

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

export function codePreviewsWithDependencies(
  pi: ExtensionAPI,
  dependencies: CodePreviewExtensionDependencies = defaultDependencies,
): Promise<void> {
  const ownedTools = new Set<CodePreviewToolName>();
  const installedTools = new Set<CodePreviewToolName>();
  let presentation = new CodePreviewPresentationOwner();
  let started = false;
  pi.registerToolRenderer(createCodePreviewRendererResolver(pi, () => presentation, ownedTools));
  dependencies.registerCommands(pi);

  const startup = Effect.fn("CodePreviews.startup")(function* (input: SessionInput) {
    yield* dependencies.loadSettings(input.settingsAdmission, input.cwd, input.projectTrusted);
    const scheduler = yield* CodePreviewSchedulerService;
    yield* Effect.try({
      try: () => {
        publishPreviewToolStatuses(
          capturePreviewHostTools(pi),
          getEnabledCodePreviewTools(),
          ownedTools,
        );
        dependencies.registerRenderers(pi, input.cwd, { ownedTools, installedTools });
      },
      catch: () =>
        CodePreviewRendererRegistrationError.make({
          message: "Code preview renderer registration failed.",
        }),
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
      input.presentation.publish(input.cwd, getEnabledCodePreviewTools(), scheduler);
      for (const problem of codePreviewSettingsProblems)
        input.warn(describeSettingsProblem(problem, input.cwd));
      // Headless history/export still initializes on demand through the same scoped ingress.
      if (input.prewarmSyntax && codePreviewSettings.syntaxHighlighting)
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
    if (
      !Predicate.isTagged(capturedHost, "Captured") ||
      !invokeHostCallback(() => capturePreviewHostTools(pi), undefined)
    ) {
      presentation.retire();
      notifyFailure();
      return slot.shutdown();
    }
    if (capturedHost.aborted) notifyFailure();
    if (started || !presentation.live) {
      presentation.retire();
      presentation = new CodePreviewPresentationOwner();
    }
    started = true;
    const input: SessionInput = {
      cwd: capturedHost.cwd,
      projectTrusted,
      prewarmSyntax: invokeHostCallback(() => ctx.mode === "tui", false),
      settingsAdmission: nextSettingsAdmission(),
      presentation,
      signal: capturedHost.signal,
      notifyFailure,
      warn: (message) => notifyAtHostBoundary(ctx, message, "warning"),
    };
    return slot.start(input, capturedHost.signal).then(() => undefined);
  });
  pi.on("session_shutdown", () => {
    presentation.retire();
    return slot.shutdown();
  });
  return Promise.resolve();
}
