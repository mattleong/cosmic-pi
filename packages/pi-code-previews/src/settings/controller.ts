import * as Result from "effect/Result";
import * as Arr from "effect/Array";
import * as Predicate from "effect/Predicate";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
  captureHostSignal,
  isProjectTrusted,
  notifyAtHostBoundary,
} from "pi-cosmic-core/host-session";
import { clipText } from "pi-cosmic-core/display";
import { formatDisplayPath } from "pi-cosmic-core/platform/paths";
import { type ExtensionSubcommand } from "pi-cosmic-core/host-command";
import { findOrUndefined } from "pi-cosmic-core/array";
import {
  openSettingsList,
  settingsStatusText,
  settingsSubcommand,
  withInvocationAuthority,
  type SettingsCommandOwner,
} from "pi-cosmic-ui/boundary/host-settings-command";
import { OwnedSurfaceOutcome } from "pi-cosmic-ui/boundary/host-surface";
import {
  captureCodePreviewSessionCapability,
  hasCodePreviewSessionCapability,
  rejectInactiveCodePreviewSession,
} from "../application/capability";
import { CODE_PREVIEW_SETTING_KEYS, type CodePreviewSettings } from "../config/schema";
import { codePreviewSettings } from "../config/state";
import {
  formatSettingsSaveError,
  getSettingsPath,
  type LoadSettingsOptions,
} from "../config/store";
import { formatSettingValue, updateSetting } from "../config/values";
import { SETTING_ITEM_DEFINITIONS, type SettingItemDefinition } from "./ui/registry";

const SCRIPTED_SETTINGS = Arr.flatMap(CODE_PREVIEW_SETTING_KEYS, (id) => {
  if (id === "tools") return [];
  const { label, description, values, rule }: SettingItemDefinition = SETTING_ITEM_DEFINITIONS[id];
  return [{ id, label, description, rule, ...(values && { values: [...values] }) }];
});

// A rejected value is quoted only as far as a notice can show it.
const REJECTED_VALUE_COLUMNS = 24;

const config = (): CodePreviewSettings | undefined =>
  hasCodePreviewSessionCapability() ? codePreviewSettings : undefined;

const loadOptions = (ctx: ExtensionCommandContext): LoadSettingsOptions => ({
  projectCwd: ctx.cwd,
  projectTrusted: isProjectTrusted(ctx),
});

const captureAuthority = (): (() => boolean) => {
  const captured = captureCodePreviewSessionCapability();
  return () => captureCodePreviewSessionCapability() === captured;
};

type LoadSettingsPanel = () => Promise<typeof import("./panel")>;

export function codePreviewSettingsSubcommand(
  loadPanel: LoadSettingsPanel = () => import("./panel"),
): ExtensionSubcommand {
  return withInvocationAuthority(captureAuthority, (isCurrent, owner) =>
    codePreviewSettingsCommand(isCurrent, owner, loadPanel),
  );
}

function codePreviewSettingsCommand(
  isCurrent: () => boolean,
  owner: SettingsCommandOwner,
  loadPanel: LoadSettingsPanel,
): ExtensionSubcommand {
  // Each invocation owns its captured signal, including the shared command's late notifications.
  // The live context getter may expose another turn's signal after the panel import settles.
  let operationSignal: AbortSignal | undefined;
  const operationIsCurrent = () => isCurrent() && !operationSignal?.aborted;
  return settingsSubcommand<CodePreviewSettings>({
    owner,
    root: "code-previews",
    isCurrent: operationIsCurrent,
    description: "Preview settings",
    title: "Code Previews",
    scopes: [{ name: "global", description: "Every project" }],
    descriptors: Arr.map(SCRIPTED_SETTINGS, (setting) => ({
      ...setting,
      currentValue: (settings: CodePreviewSettings) => formatSettingValue(settings, setting.id),
    })),
    examples: ["toolCallCollapsedStyle compact", "readCollapsedLines 40"],
    notes: (ctx) => [
      `Settings are saved in ${formatDisplayPath(getSettingsPath(), ctx.cwd)}.`,
      "Changes to tool call appearance and preview tools apply after /reload.",
      "Native MCP calls use this appearance; manage servers through /mcp.",
    ],
    config,
    status: (ctx) => {
      const current = config();
      if (!current) return "Code Previews settings aren't available right now";
      return settingsStatusText({
        title: "Code Previews settings",
        sections: [
          {
            rows: Arr.map(SCRIPTED_SETTINGS, (setting) => ({
              id: setting.id,
              label: setting.label,
              value: formatSettingValue(current, setting.id),
            })),
          },
        ],
        notes: [`Settings file: ${formatDisplayPath(getSettingsPath(), ctx.cwd)}`],
      });
    },
    apply: (ctx, id, value, signal) => {
      operationSignal = signal;
      if (!operationIsCurrent() || !config()) return rejectInactiveCodePreviewSession("settings");
      const setting = findOrUndefined(SCRIPTED_SETTINGS, (entry) => entry.id === id);
      const previous = codePreviewSettings;
      const updated = updateSetting(previous, id, value);
      if (!setting || formatSettingValue(updated, setting.id) !== value)
        return Promise.resolve(
          Result.fail({
            message: `${id} ${setting?.rule ?? `can't be set to ${clipText(value, REJECTED_VALUE_COLUMNS)}`}`,
          }),
        );
      const options = loadOptions(ctx);
      return loadPanel()
        .then((panel) => {
          if (!operationIsCurrent()) return rejectInactiveCodePreviewSession("settings");
          return panel.persistSettingsChange(
            updated,
            previous,
            options,
            undefined,
            operationIsCurrent,
            [setting.id],
          );
        })
        .then(
          () => Result.succeed(undefined),
          (cause: unknown) => Result.fail({ message: formatSettingsSaveError(cause, ctx.cwd) }),
        );
    },
    open: (ctx, session) => {
      const captured = captureHostSignal(ctx);
      if (!Predicate.isTagged(captured, "Captured"))
        return Promise.resolve(OwnedSurfaceOutcome.Blocked());
      operationSignal = captured.signal;
      if (!operationIsCurrent() || !session.config())
        return Promise.resolve(OwnedSurfaceOutcome.Blocked());
      const options = loadOptions(ctx);
      return loadPanel()
        .then(({ createCodePreviewSettingsModel }) => {
          if (!operationIsCurrent() || !session.config()) return OwnedSurfaceOutcome.Blocked();
          return openSettingsList(
            ctx,
            ({ theme, finish }) => {
              const model = createCodePreviewSettingsModel({
                theme,
                notify: (message, level) => notifyAtHostBoundary(ctx, message, level),
                done: () => finish(undefined),
                loadOptions: options,
                isCurrent: operationIsCurrent,
              });
              return {
                header: "Code Previews settings",
                items: model.items,
                height: Math.min(20, model.items.length + 2),
                onChange: model.onChange,
                onCancel: model.onCancel,
                onList: model.bind,
              };
            },
            operationIsCurrent,
          );
        })
        .catch((cause: unknown) => OwnedSurfaceOutcome.Failed({ cause }));
    },
  });
}
