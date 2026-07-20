/** Effect-managed Pi boundary for code previews. */
import { getAgentDir, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  AgentDirectory,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  nodeFilePlatformLayer,
  type PiManagedRuntime,
} from "pi-cosmic-core";
import { ShikiAdapter } from "../boundary/shiki";
import { registerHealthCommand } from "../commands/health";
import { registerSettingsCommand } from "../commands/settings";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "../session-capability";
import { CodePreviewSession } from "../session-service";
import { codePreviewSettings } from "../settings";
import { CodePreviewEnvironmentService } from "../settings/environment-service";
import { CodePreviewSettingsService } from "../settings/service";
import { CodePreviewSyntaxService } from "../syntax/service";
import type { CodePreviewToolName } from "../tools/names";
import { registerToolRenderers } from "../tool-renderers/registration";
import { CodePreviewWriteService } from "../write/service";

const hostLayer = Layer.mergeAll(
  nodeFilePlatformLayer,
  AgentDirectory.layerFromHost(getAgentDir),
  CodePreviewEnvironmentService.layer,
);
const settingsLayer = CodePreviewSettingsService.layer.pipe(Layer.provideMerge(hostLayer));
const syntaxLayer = CodePreviewSyntaxService.layer.pipe(Layer.provideMerge(ShikiAdapter.layer));
const sessionLayer = CodePreviewSession.layer.pipe(
  Layer.provideMerge(Layer.merge(settingsLayer, syntaxLayer)),
);
const codePreviewApplicationLayer = Layer.mergeAll(
  hostLayer,
  settingsLayer,
  syntaxLayer,
  CodePreviewWriteService.layer,
  sessionLayer,
);

type CodePreviewApplication = Layer.Success<typeof codePreviewApplicationLayer>;
export type CodePreviewRuntime = PiManagedRuntime<CodePreviewApplication, unknown>;

type SessionInput = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly signal?: AbortSignal;
  readonly notifyFailure: () => void;
};

export interface CodePreviewExtensionDependencies {
  readonly makeRuntime: (pi: ExtensionAPI) => CodePreviewRuntime;
  readonly registerHealth: typeof registerHealthCommand;
  readonly registerSettings: typeof registerSettingsCommand;
  readonly registerRenderers: typeof registerToolRenderers;
}

const defaultDependencies: CodePreviewExtensionDependencies = {
  makeRuntime: (pi) => makePiManagedRuntime(pi, codePreviewApplicationLayer),
  registerHealth: registerHealthCommand,
  registerSettings: registerSettingsCommand,
  registerRenderers: registerToolRenderers,
};

export function codePreviews(pi: ExtensionAPI): Promise<void> {
  return codePreviewsWithDependencies(pi, defaultDependencies);
}

/** Internal seam for lifecycle/finalizer tests. */
export function codePreviewsWithDependencies(
  pi: ExtensionAPI,
  dependencies: CodePreviewExtensionDependencies,
): Promise<void> {
  const registeredTools = new Set<CodePreviewToolName>();
  const activatedTools = new Set<CodePreviewToolName>();
  dependencies.registerHealth(pi);
  dependencies.registerSettings(pi);

  const slot = makePiSessionRuntimeSlot<SessionInput, CodePreviewApplication, unknown, unknown>({
    makeRuntime: () => dependencies.makeRuntime(pi),
    startup: (input) =>
      CodePreviewSession.use((service) =>
        service.loadSettings(input.cwd, input.projectTrusted).pipe(
          Effect.tap(() =>
            Effect.sync(() =>
              dependencies.registerRenderers(pi, input.cwd, {
                registeredTools,
                activatedTools,
                projectTrusted: input.projectTrusted,
              }),
            ),
          ),
          Effect.asVoid,
        ),
      ),
    onActivated: (input, token) => {
      installCodePreviewSessionCapability({
        token,
        run: (effect, signal) => slot.run(effect, signal),
        fork: (effect, signal) => slot.fork(effect, signal),
      });
      if (codePreviewSettings.syntaxHighlighting)
        slot.fork(
          CodePreviewSession.use((service) =>
            service.initializeSyntax(codePreviewSettings.shikiTheme),
          ),
          input.signal,
        );
    },
    onDeactivated: (_input, token) => clearCodePreviewSessionCapability(token),
    onStartFailure: (input) => {
      clearCodePreviewSessionCapability();
      input.notifyFailure();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const projectTrusted =
      typeof ctx.isProjectTrusted === "function" ? ctx.isProjectTrusted() : true;
    return slot
      .start(
        {
          cwd: ctx.cwd,
          projectTrusted,
          ...(ctx.signal ? { signal: ctx.signal } : {}),
          notifyFailure: () => {
            try {
              ctx.ui.notify("Code previews failed to start.", "warning");
            } catch {
              // Host notification failure cannot block disposal.
            }
          },
        },
        ctx.signal,
      )
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
  return Promise.resolve();
}
