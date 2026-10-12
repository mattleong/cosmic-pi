import type { ExtensionCommandContext as ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text, type Component, type SettingsList } from "@earendil-works/pi-tui";
import * as Predicate from "effect/Predicate";
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
import type { HostKeybindingSource } from "../manager/key-labels.ts";
import type { FullScreenKeymapOptions } from "../manager/keymap.ts";
import {
  createSettingsListSurface,
  managerSettingsTheme,
  type SettingsSurfaceItem,
} from "../manager/settings-surface.ts";
import {
  hasCustomSurface,
  openOwnedSurfacePromise,
  type OwnedSurfaceHost,
  type OwnedSurfaceOutcome,
} from "./host-surface.ts";
import { capturedHostSignal } from "./host-abort-signal.ts";

interface SettingsCommandScope {
  readonly name: string;
  readonly description: string;
}

export interface SettingsCommandOptions<Config> {
  readonly root: string;
  readonly description: string;
  readonly title: string;
  readonly isCurrent: () => boolean;
  readonly descriptors: ReadonlyArray<
    Pick<SettingsOptionDescriptor<Config>, "id" | "description" | "values" | "currentValue"> & {
      readonly openValues?: boolean | undefined;
    }
  >;
  readonly examples: ReadonlyArray<string>;
  readonly notes?: ((ctx: ExtensionContext) => ReadonlyArray<string>) | undefined;
  readonly scopes?: ReadonlyArray<SettingsCommandScope> | undefined;
  readonly scopeBlocked?:
    | ((ctx: ExtensionContext, scope: string) => string | undefined)
    | undefined;
  readonly config: (ctx: ExtensionContext) => Config | undefined;
  readonly status: (ctx: ExtensionContext) => string | Promise<string>;
  readonly onInvoke?: (ctx: ExtensionContext) => void;
  readonly signal?: "required" | "optional";
  readonly apply: (
    ctx: ExtensionContext,
    id: string,
    value: string,
    signal: AbortSignal | undefined,
    scope?: string,
  ) => Promise<
    Result.Result<unknown, { readonly message: string; readonly stale?: boolean | undefined }>
  >;
  readonly displayValue?:
    | ((ctx: ExtensionContext, id: string, scope: string | undefined) => string | undefined)
    | undefined;
  readonly afterApply?: (ctx: ExtensionContext, id: string, scope: string | undefined) => void;
  readonly open: (
    ctx: ExtensionContext,
    session: SettingsSession<Config>,
  ) => Promise<OwnedSurfaceOutcome<unknown>>;
}

export interface SettingsSession<Config> {
  readonly config: () => Config | undefined;
  readonly apply: (
    id: string,
    value: string,
    show?: (value: string) => boolean | void,
    scope?: string,
  ) => Promise<void>;
  readonly picker: (
    items: SettingsSurfaceItem[],
    maxHeight?: number,
  ) => Promise<OwnedSurfaceOutcome<undefined>>;
}

interface SettingsListContent {
  readonly header: string | Component;
  readonly items: SettingsSurfaceItem[];
  readonly height: number;
  readonly onChange: (id: string, value: string, list: SettingsList) => void;
  readonly onCancel?: (() => void) | undefined;
  readonly afterInput?: (() => void) | undefined;
  readonly onList?: ((list: SettingsList) => void) | undefined;
}

const guardedKeybindingMatcher = (
  keybindings: HostKeybindingSource | undefined,
): FullScreenKeymapOptions["matchesKeybinding"] => {
  if (!keybindings || !invokeHostCallback(() => Predicate.isFunction(keybindings.matches), false))
    return undefined;
  return (data, id) => invokeHostCallback(() => keybindings.matches(data, id), false);
};

export const openSettingsList = (
  ctx: ExtensionContext,
  content: (host: OwnedSurfaceHost<undefined>) => SettingsListContent,
  isCurrent: () => boolean,
): Promise<OwnedSurfaceOutcome<undefined>> =>
  openOwnedSurfacePromise<undefined>(ctx, {
    placement: "inline",
    closedValue: undefined,
    isCurrent,
    create: (host) => {
      const { tui, theme, keybindings, finish } = host;
      const { header, onCancel, afterInput, onList, ...list } = content(host);
      const created = createSettingsListSurface({
        ...list,
        header: Predicate.isString(header)
          ? new Text(theme.fg("accent", theme.bold(header)), 1, 1)
          : header,
        listTheme: managerSettingsTheme(theme),
        onCancel: onCancel ?? (() => finish(undefined)),
        matchesKeybinding: guardedKeybindingMatcher(keybindings),
        requestRender: () => invokeHostCallback(() => tui.requestRender(), undefined),
        dim: (text) => invokeHostCallback(() => theme.fg("dim", text), text),
        bridge: {
          invoke: invokeHostCallback,
          admitInput: () => {
            if (invokeHostCallback(isCurrent, false)) return true;
            finish(undefined);
            return false;
          },
          afterInput,
        },
      });
      onList?.(created.list);
      return created.surface;
    },
  });

export const withInvocationAuthority = (
  capture: () => () => boolean,
  create: (isCurrent: () => boolean) => ExtensionSubcommand,
): ExtensionSubcommand => ({
  ...create(() => false),
  handler: (args, ctx) => create(capture()).handler(args, ctx),
});

export function settingsSubcommand<Config>(
  options: SettingsCommandOptions<Config>,
): ExtensionSubcommand {
  const { title, descriptors } = options;
  const command = `${options.root} settings`;
  const scopes = options.scopes ?? [];
  const scopeNames = scopes.map((scope) => scope.name);
  const unavailable = `${title} settings aren't available right now`;
  const { isCurrent } = options;
  const notify = (ctx: ExtensionContext, message: string, level: "info" | "warning" | "error") => {
    if (isCurrent()) notifyAtHostBoundary(ctx, message, level);
  };
  const readConfig = (ctx: ExtensionContext) =>
    invokeHostCallback(() => options.config(ctx), undefined);
  const invoked = (ctx: ExtensionContext) =>
    invokeHostCallback(() => options.onInvoke?.(ctx), undefined);
  const optionalSignal = options.signal === "optional";
  const captureSignal = (ctx: ExtensionContext): CapturedHostSignal =>
    optionalSignal ? { _tag: "Captured", signal: capturedHostSignal(ctx) } : captureHostSignal(ctx);

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
    const before = show ? persisted() : undefined;
    const display = (current: string | undefined): boolean =>
      isCurrent() &&
      (!show ||
        current === undefined ||
        invokeHostCallback(() => show(current), undefined) !== false);
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
          return undefined;
        }
        const current = persisted() ?? value;
        if (show) display(current);
        else
          notify(ctx, `${scopes.length > 0 && scope ? `${scope} ` : ""}${id} = ${current}`, "info");
        if (isCurrent()) invokeHostCallback(() => options.afterApply?.(ctx, id, scope), undefined);
        return undefined;
      },
      () => {
        const current = display(persisted() ?? before);
        if (current && (!optionalSignal || !signal?.aborted)) notify(ctx, unavailable, "warning");
      },
    );
  };

  const rowSetting = (row: string): readonly [scope: string | undefined, id: string] => {
    const scope = scopeNames.find((name) => row.startsWith(`${name}:`));
    return scope === undefined ? [undefined, row] : [scope, row.slice(scope.length + 1)];
  };

  const openInteractive = (ctx: ExtensionContext) => {
    const captured = captureSignal(ctx);
    if (captured._tag === "Unavailable") return notify(ctx, unavailable, "warning");
    const apply: SettingsSession<Config>["apply"] = (id, value, show, scope) =>
      applySetting(
        ctx,
        id,
        value,
        optionalSignal ? capturedHostSignal(ctx) : captured.signal,
        show,
        scope,
      );
    const picker: SettingsSession<Config>["picker"] = (items, maxHeight = 12) => {
      const latest = new Map<string, object>();
      return openSettingsList(
        ctx,
        ({ tui }) => ({
          header: `${title} settings`,
          items,
          height: Math.min(maxHeight, items.length + 2),
          onChange: (row, value, list) => {
            const [scope, id] = rowSetting(row);
            const change = {};
            latest.set(row, change);
            void apply(
              id,
              value,
              (shown) => {
                if (latest.get(row) !== change) return false;
                invokeHostCallback(() => {
                  list.updateValue(row, shown);
                  tui.requestRender();
                }, undefined);
                return true;
              },
              scope,
            );
          },
        }),
        isCurrent,
      );
    };
    return options.open(ctx, { config: () => readConfig(ctx), apply, picker }).then((outcome) => {
      if (outcome._tag === "Blocked") notify(ctx, unavailable, "warning");
      if (outcome._tag === "Failed") notify(ctx, `Couldn't open ${title} settings`, "warning");
      return undefined;
    });
  };

  const scopeToken = scopes.length > 0 ? `[${scopeNames.join("|")}] ` : "";
  const showHelp = (ctx: ExtensionContext) => {
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
              return undefined;
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
          dispatch.scope,
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
