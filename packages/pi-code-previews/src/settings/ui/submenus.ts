import * as Arr from "effect/Array";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  createSettingsChoiceSubmenu,
  managerSettingsTheme,
  settingsListHint,
} from "pi-cosmic-ui/manager/settings-surface";
import {
  Container,
  SettingsList,
  Spacer,
  Text,
  type Component,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { bundledThemes } from "shiki/themes";
import { ON_OFF_VALUES, formatOnOff } from "../../config/values";
import {
  ALL_CODE_PREVIEW_TOOLS,
  parseToolToggleId,
  toolToggleId,
  type CodePreviewToolName,
} from "../../tools/names";
import { formatToolsSettingValue } from "../../tools/policy";
import {
  formatToolOwner,
  getCodePreviewToolStatuses,
  type CodePreviewToolStatus,
} from "../../tools/status";

export class ToolPreviewSettingsSubmenu extends Container {
  private readonly selectedTools: Set<CodePreviewToolName>;
  private readonly settingsList: SettingsList;

  constructor(
    tools: readonly CodePreviewToolName[],
    done: (selectedValue?: string) => void,
    theme: Theme | undefined,
    required: ReadonlySet<CodePreviewToolName>,
  ) {
    super();
    this.selectedTools = new Set(tools);
    this.settingsList = new SettingsList(
      createToolToggleItems(this.selectedTools, getCodePreviewToolStatuses(), required),
      ALL_CODE_PREVIEW_TOOLS.length + 2,
      theme ? managerSettingsTheme(theme) : getSettingsListTheme(),
      (id, value) => {
        const tool = parseToolToggleId(id);
        if (!tool) return;
        if (value === "on") this.selectedTools.add(tool);
        else this.selectedTools.delete(tool);
      },
      () =>
        done(
          formatToolsSettingValue(
            Arr.filter(ALL_CODE_PREVIEW_TOOLS, (tool) => this.selectedTools.has(tool)),
          ),
        ),
    );

    this.addChild(new Text("Preview tools", 0, 0));
    this.addChild(
      new Text(
        "Toggle previews individually. Changes take effect after /reload; tools owned by another extension stay disabled.",
        0,
        0,
      ),
    );
    this.addChild(new Spacer(1));
    this.addChild(this.settingsList);
  }

  settingsHint(expanded: boolean): string {
    return settingsListHint(this.settingsList, { level: "nested", expanded });
  }

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }
}

function createToolToggleItems(
  enabledTools: Set<CodePreviewToolName>,
  statuses: Map<CodePreviewToolName, CodePreviewToolStatus>,
  required: ReadonlySet<CodePreviewToolName>,
): SettingItem[] {
  return Arr.map(ALL_CODE_PREVIEW_TOOLS, (tool) => {
    const status = statuses.get(tool);
    if (status?.state === "skipped-conflict") {
      const owner = formatToolOwner(status.owner);
      return {
        id: toolToggleId(tool),
        label: `${tool} preview`,
        description: `${owner} owns this tool.`,
        currentValue: `disabled (${owner})`,
      };
    }

    const description = required.has(tool)
      ? "Stays on while this tool's preview setting is off."
      : status?.state === "installed"
        ? "Preview renderer available."
        : status?.state === "registration-error"
          ? "Write hook registration failed; retry with /reload."
          : status?.state === "unavailable"
            ? "Tool is not available; previews never enable it."
            : "Takes effect after /reload.";
    return {
      id: toolToggleId(tool),
      label: `${tool} preview`,
      description,
      currentValue: formatOnOff(enabledTools.has(tool)),
      values: [...ON_OFF_VALUES],
    };
  });
}

export function createThemeSelectSubmenu(
  currentTheme: string,
  done: (selectedValue?: string) => void,
  theme: Theme | undefined,
): Component {
  return createSettingsChoiceSubmenu({
    title: "Syntax theme",
    description: "Shiki theme for code previews.",
    values: Arr.sort(Rec.keys(bundledThemes), Order.String),
    current: currentTheme,
    theme: theme ? managerSettingsTheme(theme) : getSettingsListTheme(),
    done,
    maxVisible: 12,
  });
}
