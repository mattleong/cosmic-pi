/** Pi host boundary: presentation startup precedes native manager callbacks. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import {
  CodePreviewSchedulerService,
  loadCodePreviewSettings,
  type CodePreviewSchedulerServiceContract,
} from "pi-code-previews";
import {
  captureSessionHost,
  isProjectTrusted,
  makePiManagedRuntime,
  makePiSessionRuntimeSlot,
  notifyAtHostBoundary,
  type PiManagedRuntime,
} from "pi-cosmic-core";
import { registerMcpPreviewsCommand } from "../commands/register";
import {
  mcpPreviewApplicationLayer,
  type McpPreviewApplication,
  type McpPreviewRuntimeError,
} from "../layer";
import { nativeMcpRegistration, type NativeMcpSeams } from "./native-mcp-registration";

export type McpPreviewRuntime = PiManagedRuntime<McpPreviewApplication, McpPreviewRuntimeError>;

class McpPreviewSettingsError extends Schema.TaggedError<McpPreviewSettingsError>()(
  "McpPreviewSettingsError",
  { message: Schema.String },
) {}

export interface McpPreviewDependencies {
  readonly makeRuntime: (pi: ExtensionAPI) => McpPreviewRuntime;
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
    signal: AbortSignal,
  ) => Promise<void>;
  readonly registerCommands: typeof registerMcpPreviewsCommand;
  readonly nativeMcp?: NativeMcpSeams;
}

const defaults: McpPreviewDependencies = {
  makeRuntime: (pi) => makePiManagedRuntime(pi, mcpPreviewApplicationLayer),
  loadSettings: (cwd, trust, signal) =>
    loadCodePreviewSettings(cwd, trust, signal).then(() => undefined),
  registerCommands: registerMcpPreviewsCommand,
};

type SessionInput = {
  readonly cwd: string;
  readonly projectTrusted: boolean;
  readonly presentation: { live: boolean };
  readonly notifyFailure: () => void;
};

export function mcpPreviewsWithDependencies(
  pi: ExtensionAPI,
  dependencies: McpPreviewDependencies = defaults,
): Promise<void> {
  const native = nativeMcpRegistration(dependencies.nativeMcp);
  dependencies.registerCommands(pi);
  const startup = (input: SessionInput) =>
    Effect.gen(function* () {
      // Effect supplies an owned signal even when Pi has no turn signal at session_start.
      yield* Effect.tryPromise({
        try: (signal) => dependencies.loadSettings(input.cwd, input.projectTrusted, signal),
        catch: () => new McpPreviewSettingsError({ message: "Preview settings couldn't load" }),
      });
      return yield* CodePreviewSchedulerService;
    });
  const slot = makePiSessionRuntimeSlot<
    SessionInput,
    McpPreviewApplication,
    Effect.Error<ReturnType<typeof startup>>,
    McpPreviewRuntimeError,
    CodePreviewSchedulerServiceContract
  >({
    makeRuntime: () => dependencies.makeRuntime(pi),
    startup,
    onActivated: (input, token, scheduler) => {
      native.present({
        presentation: input.presentation,
        schedule: (interval, tick) =>
          input.presentation.live && slot.isCurrent(token)
            ? scheduler.schedule(interval, () => {
                if (input.presentation.live && slot.isCurrent(token)) tick();
              })
            : () => undefined,
      });
    },
    onDeactivated: (input) => {
      // Revoked synchronously before scheduler fibers are disposed.
      input.presentation.live = false;
    },
    onStartFailure: (input) => {
      input.presentation.live = false;
      native.presentationFailure();
      input.notifyFailure();
    },
  });

  pi.on("session_start", (_event, ctx) => {
    const notifyFailure = () =>
      notifyAtHostBoundary(
        ctx,
        "MCP previews couldn't start; native MCP remains available",
        "warning",
      );
    const host = captureSessionHost(ctx);
    if (host._tag === "Unavailable") {
      native.presentationFailure();
      notifyFailure();
      return slot.shutdown();
    }
    const input: SessionInput = {
      cwd: host.cwd,
      projectTrusted: isProjectTrusted(ctx),
      presentation: { live: true },
      notifyFailure,
    };
    return slot.start(input, host.signal).then(() => undefined);
  });
  pi.on("session_shutdown", () => slot.shutdown());

  // Always composed during extension loading, with no activation setting or factory options.
  // The native handlers commit later, so settings and activation settle before fresh tools arrive.
  return native.compose(pi);
}
