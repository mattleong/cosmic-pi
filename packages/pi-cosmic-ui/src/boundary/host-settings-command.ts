import type { ExtensionCommandContext as ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Result from "effect/Result";
import {
  captureHostSignal,
  completeSettingsArguments,
  dispatchSettingsCommand,
  invokeHostCallback,
  notifyAtHostBoundary,
  type CapturedHostSignal,
  type ExtensionSubcommand,
  type SettingsOptionDescriptor,
} from "pi-cosmic-core";
import { hasCustomSurface, type OwnedSurfaceOutcome } from "./host-surface.ts";

/** One settings scope, such as `global` or `project`; the first listed is the default. */
export interface SettingsCommandScope {
  readonly name: string;
  readonly description: string;
}

export interface SettingsCommandOptions<Config> {
  /** The extension's command without its slash, such as `xai`; settings live at `/xai settings`. */
  readonly root: string;
  readonly description: string;
  /** The extension name used in messages, such as `Better xAI`. */
  readonly title: string;
  /** Captured originating invocation/session authority; defaults to always current. */
  readonly isCurrent?: () => boolean;
  readonly descriptors: ReadonlyArray<
    Pick<SettingsOptionDescriptor<Config>, "id" | "description" | "values" | "currentValue"> & {
      /** Values beyond `values` are accepted and validated by `apply`, such as integers. */
      readonly openValues?: boolean | undefined;
    }
  >;
  /** `<id> <value>` examples listed by help. */
  readonly examples: ReadonlyArray<string>;
  /** Extra help lines after the examples, such as how scopes combine. */
  readonly notes?: ((ctx: ExtensionContext) => ReadonlyArray<string>) | undefined;
  /**
   * Optional scopes named before the setting id. Apply receives the chosen scope, or the first
   * one when the command names none. Without scopes the grammar is `<id> <value>`.
   */
  readonly scopes?: ReadonlyArray<SettingsCommandScope> | undefined;
  /**
   * Why a scope cannot be edited right now, such as an untrusted project; undefined allows. It is
   * checked before every apply, scripted or from a picker.
   */
  readonly scopeBlocked?:
    | ((ctx: ExtensionContext, scope: string) => string | undefined)
    | undefined;
  readonly config: (ctx: ExtensionContext) => Config | undefined;
  /** The `status` report: effective values and anything else worth checking. */
  readonly status: (ctx: ExtensionContext) => string | Promise<string>;
  /** Runs on every invocation and before each apply. */
  readonly onInvoke?: (ctx: ExtensionContext) => void;
  /**
   * `required` (the default): the invocation's signal is read once, a throwing getter makes the
   * settings unavailable, and every rejected apply warns. `optional`: each apply rereads it and
   * runs without one when the getter throws; a rejection stays silent once its signal aborted.
   */
  readonly signal?: "required" | "optional";
  /**
   * Persists one validated value; a rejection means the settings runtime is unavailable. A
   * `stale` failure, such as one from a replaced session, is silent.
   */
  readonly apply: (
    ctx: ExtensionContext,
    id: string,
    value: string,
    signal: AbortSignal | undefined,
    scope?: string,
  ) => Promise<
    Result.Result<unknown, { readonly message: string; readonly stale?: boolean | undefined }>
  >;
  /**
   * Shows the value a scope now holds after an apply; defaults to the effective value. Code
   * Mode shows the scope's own value, which may be `inherit`.
   */
  readonly displayValue?:
    | ((ctx: ExtensionContext, id: string, scope: string | undefined) => string | undefined)
    | undefined;
  /** Runs after each successful apply, such as a footer refresh or an availability notice. */
  readonly afterApply: (ctx: ExtensionContext, id: string, scope: string | undefined) => void;
  /**
   * Opens the provider's picker, reporting `Blocked` when it has no config. The session's
   * `apply` shows the committed or restored value through `show`, or else notifies `id = value`.
   * `show` returns false when a newer choice has replaced this one; a stale failure is silent.
   */
  readonly open: (
    ctx: ExtensionContext,
    session: {
      readonly config: () => Config | undefined;
      readonly apply: (
        id: string,
        value: string,
        show?: (value: string) => boolean | void,
        scope?: string,
      ) => Promise<void>;
    },
  ) => Promise<OwnedSurfaceOutcome<unknown>>;
}

/**
 * An extension's `settings` subcommand, for `/<extension> settings`: completions, help, status,
 * validation messages, and the scripted and interactive apply. Pickers stay with the provider.
 */
export function settingsSubcommand<Config>(
  options: SettingsCommandOptions<Config>,
): ExtensionSubcommand {
  const { title, descriptors } = options;
  const command = `${options.root} settings`;
  const scopes = options.scopes ?? [];
  const scopeNames = scopes.map((scope) => scope.name);
  const unavailable = `${title} settings aren't available right now`;
  const isCurrent = options.isCurrent ?? (() => true);
  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
    if (isCurrent()) notifyAtHostBoundary(ctx, message, level);
  };
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
    show?: (value: string) => boolean | void,
    scope = scopeNames[0],
  ): Promise<void> => {
    if (!isCurrent()) return Promise.resolve();
    invoked(ctx);
    const descriptor = descriptors.find((entry) => entry.id === id);
    const persisted = (): string | undefined => {
      if (options.displayValue)
        return invokeHostCallback(() => options.displayValue?.(ctx, id, scope), undefined);
      const cfg = readConfig(ctx);
      return descriptor && cfg
        ? invokeHostCallback(() => descriptor.currentValue(cfg), undefined)
        : undefined;
    };
    // Snapshot before the write so an optimistic display can still be rolled back when the
    // config becomes unavailable while the update is in flight.
    const before = show ? persisted() : undefined;
    /** False only when the picker says a newer choice replaced this one. */
    const display = (current: string | undefined): boolean =>
      isCurrent() &&
      (!show ||
        current === undefined ||
        invokeHostCallback(() => show(current), undefined) !== false);
    // Checked for pickers too, right before the write, since trust can change while one is open.
    const blocked =
      scope === undefined
        ? undefined
        : invokeHostCallback(() => options.scopeBlocked?.(ctx, scope), undefined);
    if (blocked) {
      if (display(before)) notify(ctx, blocked, "warning");
      return Promise.resolve();
    }
    return options.apply(ctx, id, value, signal, scope).then(
      (settlement) => {
        if (Result.isFailure(settlement)) {
          if (display(persisted() ?? before) && settlement.failure.stale !== true)
            notify(ctx, settlement.failure.message, "error");
          return;
        }
        const current = persisted() ?? value;
        if (show) display(current);
        else
          notify(ctx, `${scopes.length > 0 && scope ? `${scope} ` : ""}${id} = ${current}`, "info");
        if (isCurrent()) invokeHostCallback(() => options.afterApply(ctx, id, scope), undefined);
      },
      () => {
        const current = display(persisted() ?? before);
        if (current && (!optionalSignal || !signal?.aborted)) notify(ctx, unavailable, "warning");
      },
    );
  };

  const openInteractive = (ctx: ExtensionContext) => {
    const captured = captureSignal(ctx);
    if (captured._tag === "Unavailable") return notify(ctx, unavailable, "warning");
    return options
      .open(ctx, {
        config: () => readConfig(ctx),
        // The picker can outlive the signal it opened with.
        apply: (id, value, show, scope) =>
          applySetting(
            ctx,
            id,
            value,
            optionalSignal ? currentSignal(ctx) : captured.signal,
            show,
            scope,
          ),
      })
      .then((outcome) => {
        if (outcome._tag === "Blocked") notify(ctx, unavailable, "warning");
        if (outcome._tag === "Failed") notify(ctx, `Couldn't open ${title} settings`, "warning");
      });
  };

  const scopeToken = scopes.length > 0 ? `[${scopeNames.join("|")}] ` : "";
  const showHelp = (ctx: ExtensionContext) => {
    // Help remains useful before the session runtime has published its config.
    const cfg = readConfig(ctx);
    const notes = invokeHostCallback(() => options.notes?.(ctx) ?? [], []);
    const lines = [
      `${title} settings`,
      ...descriptors.map(
        (descriptor) =>
          `  ${descriptor.id}${cfg ? ` = ${descriptor.currentValue(cfg)}` : ""}  — ${descriptor.description}`,
      ),
      "",
      "Usage:",
      `  /${command}  Open the settings list`,
      `  /${command} ${scopeToken}<id> <value>  Change one setting`,
      `  /${command} status  Show effective values`,
      `  /${command} help  Show this help`,
      "",
      "Examples:",
      ...options.examples.map((example) => `  /${command} ${example}`),
      ...(notes.length > 0 ? ["", ...notes] : []),
    ];
    notify(ctx, lines.join("\n"), "info");
  };

  const handle = (args: string, ctx: ExtensionContext) => {
    if (!isCurrent()) return;
    invoked(ctx);
    const dispatch = dispatchSettingsCommand(args, descriptors, scopeNames);
    switch (dispatch._tag) {
      case "OpenInteractive":
        return hasCustomSurface(ctx) ? openInteractive(ctx) : showHelp(ctx);
      case "Help":
        return showHelp(ctx);
      case "Status":
        return Promise.resolve()
          .then(() => (isCurrent() ? options.status(ctx) : undefined))
          .then(
            (text) => {
              if (text !== undefined) notify(ctx, text, "info");
            },
            () => notify(ctx, unavailable, "warning"),
          );
      case "Invalid":
        return notify(
          ctx,
          dispatch.reason === "invalid-value"
            ? `${dispatch.id} must be one of: ${dispatch.allowedValues.join(", ")}`
            : dispatch.reason === "missing-value"
              ? `Usage: /${command} ${scopeToken}<id> <value>`
              : `Unknown setting: ${dispatch.id}`,
          "warning",
        );
      case "Apply": {
        const captured = captureSignal(ctx);
        if (captured._tag === "Unavailable") return notify(ctx, unavailable, "warning");
        return applySetting(
          ctx,
          dispatch.id,
          dispatch.value,
          captured.signal,
          undefined,
          dispatch.scope ?? scopeNames[0],
        );
      }
    }
  };

  return {
    name: "settings",
    description: options.description,
    complete: (prefix) =>
      completeSettingsArguments(
        prefix,
        descriptors,
        [
          { value: "status", label: "status", description: "Show effective values" },
          { value: "help", label: "help", description: "Show setting ids and usage" },
        ],
        scopes.map((scope) => ({
          value: scope.name,
          label: scope.name,
          description: scope.description,
        })),
      ),
    handler: (args, ctx) => Promise.resolve(handle(args, ctx)),
  };
}
