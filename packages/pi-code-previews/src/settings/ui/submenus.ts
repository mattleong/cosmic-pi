import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Order from "effect/Order";
import * as Rec from "effect/Record";
import { getSettingsListTheme, type Theme } from "@earendil-works/pi-coding-agent";
import {
  createSettingsChoiceSubmenu,
  createSettingsGroupSubmenu,
  managerSettingsTheme,
} from "pi-cosmic-ui/manager/settings-surface";
import { type Component, type SettingItem } from "@earendil-works/pi-tui";
import { bundledThemes } from "shiki/themes";
import { ON_OFF_VALUES, formatOnOff } from "../../config/values";
import {
  ALL_CODE_PREVIEW_TOOLS,
  parseToolToggleId,
  toolToggleId,
  type CodePreviewToolName,
} from "../../tools/names";
import type { ToolPreviewSetting } from "../../tools/policy";
import { SETTING_ITEM_DEFINITIONS } from "./registry";
import {
  formatToolOwner,
  getCodePreviewToolStatuses,
  type CodePreviewToolStatus,
} from "../../tools/status";

/** The `Enabled tools` list: a toggle per tool, read-only where a setting or owner decides. */
export function createToolPreviewSettingsSubmenu(
  tools: readonly CodePreviewToolName[],
  done: (selectedValue?: string) => void,
  theme: Theme | undefined,
  required: ReadonlyMap<CodePreviewToolName, ToolPreviewSetting>,
): Component {
  const selected = new Set(tools);
  const statuses = getCodePreviewToolStatuses();
  const summary = () => enabledToolsSummary(selected, statuses, required);
  return createSettingsGroupSubmenu({
    title: ENABLED_TOOLS_LABEL,
    description: "Changes apply after /reload.",
    items: () => createToolToggleItems(selected, statuses, required),
    onChange: (id, value) => {
      const tool = parseToolToggleId(id);
      if (!tool || required.has(tool)) return;
      if (value === "on") selected.add(tool);
      else selected.delete(tool);
    },
    done,
    summary,
    listTheme: theme ? managerSettingsTheme(theme) : getSettingsListTheme(),
  });
}

export const ENABLED_TOOLS_LABEL = "Enabled tools";

/** Whether a tool's preview is in effect: owned elsewhere it's off, and needed by a setting it's on. */
function toolPreviewInEffect(
  tool: CodePreviewToolName,
  enabledTools: ReadonlySet<CodePreviewToolName>,
  statuses: ReadonlyMap<CodePreviewToolName, CodePreviewToolStatus>,
  required: ReadonlyMap<CodePreviewToolName, ToolPreviewSetting>,
): boolean {
  if (statuses.get(tool)?.state === "skipped-conflict") return false;
  return required.has(tool) || enabledTools.has(tool);
}

/** The `Enabled tools` value: how many tool previews are in effect, as the list shows them. */
export function enabledToolsSummary(
  enabledTools: ReadonlySet<CodePreviewToolName>,
  statuses: ReadonlyMap<CodePreviewToolName, CodePreviewToolStatus>,
  required: ReadonlyMap<CodePreviewToolName, ToolPreviewSetting>,
): string {
  const total = ALL_CODE_PREVIEW_TOOLS.length;
  const count = Arr.filter(ALL_CODE_PREVIEW_TOOLS, (tool) =>
    toolPreviewInEffect(tool, enabledTools, statuses, required),
  ).length;
  return count === 0 ? "none" : count === total ? "all" : `${count} of ${total}`;
}

/** What turning a tool's preview on draws, shown as its toggle's description. */
const TOOL_PREVIEW_PURPOSES = {
  bash: "Draws bash calls with the highlighted command and its output.",
  read: "Draws read calls with syntax-highlighted file content.",
  write: "Draws write calls with the new content or its diff.",
  edit: "Draws edit calls as diffs of the proposed changes.",
  grep: "Draws grep calls with their matches.",
  find: "Draws find calls as lists of paths.",
  ls: "Draws ls calls as lists of entries.",
  codemode: "Draws codemode programs with their source and the tools each one called.",
  tool_search: "Draws tool_search calls with the tools they list.",
} as const satisfies Record<CodePreviewToolName, string>;

function createToolToggleItems(
  enabledTools: ReadonlySet<CodePreviewToolName>,
  statuses: Map<CodePreviewToolName, CodePreviewToolStatus>,
  required: ReadonlyMap<CodePreviewToolName, ToolPreviewSetting>,
): SettingItem[] {
  return Arr.map(ALL_CODE_PREVIEW_TOOLS, (tool) => {
    const id = toolToggleId(tool);
    const status = statuses.get(tool);
    if (status?.state === "skipped-conflict") {
      const owner = formatToolOwner(status.owner);
      return {
        id,
        label: tool,
        description: `${owner} owns this tool, so its preview stays off.`,
        currentValue: `off (${owner})`,
      };
    }
    const setting = required.get(tool);
    if (setting !== undefined) {
      const reason = SETTING_ITEM_DEFINITIONS[setting].label;
      return {
        id,
        label: tool,
        description: `Stays on so collapsed ${tool} output can be hidden. Turn ${reason} on to change this.`,
        currentValue: `on (needed: ${reason} off)`,
      };
    }
    const description = Match.value(status?.state).pipe(
      Match.when("registration-error", () => "Write hook registration failed; retry with /reload."),
      Match.when("unavailable", () => "Tool is not available; previews never enable it."),
      Match.orElse(() => TOOL_PREVIEW_PURPOSES[tool]),
    );
    return {
      id,
      label: tool,
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
