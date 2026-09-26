import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Result from "effect/Result";
import {
  captureHostSignal,
  completeSettingsArguments,
  dispatchSettingsCommand,
  invokeHostCallback,
  notifyAtHostBoundary,
  type CapturedHostSignal,
  type SettingsOptionDescriptor,
} from "pi-cosmic-core";
import { hasCustomSurface, type OwnedSurfaceOutcome } from "./host-surface.ts";

export interface SettingsCommandOptions<Config> {
  /** The command name without its slash, such as `xai-settings`. */
  readonly command: string;
  readonly description: string;
  /** The provider name used in messages, such as `Better xAI`. */
  readonly title: string;
  readonly descriptors: ReadonlyArray<
    Pick<SettingsOptionDescriptor<Config>, "id" | "description" | "values" | "currentValue">
  >;
  /** `<id> <value>` examples listed by help. */
  readonly examples: ReadonlyArray<string>;
  readonly config: (ctx: ExtensionContext) => Config | undefined;
  readonly diagnostics: (ctx: ExtensionContext) => string;
  /** Runs on every invocation and before each apply. */
  readonly onInvoke?: (ctx: ExtensionContext) => void;
  /**
   * `required` (the default): the invocation's signal is read once, a throwing getter makes the
   * settings unavailable, and every rejected apply warns. `optional`: each apply rereads it and
   * runs without one when the getter throws; a rejection stays silent once its signal aborted.
   */
  readonly signal?: "required" | "optional";
  /** Persists one validated value; a rejection means the settings runtime is unavailable. */
  readonly apply: (
    ctx: ExtensionContext,
    id: string,
    value: string,
    signal: AbortSignal | undefined,
  ) => Promise<Result.Result<unknown, { readonly message: string }>>;
  /** Runs after each successful apply, such as a footer refresh. */
  readonly afterApply: (ctx: ExtensionContext) => void;
  /**
   * Opens the provider's picker, reporting `Blocked` when it has no config. The session's
   * `apply` shows the committed or restored value through `show`, or else notifies `id = value`.
   */
  readonly open: (
    ctx: ExtensionContext,
    session: {
      readonly config: () => Config | undefined;
      readonly apply: (id: string, value: string, show?: (value: string) => void) => Promise<void>;
    },
  ) => Promise<OwnedSurfaceOutcome<unknown>>;
}

/**
 * Registers a provider's `/…-settings` command: completions, help, guarded diagnostics,
 * validation messages, and the scripted and interactive apply. Pickers stay with the provider.
 */
export function registerSettingsCommand<Config>(
  pi: ExtensionAPI,
  options: SettingsCommandOptions<Config>,
): void {
  const { command, title, descriptors } = options;
  const unavailable = `${title} settings are unavailable.`;
  const readConfig = (ctx: ExtensionContext) =>
    invokeHostCallback(() => options.config(ctx), undefined);
  const invoked = (ctx: ExtensionContext) =>
    invokeHostCallback(() => options.onInvoke?.(ctx), undefined);
  const optionalSignal = options.signal === "optional";
  const currentSignal = (ctx: ExtensionContext) => {
    const captured = captureHostSignal(ctx);
    return captured._tag === "Captured" ? captured.signal : undefined;
  };
  const captureSignal = (ctx: ExtensionContext): CapturedHostSignal =>
    optionalSignal ? { _tag: "Captured", signal: currentSignal(ctx) } : captureHostSignal(ctx);

  const applySetting = (
    ctx: ExtensionContext,
    id: string,
    value: string,
    signal: AbortSignal | undefined,
    show?: (value: string) => void,
  ): Promise<void> => {
    invoked(ctx);
    const descriptor = descriptors.find((entry) => entry.id === id);
    const persisted = (): string | undefined => {
      const cfg = readConfig(ctx);
      return descriptor && cfg
        ? invokeHostCallback(() => descriptor.currentValue(cfg), undefined)
        : undefined;
    };
    // Snapshot before the write so an optimistic display can still be rolled back when the
    // config becomes unavailable while the update is in flight.
    const before = show ? persisted() : undefined;
    const display = (current: string | undefined) => {
      if (show && current !== undefined) invokeHostCallback(() => show(current), undefined);
    };
    return options.apply(ctx, id, value, signal).then(
      (settlement) => {
        if (Result.isFailure(settlement)) {
          notifyAtHostBoundary(ctx, settlement.failure.message, "error");
          return display(persisted() ?? before);
        }
        invokeHostCallback(() => options.afterApply(ctx), undefined);
        const current = persisted() ?? value;
        if (show) display(current);
        else notifyAtHostBoundary(ctx, `${id} = ${current}`, "info");
      },
      () => {
        if (!optionalSignal || !signal?.aborted) notifyAtHostBoundary(ctx, unavailable, "warning");
        display(persisted() ?? before);
      },
    );
  };

  const openInteractive = (ctx: ExtensionContext) => {
    const captured = captureSignal(ctx);
    if (captured._tag === "Unavailable") return notifyAtHostBoundary(ctx, unavailable, "warning");
    return options
      .open(ctx, {
        config: () => readConfig(ctx),
        // The picker can outlive the signal it opened with.
        apply: (id, value, show) =>
          applySetting(ctx, id, value, optionalSignal ? currentSignal(ctx) : captured.signal, show),
      })
      .then((outcome) => {
        if (outcome._tag === "Blocked") notifyAtHostBoundary(ctx, unavailable, "warning");
        if (outcome._tag === "Failed")
          notifyAtHostBoundary(ctx, `Unable to open ${title} settings.`, "warning");
      });
  };

  const showHelp = (ctx: ExtensionContext) => {
    // Help remains useful before the session runtime has published its config.
    const cfg = readConfig(ctx);
    const lines = [
      `${title} settings`,
      ...descriptors.map(
        (descriptor) =>
          `  ${descriptor.id}${cfg ? `=${descriptor.currentValue(cfg)}` : ""}  — ${descriptor.description}`,
      ),
      "",
      "Usage:",
      `  /${command}`,
      `  /${command} <id> <value>`,
      `  /${command} diagnostics`,
      "",
      "Examples:",
      ...options.examples.map((example) => `  /${command} ${example}`),
    ];
    notifyAtHostBoundary(ctx, lines.join("\n"), "info");
  };

  const handle = (args: string, ctx: ExtensionContext) => {
    invoked(ctx);
    const dispatch = dispatchSettingsCommand(args, descriptors);
    switch (dispatch._tag) {
      case "OpenInteractive":
        return hasCustomSurface(ctx) ? openInteractive(ctx) : showHelp(ctx);
      case "Help":
        return showHelp(ctx);
      case "Diagnostics": {
        const text = invokeHostCallback<string | undefined>(
          () => options.diagnostics(ctx),
          undefined,
        );
        if (text === undefined)
          return notifyAtHostBoundary(ctx, `${title} diagnostics are unavailable.`, "warning");
        return notifyAtHostBoundary(ctx, text, "info");
      }
      case "Invalid":
        return notifyAtHostBoundary(
          ctx,
          dispatch.reason === "invalid-value"
            ? `Invalid value for ${dispatch.id}. Expected one of: ${dispatch.allowedValues.join(", ")}`
            : dispatch.reason === "missing-value"
              ? `Missing value for ${dispatch.id}. Usage: /${command} <id> <value>`
              : `Unknown setting: ${dispatch.id}`,
          "error",
        );
      case "Apply": {
        const captured = captureSignal(ctx);
        if (captured._tag === "Unavailable")
          return notifyAtHostBoundary(ctx, unavailable, "warning");
        return applySetting(ctx, dispatch.id, dispatch.value, captured.signal);
      }
    }
  };

  pi.registerCommand(command, {
    description: options.description,
    getArgumentCompletions: (prefix) =>
      completeSettingsArguments(prefix, descriptors, [
        { value: "help", label: "help", description: "Show setting ids and usage" },
        { value: "diagnostics", label: "diagnostics", description: `Show ${title} diagnostics` },
      ]),
    handler: (args, ctx) => Promise.resolve(handle(args, ctx)),
  });
}
