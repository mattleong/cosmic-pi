/** Effect-managed Pi boundary for code previews. */
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  type PiManagedRuntime,
} from "pi-cosmic-core";
import {
  codePreviewApplicationLayer,
  makeCodePreviewApplicationLayer,
  type CodePreviewApplication,
  type CodePreviewRuntimeError,
} from "../layer";
import { registerHealthCommand } from "../commands/health";
import { registerSettingsCommand } from "../settings/controller";
import {
  clearCodePreviewSessionCapability,
  installCodePreviewSessionCapability,
} from "./capability";
import { CodePreviewSession } from "./service";
import { codePreviewSettings } from "../config/state";
import type { CodePreviewToolName } from "../tools/names";
import { registerToolRenderers } from "../tools/renderers/registration";
export type CodePreviewRuntime = PiManagedRuntime<CodePreviewApplication, CodePreviewRuntimeError>;

type SessionInput = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
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

type CapturedSessionHost =
  | {
      readonly kind: "Captured";
      readonly cwd: string;
      readonly signal: AbortSignal | undefined;
      readonly aborted: boolean;
    }
  | { readonly kind: "Unavailable" };

function captureSessionHost(ctx: Pick<ExtensionContext, "cwd" | "signal">): CapturedSessionHost {
  try {
    const cwd = ctx.cwd;
    const signal = ctx.signal;
    if (typeof cwd !== "string" || cwd.length === 0) return { kind: "Unavailable" };
    return { kind: "Captured", cwd, signal, aborted: signal?.aborted === true };
  } catch {
    return { kind: "Unavailable" };
  }
}

function readProjectTrust(ctx: { readonly isProjectTrusted?: () => boolean }): boolean {
  try {
    const isProjectTrusted = ctx.isProjectTrusted;
    return typeof isProjectTrusted !== "function" || isProjectTrusted.call(ctx) === true;
  } catch {
    return false;
  }
}

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
  readonly registerHealth: typeof registerHealthCommand;
  readonly registerSettings: typeof registerSettingsCommand;
  readonly registerRenderers: typeof registerToolRenderers;
}

const defaultDependencies: CodePreviewExtensionDependencies = {
  makeRuntime: (pi) =>
    makePiManagedRuntime(pi, codePreviewApplicationLayer, {
      agentDirectory: getAgentDir,
      packageName: "pi-code-previews",
    }),
  registerHealth: registerHealthCommand,
  registerSettings: registerSettingsCommand,
  registerRenderers: registerToolRenderers,
};

export function registerCodePreviewApplication(pi: ExtensionAPI): Promise<void> {
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

  const startup = (input: SessionInput) =>
    CodePreviewSession.use((service) =>
      service.loadSettings(input.cwd, input.projectTrusted).pipe(
        Effect.tap(() =>
          registerRenderersAtHostBoundary(() =>
            dependencies.registerRenderers(pi, input.cwd, {
              registeredTools,
              activatedTools,
              projectTrusted: input.projectTrusted,
            }),
          ),
        ),
        Effect.asVoid,
      ),
    );
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    CodePreviewApplication,
    Effect.Error<ReturnType<typeof startup>>,
    CodePreviewRuntimeError
  >({
    makeRuntime: () => dependencies.makeRuntime(pi),
    startup,
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
    const notifyFailure = () => {
      try {
        ctx.ui.notify("Code previews failed to start.", "warning");
      } catch {
        // Host notification failure cannot block disposal.
      }
    };
    const capturedHost = captureSessionHost(ctx);
    if (capturedHost.kind === "Unavailable") {
      notifyFailure();
      return slot.shutdown().then(() => undefined);
    }
    if (capturedHost.aborted) notifyFailure();
    const projectTrusted = readProjectTrust(ctx);
    return slot
      .start(
        {
          cwd: capturedHost.cwd,
          projectTrusted,
          ...(capturedHost.signal ? { signal: capturedHost.signal } : {}),
          notifyFailure,
        },
        capturedHost.signal,
      )
      .then(() => undefined);
  });

  pi.on("session_shutdown", () => slot.shutdown());
  return Promise.resolve();
}

export const codePreviewExtensionTesting = {
  makeApplicationLayer: makeCodePreviewApplicationLayer,
};
