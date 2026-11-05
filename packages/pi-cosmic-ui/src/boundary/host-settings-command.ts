import type { ExtensionCommandContext as ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component, SettingsList } from "@earendil-works/pi-tui";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Match from "effect/Match";
import * as Option from "effect/Option";
import * as Predicate from "effect/Predicate";
import * as Result from "effect/Result";
import * as Str from "effect/String";
import {
  captureHostSignal,
  invokeHostCallback,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import {
  completeSettingsArguments,
  type SettingsOptionDescriptor,
} from "pi-cosmic-core/settings-completion";
import { dispatchSettingsCommand } from "pi-cosmic-core/settings-dispatch";
import { clipText } from "pi-cosmic-core/display";
import { extensionCommandOverview, type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import { joinInline, wrapFacts } from "../manager/chrome.ts";
import type { HostKeybindingSource } from "../manager/key-labels.ts";
import type { FullScreenKeymapOptions } from "../manager/keymap.ts";
import {
  createSettingsListSurface,
  managerSettingsTheme,
  settingsSurfaceHeader,
  type SettingsSurfaceItem,
  settingsSaveEvents,
  withSettingsGroupChildren,
} from "../manager/settings-surface.ts";
import {
  hasCustomSurface,
  openOwnedSurfacePromise,
  type OwnedSurfaceHost,
  OwnedSurfaceOutcome,
} from "./host-surface.ts";
import { capturedHostSignal } from "./host-abort-signal.ts";

interface SettingsCommandScope {
  readonly name: string;
  readonly description: string;
}

export interface SettingsCommandOwner {
  readonly run: (isCurrent: () => boolean, operation: () => Promise<void>) => Promise<void>;
}

// The registered command owns ordering, not a picker or an individual invocation.
const settingsCommandOwner = (): SettingsCommandOwner => {
  let pending: { readonly isCurrent: () => boolean; readonly settled: Promise<void> } | undefined;
  return {
    run: (isCurrent, operation) => {
      if (!invokeHostCallback(isCurrent, false)) return Promise.resolve();
      // A replacement activation must not wait for a retired, noncooperative host Promise.
      const previous =
        pending && invokeHostCallback(pending.isCurrent, false) ? pending.settled : undefined;
      const work = Promise.resolve(previous).then(() =>
        invokeHostCallback(isCurrent, false) ? operation() : undefined,
      );
      const entry = {
        isCurrent,
        settled: work.then(
          () => undefined,
          () => undefined,
        ),
      };
      pending = entry;
      const release = () => {
        if (pending === entry) pending = undefined;
        return undefined;
      };
      void entry.settled.then(release, release);
      return work;
    },
  };
};

export interface SettingsCommandOptions<Config> {
  readonly owner?: SettingsCommandOwner;
  readonly root: string;
  readonly description: string;
  readonly title: string;
  readonly isCurrent: () => boolean;
  readonly descriptors: ReadonlyArray<
    Pick<
      SettingsOptionDescriptor<Config>,
      "id" | "label" | "description" | "values" | "currentValue"
    > & {
      readonly openValues?: boolean | undefined;
    }
  >;
  readonly examples: ReadonlyArray<string>;
  readonly notes?: ((ctx: ExtensionContext) => ReadonlyArray<string>) | undefined;
  /** A fact appended to a command-line change's confirmation, such as `applies after /reload`. */
  readonly confirmationNote?: string | undefined;
  readonly scopes?: ReadonlyArray<SettingsCommandScope> | undefined;
  readonly scopeBlocked?:
    | ((ctx: ExtensionContext, scope: string) => string | undefined)
    | undefined;
  readonly config: (ctx: ExtensionContext) => Config | undefined;
  /**
   * The `status` text; build it with `settingsStatusText`. Defaults to one `Label: value (id)`
   * row per descriptor.
   */
  readonly status?: ((ctx: ExtensionContext) => string | Promise<string>) | undefined;
  readonly onInvoke?: (ctx: ExtensionContext) => void;
  readonly signal?: "required" | "optional";
  /**
   * Saves one setting. A rejected value fails with an `InvalidSettingError` or a message that
   * leads with the id and states the rule, such as `maxRunning must be a whole number`; the shell
   * warns `Label (id) <rule>`. Any other failure, such as a save that couldn't be written, is an
   * error shown as written.
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
  /**
   * Saves one setting. A successful change posts no notice; `show` receives the value that
   * persisted, also after the picker closed, and returns `false` for a change a newer one
   * superseded so its failure isn't reported twice. It must not publish to a closed surface.
   * Without `show`, the change confirms with a `Label: value` notice like a command-line change.
   */
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

// Pi draws notices one column in, leads a warning or error with its level, and doesn't
// hang-indent its own wraps, so settings text keeps every line within the command-help width and
// hangs its continuation rows.
const NOTICE_COLUMNS = 55;
const NOTICE_HANGING = "  ";
const DESCRIPTION_INDENT = "    ";
type NoticeLevel = "info" | "warning" | "error";
const NOTICE_PREFIX_COLUMNS = { info: 0, warning: "Warning: ".length, error: "Error: ".length };

/**
 * Wraps each line of notice text within 55 columns, less the `Warning: ` or `Error: ` Pi puts
 * before the first row, hanging continuations under the line's indent.
 */
export const wrapNoticeText = (text: string, level: NoticeLevel = "info"): string =>
  Arr.join(
    Arr.flatMap(Str.split(text, "\n"), (line, index) => {
      const prefix = index === 0 ? NOTICE_PREFIX_COLUMNS[level] : 0;
      if (line.length <= NOTICE_COLUMNS - prefix) return [Str.trimEnd(line)];
      const indent = /^ */u.exec(line)?.[0] ?? "";
      // A stand-in for Pi's level prefix holds its columns on the first row only, so continuation
      // rows keep the full width.
      const rows = wrapFacts(
        `${Str.repeat(prefix)("x")}${Str.trim(line)}`,
        NOTICE_COLUMNS - indent.length,
        NOTICE_HANGING,
      );
      return Arr.map(
        rows,
        (row, rowIndex) => `${indent}${rowIndex === 0 ? Fn.pipe(row, Str.slice(prefix)) : row}`,
      );
    }),
    "\n",
  );

export interface SettingsStatusRow {
  readonly id: string;
  /** The row's human name; falls back to the id. */
  readonly label?: string | undefined;
  readonly value?: string | undefined;
}

export interface SettingsStatusSection {
  readonly title?: string | undefined;
  readonly rows: ReadonlyArray<SettingsStatusRow>;
}

/** One setting as help and status name it: `Label: value (id)`. */
export const settingsStatusLine = (row: SettingsStatusRow): string => {
  const valued =
    row.value === undefined ? (row.label ?? row.id) : `${row.label ?? row.id}: ${row.value}`;
  return row.label === undefined ? valued : `${valued} (${row.id})`;
};

/**
 * The `/<ext> settings status` text: a title, then `Label: value (id)` rows grouped under
 * optional section titles, then notes, all wrapped for a 57-column phone.
 */
export const settingsStatusText = (options: {
  readonly title: string;
  readonly sections: ReadonlyArray<SettingsStatusSection>;
  readonly notes?: ReadonlyArray<string> | undefined;
}): string =>
  wrapNoticeText(
    Arr.join(
      [
        options.title,
        ...Arr.flatMap(options.sections, (section) => [
          ...(section.title === undefined ? [] : [section.title]),
          ...Arr.map(section.rows, (row) => `  ${settingsStatusLine(row)}`),
        ]),
        ...(options.notes ?? []),
      ],
      "\n",
    ),
  );

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
        header: Predicate.isString(header) ? settingsSurfaceHeader(theme, header) : header,
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
  create: (isCurrent: () => boolean, owner: SettingsCommandOwner) => ExtensionSubcommand,
): ExtensionSubcommand => {
  const owner = settingsCommandOwner();
  return {
    ...create(() => false, owner),
    handler: (args, ctx) => create(capture(), owner).handler(args, ctx),
  };
};

// Leaves room for `Warning: Unknown setting: ` on a 55-column notice line.
const UNKNOWN_SETTING_COLUMNS = 28;

export function settingsSubcommand<Config>(
  options: SettingsCommandOptions<Config>,
): ExtensionSubcommand {
  const { title, descriptors } = options;
  const owner = options.owner ?? settingsCommandOwner();
  const command = `${options.root} settings`;
  const scopes = options.scopes ?? [];
  const scopeNames = Arr.map(scopes, (scope) => scope.name);
  const unavailable = `${title} settings aren't available right now`;
  const { isCurrent } = options;
  const label = (id: string) =>
    Option.getOrUndefined(Arr.findFirst(descriptors, (entry) => entry.id === id))?.label;
  // `Label (id) <rule>`: how an invalid value reads, whether the shell or the owner rejected it.
  const invalidValue = (id: string, rule: string) => {
    const named = label(id);
    return named === undefined ? `${id} ${rule}` : `${named} (${id}) ${rule}`;
  };
  // The warning for an owner's rejected value, or undefined for a failure to save.
  const rejectedValue = (id: string, failure: { readonly message: string }) => {
    const lead = `${id} `;
    if (Fn.pipe(failure.message, Str.startsWith(lead)))
      return invalidValue(id, Str.trimStart(Fn.pipe(failure.message, Str.slice(lead.length))));
    return Predicate.isTagged(failure, "InvalidSettingError") ? failure.message : undefined;
  };
  // Every notice, including a consumer's status or failure text, fits a 57-column phone.
  const notify = (ctx: ExtensionContext, message: string, level: NoticeLevel) => {
    if (isCurrent()) notifyAtHostBoundary(ctx, wrapNoticeText(message, level), level);
  };
  const readConfig = (ctx: ExtensionContext) =>
    invokeHostCallback(() => options.config(ctx), undefined);
  const invoked = (ctx: ExtensionContext) =>
    invokeHostCallback(() => options.onInvoke?.(ctx), undefined);
  const optionalSignal = options.signal === "optional";
  // Undefined means the host context was retired before its signal could be read.
  const captureSignal = (
    ctx: ExtensionContext,
  ): { readonly signal: AbortSignal | undefined } | undefined => {
    if (optionalSignal) return { signal: capturedHostSignal(ctx) };
    const captured = captureHostSignal(ctx);
    return Predicate.isTagged(captured, "Captured") ? { signal: captured.signal } : undefined;
  };

  const applySetting = (
    ctx: ExtensionContext,
    id: string,
    value: string,
    signal: AbortSignal | undefined,
    show?: (value: string) => boolean | void,
    scope = scopeNames[0],
  ): Promise<void> =>
    owner.run(isCurrent, () => {
      invoked(ctx);
      const descriptor = Option.getOrUndefined(
        Arr.findFirst(descriptors, (entry) => entry.id === id),
      );
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
      return Promise.resolve()
        .then(() =>
          isCurrent()
            ? options.apply(ctx, id, value, signal, scope)
            : Result.fail({ message: "", stale: true }),
        )
        .then(
          (settlement) => {
            if (Result.isFailure(settlement)) {
              if (display(persisted() ?? before) && settlement.failure.stale !== true) {
                const rejected = rejectedValue(id, settlement.failure);
                notify(
                  ctx,
                  rejected ?? settlement.failure.message,
                  rejected === undefined ? "error" : "warning",
                );
              }
              return undefined;
            }
            const current = persisted() ?? value;
            if (show) display(current);
            else
              notify(
                ctx,
                Arr.join(
                  wrapFacts(
                    joinInline([
                      scopes.length > 0 && scope ? Str.capitalize(scope) : undefined,
                      `${descriptor?.label ?? id}: ${current}`,
                      options.confirmationNote,
                    ]),
                    NOTICE_COLUMNS,
                  ),
                  "\n",
                ),
                "info",
              );
            if (isCurrent())
              invokeHostCallback(() => options.afterApply?.(ctx, id, scope), undefined);
            return undefined;
          },
          () => {
            const current = display(persisted() ?? before);
            if (current && (!optionalSignal || !signal?.aborted))
              notify(ctx, unavailable, "warning");
          },
        );
    });

  const rowSetting = (row: string): readonly [scope: string | undefined, id: string] => {
    const scope = Option.getOrUndefined(
      Arr.findFirst(scopeNames, (name) => Fn.pipe(row, Str.startsWith(`${name}:`))),
    );
    return scope === undefined
      ? [undefined, row]
      : [scope, Fn.pipe(row, Str.slice(scope.length + 1))];
  };

  const openInteractive = (ctx: ExtensionContext) => {
    const captured = captureSignal(ctx);
    if (!captured) return notify(ctx, unavailable, "warning");
    let active = true;
    const apply: SettingsSession<Config>["apply"] = (id, value, show, scope) =>
      active
        ? applySetting(
            ctx,
            id,
            value,
            optionalSignal ? capturedHostSignal(ctx) : captured.signal,
            show,
            scope,
          )
        : Promise.resolve();
    const picker: SettingsSession<Config>["picker"] = (items, maxHeight = 20) => {
      const latest = new Map<string, object>();
      return openSettingsList(
        ctx,
        ({ tui, theme, finish }) => {
          // Saves a row and shows the value that persisted, ignoring superseded changes.
          const change = (row: string, value: string, show: (shown: string) => void) => {
            const [scope, id] = rowSetting(row);
            const token = {};
            latest.set(row, token);
            return apply(
              id,
              value,
              (shown) => {
                if (latest.get(row) !== token) return false;
                // A closed picker publishes nothing, but its failures still warn.
                if (active)
                  invokeHostCallback(() => {
                    show(shown);
                    tui.requestRender();
                  }, undefined);
                return true;
              },
              scope,
            ).catch(() => {
              if (latest.get(row) === token) notify(ctx, unavailable, "warning");
            });
          };
          // Open groups derive their rows again whenever any save, top-level or nested, settles.
          const saves = settingsSaveEvents();
          const withGroups = withSettingsGroupChildren(
            items,
            managerSettingsTheme(theme),
            change,
            saves,
          );
          return {
            header: `${title} settings`,
            items: withGroups,
            height: Math.min(maxHeight, withGroups.length + 2),
            onCancel: () => {
              active = false;
              finish(undefined);
            },
            onChange: (row, value, list) =>
              void change(row, value, (shown) => {
                list.updateValue(row, shown);
                saves.settled();
              }).finally(saves.settled),
          };
        },
        isCurrent,
      );
    };
    // Settle already admitted saves before the new invocation captures its rows. Never
    // hold ordering across options.open: that Promise owns the entire picker lifetime.
    return owner
      .run(isCurrent, () => Promise.resolve())
      .then(() => {
        if (!isCurrent()) return undefined;
        return options
          .open(ctx, { config: () => readConfig(ctx), apply, picker })
          .then((outcome) => {
            OwnedSurfaceOutcome.$match(outcome, {
              Settled: () => undefined,
              Blocked: () => notify(ctx, unavailable, "warning"),
              Failed: () => notify(ctx, `Couldn't open ${title} settings`, "warning"),
            });
            return undefined;
          });
      })
      .finally(() => {
        active = false;
      });
  };

  const scopeToken = scopes.length > 0 ? `[${Arr.join(scopeNames, "|")}] ` : "";
  const currentValues = (ctx: ExtensionContext) => {
    const cfg = readConfig(ctx);
    return Arr.map(descriptors, (descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      description: descriptor.description,
      value: cfg ? invokeHostCallback(() => descriptor.currentValue(cfg), undefined) : undefined,
    }));
  };
  const showHelp = (ctx: ExtensionContext) => {
    const notes = invokeHostCallback(() => options.notes?.(ctx) ?? [], []);
    const overview = extensionCommandOverview(command, options.description, [
      { name: "", description: "Open the settings list" },
      { name: `${scopeToken}<id> <value>`, description: "Change one setting" },
      { name: "status", description: "Show current values" },
      { name: "help", description: "Show this help" },
    ]);
    const lines = [
      overview,
      "",
      "Settings:",
      ...Arr.flatMap(currentValues(ctx), (row) => [
        `  ${settingsStatusLine(row)}`,
        ...Arr.map(
          wrapFacts(row.description, NOTICE_COLUMNS - DESCRIPTION_INDENT.length, ""),
          (line) => `${DESCRIPTION_INDENT}${line}`,
        ),
      ]),
      "",
      "Examples:",
      ...Arr.map(options.examples, (example) => `  /${command} ${example}`),
      ...(notes.length > 0 ? ["", ...notes] : []),
    ];
    notify(ctx, Arr.join(lines, "\n"), "info");
  };
  const defaultStatus = (ctx: ExtensionContext) =>
    settingsStatusText({
      title: `${title} settings`,
      sections: [{ rows: currentValues(ctx) }],
    });
  // A value's allowed forms, when they're a short list worth naming.
  const valueForm = (id: string) => {
    const descriptor = Option.getOrUndefined(
      Arr.findFirst(descriptors, (entry) => entry.id === id),
    );
    const values = descriptor?.values ? Arr.join(descriptor.values, "|") : "";
    return values && values.length <= 32 ? values : "<value>";
  };
  // `Add a value: <command>`, with the command on its own line when both don't fit.
  const correctForm = (lead: string, form: string) =>
    `${lead} ${form}`.length <= NOTICE_COLUMNS - NOTICE_PREFIX_COLUMNS.warning
      ? `${lead} ${form}`
      : `${lead}\n  ${form}`;
  const scopeArgument = (args: string) =>
    Option.getOrUndefined(
      Arr.findFirst(scopeNames, (name) => Str.split(Str.trim(args), /\s+/u)[0] === name),
    );

  const handle = (args: string, ctx: ExtensionContext) => {
    if (!isCurrent()) return;
    invoked(ctx);
    const dispatch = dispatchSettingsCommand(args, descriptors, scopeNames);
    return Match.value(dispatch).pipe(
      Match.tagsExhaustive({
        OpenInteractive: () => (hasCustomSurface(ctx) ? openInteractive(ctx) : showHelp(ctx)),
        Help: () => showHelp(ctx),
        Status: () =>
          Promise.resolve()
            .then(() =>
              isCurrent() ? (options.status ? options.status(ctx) : defaultStatus(ctx)) : undefined,
            )
            .then(
              (text) => {
                if (text !== undefined) notify(ctx, text, "info");
                return undefined;
              },
              () => notify(ctx, unavailable, "warning"),
            ),
        Invalid: (invalid) => {
          const unknown = (id: string) =>
            `Unknown setting: ${clipText(id, UNKNOWN_SETTING_COLUMNS)}\nSee the setting ids: /${command} help`;
          const scope = scopeArgument(args);
          const scoped = scope === undefined ? "" : `${scope} `;
          return notify(
            ctx,
            Match.value(invalid).pipe(
              Match.discriminatorsExhaustive("reason")({
                "invalid-value": ({ id, allowedValues }) =>
                  invalidValue(id, `must be one of: ${Arr.join(allowedValues, ", ")}`),
                "missing-value": ({ id }) => {
                  if (id && !Arr.some(descriptors, (entry) => entry.id === id)) return unknown(id);
                  return correctForm(
                    id ? "Add a value:" : "Add a setting and value:",
                    `/${command} ${scoped}${id || "<id>"} ${id ? valueForm(id) : "<value>"}`,
                  );
                },
                "unknown-setting": ({ id }) => unknown(id),
              }),
            ),
            "warning",
          );
        },
        Apply: ({ id, value, scope }) => {
          const captured = captureSignal(ctx);
          if (!captured) return notify(ctx, unavailable, "warning");
          return applySetting(ctx, id, value, captured.signal, undefined, scope);
        },
      }),
    );
  };

  return {
    name: "settings",
    description: options.description,
    complete: (prefix) =>
      completeSettingsArguments(
        prefix,
        descriptors,
        [
          { value: "status", label: "status", description: "Show current values" },
          { value: "help", label: "help", description: "Show setting ids" },
        ],
        Arr.map(scopes, (scope) => ({
          value: scope.name,
          label: scope.name,
          description: scope.description,
        })),
      ),
    handler: (args, ctx) => Promise.resolve(handle(args, ctx)),
  };
}
