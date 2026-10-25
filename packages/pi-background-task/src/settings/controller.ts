import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { withCapturedHostSignal } from "pi-cosmic-core/host-invocation";
import * as Predicate from "effect/Predicate";
import { captureHostSignal, notifyAtHostBoundary } from "pi-cosmic-core/host-session";
import { registerExtensionCommand, type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import type { TaskSettingsActions } from "./task-settings.ts";
import { TASK_SETTINGS_COMMAND } from "./task-settings-options.ts";

export interface TaskCommandActions extends TaskSettingsActions {
  readonly isAvailable: () => boolean;
  readonly openActivity: (signal?: AbortSignal) => Promise<boolean>;
}

interface TaskCommandModules {
  readonly settings: () => Promise<typeof import("./task-settings.ts")>;
}

const COMMAND_MODULES: TaskCommandModules = {
  settings: () => import("./task-settings.ts"),
};

export function registerTasksCommand(
  pi: ExtensionAPI,
  actions: TaskCommandActions,
  modules: TaskCommandModules = COMMAND_MODULES,
): void {
  // Retain one settings owner so concurrent invocations still serialize their writes.
  let settings: ExtensionSubcommand | undefined;
  const invoke = (
    ctx: ExtensionCommandContext,
    operation: (invocation: ExtensionCommandContext, isCurrent: () => boolean) => Promise<void>,
  ): Promise<void> => {
    const authority = actions.captureAuthority();
    const captured = captureHostSignal(ctx);
    if (!Predicate.isTagged(captured, "Captured")) return Promise.resolve();
    const { signal } = captured;
    const isCurrent = () => authority() && !signal?.aborted;
    if (!isCurrent()) return Promise.resolve();
    const invocation = withCapturedHostSignal(ctx, signal);
    return operation(invocation, isCurrent).catch((cause: unknown) => {
      if (isCurrent()) throw cause;
    });
  };
  registerExtensionCommand(pi, {
    name: "tasks",
    description: "Open background tasks in Activity, or change their settings",
    bare: {
      handler: (_args, ctx) =>
        invoke(ctx, (invocation, isCurrent) => {
          if (invocation.mode !== "tui") {
            if (invocation.hasUI)
              notifyAtHostBoundary(
                invocation,
                "Open Pi in an interactive terminal to view background tasks with /tasks.",
                "warning",
              );
            return Promise.resolve();
          }
          if (!actions.isAvailable()) {
            notifyAtHostBoundary(
              invocation,
              "Background Tasks aren't running; run /reload, then reopen /tasks",
              "warning",
            );
            return Promise.resolve();
          }
          return actions
            .openActivity(invocation.signal)
            .then((opened) =>
              opened || !isCurrent()
                ? undefined
                : notifyAtHostBoundary(
                    invocation,
                    "/tasks needs Activity from pi-cosmic-ui; install or enable it, then run /reload",
                    "warning",
                  ),
            );
        }),
    },
    subcommands: [
      {
        ...TASK_SETTINGS_COMMAND,
        handler: (args, ctx) =>
          invoke(ctx, (invocation, isCurrent) =>
            modules.settings().then(({ taskSettingsSubcommand }) => {
              if (!isCurrent()) return undefined;
              settings ??= taskSettingsSubcommand(actions);
              return settings.handler(args, invocation);
            }),
          ),
      },
    ],
  });
}
