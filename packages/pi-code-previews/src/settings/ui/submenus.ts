import {
  getSelectListTheme,
  getSettingsListTheme,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { managerSettingsTheme } from "pi-cosmic-ui/manager/settings-surface";
import { managerSelectTheme } from "pi-cosmic-ui/manager/searchable-select";
import {
  Container,
  SelectList,
  SettingsList,
  Spacer,
  Text,
  type SelectItem,
  type SettingItem,
} from "@earendil-works/pi-tui";
import { bundledThemes } from "shiki";
import { ON_OFF_VALUES, formatOnOff } from "../../config/values";
import {
  ALL_CODE_PREVIEW_TOOLS,
  parseCodePreviewTools,
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

  constructor(currentValue: string, done: (selectedValue?: string) => void, theme?: Theme) {
    super();
    this.selectedTools = parseCodePreviewTools(currentValue) ?? new Set(ALL_CODE_PREVIEW_TOOLS);
    this.settingsList = new SettingsList(
      createToolToggleItems(this.selectedTools, getCodePreviewToolStatuses()),
      ALL_CODE_PREVIEW_TOOLS.length + 2,
      theme ? managerSettingsTheme(theme) : getSettingsListTheme(),
      (id, value) => {
        const tool = parseToolToggleId(id);
        if (!tool) return;
        if (value === "on") this.selectedTools.add(tool);
        else this.selectedTools.delete(tool);
      },
      () => done(this.formatSelectedTools()),
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

  handleInput(data: string): void {
    this.settingsList.handleInput(data);
  }

  private formatSelectedTools(): string {
    return formatToolsSettingValue(
      ALL_CODE_PREVIEW_TOOLS.filter((tool) => this.selectedTools.has(tool)),
    );
  }
}

function createToolToggleItems(
  enabledTools: Set<CodePreviewToolName>,
  statuses: Map<CodePreviewToolName, CodePreviewToolStatus>,
): SettingItem[] {
  return ALL_CODE_PREVIEW_TOOLS.map((tool) => {
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

    const description =
      status?.state === "installed"
        ? "Preview replacement installed."
        : status?.state === "registration-error"
          ? "Registration failed; retry with /reload."
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

export class ThemeSelectSubmenu extends Container {
  private readonly selectList: SelectList;

  constructor(currentTheme: string, done: (selectedValue?: string) => void, theme?: Theme) {
    super();

    const themes: SelectItem[] = Object.keys(bundledThemes)
      .toSorted()
      .map((name) => ({ value: name, label: name }));

    this.selectList = new SelectList(
      themes,
      12,
      theme ? managerSelectTheme(theme) : getSelectListTheme(),
      {
        minPrimaryColumnWidth: 16,
        maxPrimaryColumnWidth: 48,
      },
    );

    const currentIndex = themes.findIndex((item) => item.value === currentTheme);
    if (currentIndex >= 0) this.selectList.setSelectedIndex(currentIndex);

    this.selectList.onSelect = (item) => done(item.value);
    this.selectList.onCancel = () => done(undefined);

    this.addChild(new Text("Syntax theme", 0, 0));
    this.addChild(new Text("Select a Shiki theme for code previews.", 0, 0));
    this.addChild(new Spacer(1));
    this.addChild(this.selectList);
    this.addChild(new Spacer(1));
    this.addChild(new Text("Enter Select · Esc Back", 0, 0));
  }

  handleInput(data: string): void {
    this.selectList.handleInput(data);
  }
}
