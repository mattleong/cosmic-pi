// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import { type ExtensionAPI, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import * as Predicate from "effect/Predicate";
import {
  invokeHostCallback,
  notifyAtHostBoundary,
  registerExtensionCommand,
  type CapturedHostSignal,
} from "pi-cosmic-core";
import {
  settingsSubcommand,
  type SettingsCommandOptions,
} from "pi-cosmic-ui/boundary/host-settings-command";
import type { OwnedSurfaceOutcome } from "pi-cosmic-ui/boundary/host-surface";
import {
  managerSettingsTheme,
  createSettingsListSurface,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
import {
  inputAtHostBoundary,
  openSettingsSurfaceAtHostBoundary,
  selectAtHostBoundary,
} from "../boundary/host-ui.ts";
import {
  CODE_MODE_SETTING_DESCRIPTORS,
  findCodeModeSettingDescriptor,
  type CodeModeSettingScope,
} from "../config/options.ts";
import { CODE_MODE_INTEGER_BOUNDS } from "../config/schema.ts";
import { CodeModeConfigStore, type CodeModeState } from "../config/store.ts";

const COMMAND = "code-mode";
const UNAVAILABLE_MESSAGE = "Code Mode settings aren't available right now";
const INHERIT_VALUE = "inherit";
/** A throwing host getter is treated as aborted, so settings fail closed without side effects. */
const signalAborted = (signal: AbortSignal | undefined): boolean =>
  invokeHostCallback(() => signal?.aborted === true, true);
/** Interactive-list sentinel that prompts for any in-bounds integer via `ctx.ui.input`. */
const CUSTOM_VALUE = "custom…";

const CODE_MODE_UNTRUSTED_NOTICE =
  "This project isn't trusted: you can change global settings, but Code Mode stays off here " +
  "until you trust the project";

const SCOPES = [
  { name: "global", description: "Change a setting everywhere" },
  { name: "project", description: "Change a setting for this trusted project" },
] as const;

const availabilityLine = (state: CodeModeState): string => {
  if (state.available)
    return "Code Mode is on for this project; run /reload if its tool isn't there yet";
  return state.projectTrusted
    ? "Code Mode is off; running programs stop now, and turning it back on takes effect after /reload"
    : "Code Mode is off because this project isn't trusted";
};

const scopeValues = (
  state: CodeModeState,
  scope: CodeModeSettingScope,
): Readonly<Record<string, boolean | number | undefined>> =>
  scope === "project" ? state.projectValues : state.globalValues;

const scopeDisplayValue = (
  state: CodeModeState | undefined,
  scope: CodeModeSettingScope,
  id: string,
): string => {
  const value = state === undefined ? undefined : scopeValues(state, scope)[id];
  return value === undefined ? INHERIT_VALUE : String(value);
};

const settingScope = (scope: string | undefined): CodeModeSettingScope =>
  scope === "project" ? "project" : "global";

export interface CodeModeSettingsControllerOptions {
  snapshot(): CodeModeState | undefined;
  captureSignal(ctx: ExtensionCommandContext): CapturedHostSignal;
  run<A, E>(effect: Effect.Effect<A, E, CodeModeConfigStore>, signal?: AbortSignal): Promise<A>;
}

type SettingsSession = Parameters<SettingsCommandOptions<CodeModeState>["open"]>[1];

/**
 * `/code-mode settings` through the shared settings shell: help, status, scoped scripted
 * changes, and validation messages are the shell's; the scope choice, the settings list, and
 * the custom integer prompt stay here. `/code-mode` has no other subcommands yet.
 */
export function registerCodeModeSettingsController(
  pi: ExtensionAPI,
  options: CodeModeSettingsControllerOptions,
): void {
  const { snapshot, captureSignal, run } = options;

  const statusLines = (state: CodeModeState): string[] => [
    "Code Mode settings",
    ...CODE_MODE_SETTING_DESCRIPTORS.map(
      (descriptor) =>
        `  ${descriptor.id} = ${String(state.config[descriptor.id])} (${state.provenance[descriptor.id]})`,
    ),
    availabilityLine(state),
    ...(state.projectTrusted ? [] : [CODE_MODE_UNTRUSTED_NOTICE]),
  ];

  const surfaceItems = (state: CodeModeState, scope: CodeModeSettingScope): SettingsSurfaceItem[] =>
    CODE_MODE_SETTING_DESCRIPTORS.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      currentValue: scopeDisplayValue(state, scope, descriptor.id),
      values: [
        ...descriptor.values,
        ...(descriptor.kind === "integer" ? [CUSTOM_VALUE] : []),
        INHERIT_VALUE,
      ],
      description: `${descriptor.description} Effective: ${String(state.config[descriptor.id])} (${state.provenance[descriptor.id]}).`,
    }));

  const openScopeSettings = (
    ctx: ExtensionCommandContext,
    scope: CodeModeSettingScope,
    commandSignal: AbortSignal | undefined,
    session: SettingsSession,
  ): Effect.Effect<"settled" | "failed"> =>
    Effect.gen(function* () {
      while (!signalAborted(commandSignal)) {
        const state = snapshot();
        if (state === undefined) return "settled";
        const items = surfaceItems(state, scope);
        const pendingWrites: Promise<void>[] = [];
        const outcome = yield* openSettingsSurfaceAtHostBoundary(
          ctx,
          (tui, theme, keybindings, done, surfaceSignal) =>
            createSettingsListSurface({
              header: new Text(
                theme.fg("accent", theme.bold(`Code Mode settings · ${scope}`)),
                1,
                1,
              ),
              items,
              height: Math.min(12, items.length + 2),
              listTheme: managerSettingsTheme(theme),
              onChange: (id, value, list) => {
                if (signalAborted(surfaceSignal)) return;
                if (value === CUSTOM_VALUE) {
                  done({ _tag: "PromptInteger", id });
                  return;
                }
                const show = (currentValue: string) => {
                  if (signalAborted(surfaceSignal)) return;
                  invokeHostCallback(() => {
                    list.updateValue(id, currentValue);
                    tui.requestRender();
                  }, undefined);
                };
                pendingWrites.push(session.apply(id, value, show, scope));
              },
              onCancel: () => invokeHostCallback(() => done({ _tag: "Closed" }), undefined),
              matchesKeybinding: invokeHostCallback(
                () => Predicate.isFunction(keybindings?.matches),
                false,
              )
                ? (data, id) => invokeHostCallback(() => keybindings.matches(data, id), false)
                : undefined,
              requestRender: () => {
                if (!signalAborted(surfaceSignal))
                  invokeHostCallback(() => tui.requestRender(), undefined);
              },
              dim: (text) => invokeHostCallback(() => theme.fg("dim", text), text),
              bridge: { invoke: invokeHostCallback },
            }).surface,
        );
        // Every apply absorbs its own failure, so this interruptible join cannot reject.
        yield* Effect.promise(() => Promise.all(pendingWrites));
        if (outcome._tag === "Failed") return "failed";
        if (outcome._tag === "Closed") return "settled";

        const descriptor = findCodeModeSettingDescriptor(outcome.id);
        if (descriptor === undefined || descriptor.kind !== "integer") continue;
        const current = snapshot();
        if (current === undefined) return "settled";
        const bounds = CODE_MODE_INTEGER_BOUNDS[descriptor.id];
        const result = yield* inputAtHostBoundary(
          ctx,
          `${descriptor.id}: a whole number from ${bounds.minimum} to ${bounds.maximum}`,
          String(current.config[descriptor.id]),
        );
        if (result._tag === "Unavailable")
          notifyAtHostBoundary(ctx, `Couldn't read a value for ${descriptor.id}`, "warning");
        if (result._tag !== "Answered") continue;
        if (snapshot() === undefined) return "settled";
        yield* Effect.promise(() => session.apply(descriptor.id, result.value, undefined, scope));
      }
      return "settled";
    });

  const open = (
    ctx: ExtensionCommandContext,
    session: SettingsSession,
  ): Promise<OwnedSurfaceOutcome<unknown>> => {
    const state = snapshot();
    const captured = captureSignal(ctx);
    if (!state || captured._tag === "Unavailable") return Promise.resolve({ _tag: "Blocked" });
    const settled: OwnedSurfaceOutcome<unknown> = { _tag: "Settled", value: undefined };
    if (signalAborted(captured.signal)) return Promise.resolve(settled);
    const workflow = Effect.gen(function* () {
      if (!state.projectTrusted) {
        notifyAtHostBoundary(ctx, CODE_MODE_UNTRUSTED_NOTICE, "warning");
        return yield* openScopeSettings(ctx, "global", captured.signal, session);
      }
      const choice = yield* selectAtHostBoundary(ctx, "Code Mode settings scope", [
        "global",
        "project",
      ]);
      if (choice._tag === "Cancelled") return "settled" as const;
      const scope: CodeModeSettingScope =
        choice._tag === "Answered" && choice.value === "project" ? "project" : "global";
      return yield* openScopeSettings(ctx, scope, captured.signal, session);
    });
    return run(workflow, captured.signal).then(
      (result): OwnedSurfaceOutcome<unknown> =>
        result === "failed" ? { _tag: "Failed", cause: undefined } : settled,
      () => settled,
    );
  };

  const settings = settingsSubcommand<CodeModeState>({
    root: COMMAND,
    description: "Configure Code Mode (trusted projects only)",
    title: "Code Mode",
    descriptors: CODE_MODE_SETTING_DESCRIPTORS.map((descriptor) => ({
      id: descriptor.id,
      description: descriptor.description,
      values: [...descriptor.values, INHERIT_VALUE],
      openValues: descriptor.kind === "integer",
      currentValue: (state: CodeModeState) => String(state.config[descriptor.id]),
    })),
    examples: ["enabled true", "project maxToolCalls 50", "global timeoutMs inherit"],
    notes: () => [
      "Scope defaults to global. Project values override global ones one setting at a time;",
      `${INHERIT_VALUE} removes a value from its scope. Whole-number settings accept any value`,
      `within their bounds; the list's ${CUSTOM_VALUE} row asks for one.`,
      ...(snapshot()?.projectTrusted === false ? ["", CODE_MODE_UNTRUSTED_NOTICE] : []),
    ],
    scopes: SCOPES,
    scopeBlocked: (_ctx, scope) =>
      scope === "project" && snapshot()?.projectTrusted !== true
        ? CODE_MODE_UNTRUSTED_NOTICE
        : undefined,
    config: () => snapshot(),
    status: () => {
      const state = snapshot();
      if (!state) throw new Error(UNAVAILABLE_MESSAGE);
      return statusLines(state).join("\n");
    },
    apply: (_ctx, id, value, signal, scope) => {
      if (signalAborted(signal)) return Promise.reject(new Error("Settings request was cancelled"));
      const target = settingScope(scope);
      return run(
        CodeModeConfigStore.use((store) =>
          value === INHERIT_VALUE
            ? store.clearSetting(target, id)
            : store.setSetting(target, id, value),
        ).pipe(
          Effect.mapError((error) => ({ message: error.message })),
          Effect.result,
        ),
        signal,
      );
    },
    displayValue: (_ctx, id, scope) => scopeDisplayValue(snapshot(), settingScope(scope), id),
    afterApply: (ctx, id) => {
      const state = snapshot();
      if (id === "enabled" && state) notifyAtHostBoundary(ctx, availabilityLine(state), "info");
    },
    open,
  });
  registerExtensionCommand(pi, {
    name: COMMAND,
    description: "Code Mode settings",
    subcommands: [settings],
  });
}
