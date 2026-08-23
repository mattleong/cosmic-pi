// Pi command and custom-UI handlers are Promise-shaped host boundaries.
import * as Predicate from "effect/Predicate";

import {
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import * as Effect from "effect/Effect";
import { completeSettingsArguments } from "pi-cosmic-core";
import {
  createSettingsListSurface,
  type SettingsSurfaceItem,
} from "pi-cosmic-ui/manager/settings-surface";
import { notifyAtHostBoundary, type HostNotificationLevel } from "../boundary/host-notifier.ts";
import { type CapturedHostSignal } from "../boundary/host-session.ts";
import {
  hasCustomSurface,
  inputAtHostBoundary,
  invokeHostCallback,
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
import { dispatchCodeModeSettings } from "./dispatch.ts";

const COMMAND = "code-mode-settings";
const UNAVAILABLE_MESSAGE = "Code Mode settings are unavailable.";
const INHERIT_VALUE = "inherit";
/** Interactive-list sentinel that prompts for any in-bounds integer via `ctx.ui.input`. */
export const CUSTOM_VALUE = "custom…";

export const CODE_MODE_UNTRUSTED_NOTICE =
  "This project is not trusted: global settings can be edited, but Code Mode remains " +
  "unavailable in this project until the project is trusted.";

const SETTING_IDS: readonly string[] = CODE_MODE_SETTING_DESCRIPTORS.map(
  (descriptor) => descriptor.id,
);

// SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
const COMPLETION_DESCRIPTORS = CODE_MODE_SETTING_DESCRIPTORS.map((descriptor) => ({
  id: descriptor.id as string,
  description: descriptor.description,
  values: [...descriptor.values, INHERIT_VALUE],
}));

const EXTRA_COMPLETIONS = [
  {
    value: "global",
    label: "global",
    description: "Edit the global scope: /code-mode-settings global <id> <value>",
  },
  {
    value: "project",
    label: "project",
    description: "Edit the trusted-project scope: /code-mode-settings project <id> <value>",
  },
  { value: "status", label: "status", description: "Show effective values and availability" },
  { value: "help", label: "help", description: "Show setting ids and usage" },
];

const availabilityLine = (state: CodeModeState): string => {
  if (state.available) {
    return "Code Mode availability: enabled for this trusted project. The code_mode tool registers at session start; if it is not registered yet, run /reload.";
  }
  return state.projectTrusted
    ? "Code Mode availability: disabled by settings. Disabling stops executions immediately; enabling registers the code_mode tool at the next session start (/reload)."
    : "Code Mode availability: unavailable — this project is not trusted.";
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

type ApplyRequest =
  | {
      readonly kind: "set";
      readonly scope: CodeModeSettingScope;
      readonly id: string;
      readonly value: string;
    }
  | { readonly kind: "clear"; readonly scope: CodeModeSettingScope; readonly id: string };

type ApplyOutcome =
  | { readonly _tag: "Applied"; readonly state: CodeModeState }
  | { readonly _tag: "Rejected"; readonly message: string };

export interface CodeModeSettingsControllerOptions {
  snapshot(): CodeModeState | undefined;
  captureSignal(ctx: ExtensionCommandContext): CapturedHostSignal;
  run<A, E>(effect: Effect.Effect<A, E, CodeModeConfigStore>, signal?: AbortSignal): Promise<A>;
}

export function registerCodeModeSettingsController(
  pi: ExtensionAPI,
  options: CodeModeSettingsControllerOptions,
): void {
  const { snapshot, captureSignal, run } = options;

  const feedback = (
    ctx: ExtensionCommandContext,
    message: string,
    level: HostNotificationLevel,
  ): Promise<void> => {
    notifyAtHostBoundary(ctx, message, level);
    return Promise.resolve();
  };

  const helpLines = (state: CodeModeState | undefined): string[] => [
    "Code Mode settings (the code_mode tool runs confined programs over all Pi built-ins)",
    ...CODE_MODE_SETTING_DESCRIPTORS.map((descriptor) => {
      const current = state ? `=${descriptor.format(state.config)}` : "";
      return `  ${descriptor.id}${current}  — ${descriptor.description}`;
    }),
    "",
    "Usage:",
    "  /code-mode-settings",
    "  /code-mode-settings status",
    "  /code-mode-settings [global|project] <id> <value>",
    "  /code-mode-settings [global|project] <id> inherit",
    "",
    "Scope defaults to global. Project fields override global fields one field at a time;",
    "`inherit` removes the field from the chosen scope. Integer settings accept any value",
    `inside their documented bounds; the interactive list's \`${CUSTOM_VALUE}\` row prompts for one.`,
    ...(state && !state.projectTrusted ? ["", CODE_MODE_UNTRUSTED_NOTICE] : []),
  ];

  const statusLines = (state: CodeModeState): string[] => [
    "Code Mode settings — effective values",
    ...CODE_MODE_SETTING_DESCRIPTORS.map(
      (descriptor) =>
        `  ${descriptor.id} = ${descriptor.format(state.config)} (${state.provenance[descriptor.id]})`,
    ),
    availabilityLine(state),
    ...(state.projectTrusted ? [] : [CODE_MODE_UNTRUSTED_NOTICE]),
  ];

  const showStatus = (ctx: ExtensionCommandContext): Promise<void> => {
    const state = snapshot();
    if (!state) return feedback(ctx, UNAVAILABLE_MESSAGE, "warning");
    return feedback(ctx, statusLines(state).join("\n"), "info");
  };

  const applySetting = (
    ctx: ExtensionCommandContext,
    request: ApplyRequest,
    signal: AbortSignal | undefined,
    updateDisplay?: (currentValue: string) => void,
  ): Promise<void> => {
    const revertOptimisticDisplay = () => {
      updateDisplay?.(scopeDisplayValue(snapshot(), request.scope, request.id));
    };
    const effect = CodeModeConfigStore.use((store) =>
      request.kind === "set"
        ? store.setSetting(request.scope, request.id, request.value)
        : store.clearSetting(request.scope, request.id),
    ).pipe(
      Effect.map((state): ApplyOutcome => ({ _tag: "Applied", state })),
      Effect.catch(
        (error): Effect.Effect<ApplyOutcome> =>
          Effect.succeed({ _tag: "Rejected", message: error.message }),
      ),
    );
    return run(effect, signal)
      .then((outcome) => {
        if (outcome._tag === "Rejected") {
          notifyAtHostBoundary(ctx, outcome.message, "error");
          revertOptimisticDisplay();
          return;
        }
        const display = scopeDisplayValue(outcome.state, request.scope, request.id);
        if (updateDisplay) updateDisplay(display);
        else notifyAtHostBoundary(ctx, `${request.scope} ${request.id} = ${display}`, "info");
        if (request.id === "enabled") {
          notifyAtHostBoundary(ctx, availabilityLine(outcome.state), "info");
        }
      })
      .catch(() => {
        notifyAtHostBoundary(ctx, UNAVAILABLE_MESSAGE, "warning");
        try {
          revertOptimisticDisplay();
        } catch {
          // Hostile list/render callbacks stay contained at the host boundary.
        }
      });
  };

  /**
   * `custom…` flow for integer settings: prompt for a free value with `ctx.ui.input`.
   * Cancelled, invalid, and hostile input never persists anything; the optimistic display
   * always returns to the persisted value.
   */
  const promptCustomInteger = (
    ctx: ExtensionCommandContext,
    scope: CodeModeSettingScope,
    id: string,
    signal: AbortSignal | undefined,
    updateDisplay: (currentValue: string) => void,
  ): Promise<void> => {
    const revert = () => updateDisplay(scopeDisplayValue(snapshot(), scope, id));
    const descriptor = findCodeModeSettingDescriptor(id);
    if (descriptor === undefined || descriptor.kind !== "integer") {
      revert();
      return Promise.resolve();
    }
    const bounds = CODE_MODE_INTEGER_BOUNDS[descriptor.id];
    const state = snapshot();
    return inputAtHostBoundary(
      ctx,
      `${descriptor.id}: integer between ${bounds.minimum} and ${bounds.maximum}`,
      state === undefined ? undefined : descriptor.format(state.config),
    ).then((result) => {
      if (result._tag === "Unavailable") {
        notifyAtHostBoundary(ctx, `Unable to read a custom value for ${id}.`, "warning");
        revert();
        return;
      }
      if (result._tag === "Cancelled") {
        revert();
        return;
      }
      return applySetting(
        ctx,
        { kind: "set", scope, id, value: result.value },
        signal,
        updateDisplay,
      );
    });
  };

  const openScopeSettings = (
    ctx: ExtensionCommandContext,
    scope: CodeModeSettingScope,
    signal: AbortSignal | undefined,
  ): Promise<void> => {
    const state = snapshot();
    if (!state) return feedback(ctx, UNAVAILABLE_MESSAGE, "warning");
    const items: SettingsSurfaceItem[] = CODE_MODE_SETTING_DESCRIPTORS.map((descriptor) => ({
      id: descriptor.id,
      label: descriptor.label,
      currentValue: scopeDisplayValue(state, scope, descriptor.id),
      values: [
        ...descriptor.values,
        ...(descriptor.kind === "integer" ? [CUSTOM_VALUE] : []),
        INHERIT_VALUE,
      ],
      description: `${descriptor.description} Effective: ${descriptor.format(state.config)} (${state.provenance[descriptor.id]}).`,
    }));
    return openSettingsSurfaceAtHostBoundary(
      ctx,
      (tui, theme, keybindings, done) =>
        createSettingsListSurface({
          header: new Text(
            theme.fg("accent", theme.bold(`Code Mode Settings — ${scope} scope`)),
            1,
            1,
          ),
          items,
          height: Math.min(12, items.length + 2),
          listTheme: getSettingsListTheme(),
          // SettingsList shows the cycled value optimistically; both apply outcomes route
          // through the same display update, so failures restore the persisted value.
          onChange: (id, value, list) => {
            // Hostile list/render callbacks stay contained at the host boundary.
            const show = (currentValue: string) => {
              invokeHostCallback(() => {
                list.updateValue(id, currentValue);
                tui.requestRender();
              }, undefined);
            };
            if (value === CUSTOM_VALUE) {
              void promptCustomInteger(ctx, scope, id, signal, show);
              return;
            }
            const request: ApplyRequest =
              value === INHERIT_VALUE
                ? { kind: "clear", scope, id }
                : { kind: "set", scope, id, value };
            void applySetting(ctx, request, signal, show);
          },
          onCancel: () => invokeHostCallback(() => done(undefined), undefined),
          matchesKeybinding: invokeHostCallback(
            () => Predicate.isFunction(keybindings?.matches),
            false,
          )
            ? (data, id) => invokeHostCallback(() => keybindings.matches(data, id), false)
            : undefined,
          requestRender: () => invokeHostCallback(() => tui.requestRender(), undefined),
          dim: (text) => invokeHostCallback(() => theme.fg("dim", text), text),
          // The composed surface delegates render/invalidate/input through this caller-owned
          // guard, so hostile or malformed host invocations resolve to neutral fallbacks.
          bridge: { invoke: invokeHostCallback },
        }).surface,
    ).then((outcome) => {
      if (outcome === "failed") {
        notifyAtHostBoundary(ctx, "Unable to open Code Mode settings.", "warning");
      }
    });
  };

  const openInteractiveSettings = (ctx: ExtensionCommandContext): Promise<void> => {
    const state = snapshot();
    if (!state) return feedback(ctx, UNAVAILABLE_MESSAGE, "warning");
    const capturedSignal = captureSignal(ctx);
    if (capturedSignal._tag === "Unavailable") return feedback(ctx, UNAVAILABLE_MESSAGE, "warning");
    if (!state.projectTrusted) {
      // Untrusted projects only ever see the global scope.
      notifyAtHostBoundary(ctx, CODE_MODE_UNTRUSTED_NOTICE, "warning");
      return openScopeSettings(ctx, "global", capturedSignal.signal);
    }
    return selectAtHostBoundary(ctx, "Code Mode settings scope", ["global", "project"]).then(
      (choice) => {
        if (choice._tag === "Cancelled") return;
        // A host without a usable selector degrades to the global scope instead of failing.
        const scope: CodeModeSettingScope =
          choice._tag === "Answered" && choice.value === "project" ? "project" : "global";
        return openScopeSettings(ctx, scope, capturedSignal.signal);
      },
    );
  };

  pi.registerCommand(COMMAND, {
    description: "Configure Code Mode settings for the code_mode tool (trusted projects only)",
    getArgumentCompletions: (prefix) => {
      const normalized = prefix.replace(/^\s+/, "");
      const scoped = normalized.match(/^(global|project)\s+([\s\S]*)$/);
      if (scoped) {
        const scope = scoped[1] ?? "global";
        const completions = completeSettingsArguments(scoped[2] ?? "", COMPLETION_DESCRIPTORS);
        return completions
          ? completions.map((completion) => ({
              ...completion,
              value: `${scope} ${completion.value}`,
              label: `${scope} ${completion.value}`,
            }))
          : null;
      }
      return completeSettingsArguments(prefix, COMPLETION_DESCRIPTORS, EXTRA_COMPLETIONS);
    },
    handler: (args, ctx) => {
      const dispatch = dispatchCodeModeSettings(args, SETTING_IDS);
      switch (dispatch._tag) {
        case "OpenInteractive":
          // Outside an interactive TUI the bare command never prompts or blocks: help is
          // delivered through `ctx.ui.notify`, which RPC hosts receive as a notification
          // and print/JSON modes drop (making the bare command a non-blocking no-op there).
          return invokeHostCallback(() => ctx.mode === "tui", false) && hasCustomSurface(ctx)
            ? openInteractiveSettings(ctx)
            : feedback(ctx, helpLines(snapshot()).join("\n"), "info");
        case "Help":
          return feedback(ctx, helpLines(snapshot()).join("\n"), "info");
        case "Status":
          return showStatus(ctx);
        case "Invalid":
          return dispatch.reason === "unknown-setting"
            ? feedback(ctx, `Unknown setting: ${dispatch.id}`, "error")
            : feedback(
                ctx,
                "Usage: /code-mode-settings [global|project] <id> <value|inherit>",
                "error",
              );
        case "Apply":
        case "Clear": {
          const state = snapshot();
          if (!state) return feedback(ctx, UNAVAILABLE_MESSAGE, "warning");
          if (dispatch.scope === "project" && !state.projectTrusted)
            return feedback(ctx, CODE_MODE_UNTRUSTED_NOTICE, "warning");
          const capturedSignal = captureSignal(ctx);
          if (capturedSignal._tag === "Unavailable")
            return feedback(ctx, UNAVAILABLE_MESSAGE, "warning");
          const request: ApplyRequest =
            dispatch._tag === "Clear"
              ? { kind: "clear", scope: dispatch.scope, id: dispatch.id }
              : {
                  kind: "set",
                  scope: dispatch.scope,
                  id: dispatch.id,
                  value: dispatch.value,
                };
          return applySetting(ctx, request, capturedSignal.signal);
        }
      }
    },
  });
}
