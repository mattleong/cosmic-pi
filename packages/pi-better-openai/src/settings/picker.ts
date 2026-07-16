import { getSettingsListTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Key, matchesKey } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "../format.ts";
import { isTerminalImageLine } from "../footer-layout.ts";
import type { SettingsPickerItem } from "./items.ts";

export function textPanel(title: string, lines: string[], done: () => void) {
  return {
    render(width: number) {
      const clipped = lines.map((line) => truncateToWidth(line, width, "..."));
      return [title, "", ...clipped, "", "Esc/q to go back"];
    },
    invalidate() {},
    handleInput(data: string) {
      if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c")) || data === "q") done();
    },
  };
}

export function createSettingsSubmenu(
  title: string,
  items: () => SettingsPickerItem[],
  ctx: ExtensionContext,
  done: () => void,
  writeSetting: (ctx: ExtensionContext, id: string, value: string) => void,
  options?: {
    onSelection?: (item: SettingsPickerItem | undefined) => void;
    onClose?: () => void;
    renderExtra?: (width: number) => string[];
  },
) {
  const theme = getSettingsListTheme();
  let selectedIndex = 0;
  let searchQuery = "";
  let closed = false;
  let submenuComponent: ReturnType<NonNullable<SettingsPickerItem["submenu"]>> | undefined;
  let submenuItemIndex: number | undefined;

  function currentItems(): SettingsPickerItem[] {
    const allItems = items();
    const query = searchQuery.trim().toLowerCase();
    const current = query
      ? allItems.filter((item) => item.label.toLowerCase().includes(query))
      : allItems;
    selectedIndex = Math.max(0, Math.min(selectedIndex, Math.max(0, current.length - 1)));
    return current;
  }
  function selectedItem(): SettingsPickerItem | undefined {
    return currentItems()[selectedIndex];
  }
  function close(): void {
    closed = true;
    options?.onClose?.();
    done();
  }
  function closeNestedSubmenu(): void {
    submenuComponent = undefined;
    if (submenuItemIndex !== undefined) selectedIndex = submenuItemIndex;
    submenuItemIndex = undefined;
    options?.onSelection?.(selectedItem());
  }
  function cycleSelected(direction: 1 | -1 = 1): void {
    const item = selectedItem();
    if (!item?.values?.length) return;
    const currentIndex = item.values.indexOf(item.currentValue);
    const startIndex = currentIndex === -1 ? (direction === 1 ? -1 : 0) : currentIndex;
    const newValue =
      item.values[(startIndex + direction + item.values.length) % item.values.length] ??
      item.currentValue;
    writeSetting(ctx, item.id, newValue);
    options?.onSelection?.(selectedItem());
  }
  function activateSelected(): void {
    const item = selectedItem();
    if (!item) return;
    if (item.submenu) {
      submenuItemIndex = selectedIndex;
      submenuComponent = item.submenu(item.currentValue, (selectedValue?: string) => {
        if (selectedValue !== undefined) writeSetting(ctx, item.id, selectedValue);
        closeNestedSubmenu();
      });
      return;
    }
    cycleSelected(1);
  }

  return {
    render(width: number) {
      if (submenuComponent) return submenuComponent.render(width);
      const current = currentItems();
      const selected = selectedItem();
      if (!closed) options?.onSelection?.(selected);
      const lines = [title, "", `> ${searchQuery}`, ""];
      const maxVisible = 8;
      const startIndex = Math.max(
        0,
        Math.min(selectedIndex - Math.floor(maxVisible / 2), current.length - maxVisible),
      );
      const visible = current.slice(startIndex, startIndex + maxVisible);
      if (current.length === 0) {
        lines.push(theme.hint("  No matching settings"));
        lines.push("", theme.hint("  Type to search · Esc to go back"));
        return lines;
      }
      const maxLabelWidth = Math.min(
        30,
        Math.max(1, ...current.map((item) => visibleWidth(item.label))),
      );
      for (let i = 0; i < visible.length; i++) {
        const item = visible[i];
        if (!item) continue;
        const itemIndex = startIndex + i;
        const isSelected = itemIndex === selectedIndex;
        const prefix = isSelected ? theme.cursor : "  ";
        const labelPadded =
          item.label + " ".repeat(Math.max(0, maxLabelWidth - visibleWidth(item.label)));
        const valueMaxWidth = Math.max(1, width - visibleWidth(prefix) - maxLabelWidth - 4);
        lines.push(
          truncateToWidth(
            prefix +
              theme.label(labelPadded, isSelected) +
              "  " +
              theme.value(truncateToWidth(item.currentValue, valueMaxWidth, ""), isSelected),
            width,
          ),
        );
      }
      if (selected?.description) {
        lines.push("", theme.description(`  ${truncateToWidth(selected.description, width - 4)}`));
      }
      const extraLines = options?.renderExtra?.(width) ?? [];
      if (extraLines.length > 0) {
        lines.push("");
        for (const line of extraLines) {
          lines.push(isTerminalImageLine(line) ? line : truncateToWidth(line, width, "..."));
        }
      }
      lines.push(
        "",
        theme.hint("  Type to search · ↑↓ navigate · ←→/Enter/Space to change · Esc to go back"),
      );
      return lines;
    },
    invalidate() {
      submenuComponent?.invalidate();
    },
    handleInput(data: string) {
      if (submenuComponent) {
        submenuComponent.handleInput?.(data);
        return;
      }
      const current = currentItems();
      if (current.length === 0) {
        if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) close();
        else if (matchesKey(data, Key.backspace)) searchQuery = searchQuery.slice(0, -1);
        else if (data.length === 1 && data >= "!" && data <= "~") searchQuery += data;
        return;
      }
      if (matchesKey(data, Key.up))
        selectedIndex = selectedIndex === 0 ? current.length - 1 : selectedIndex - 1;
      else if (matchesKey(data, Key.down))
        selectedIndex = selectedIndex === current.length - 1 ? 0 : selectedIndex + 1;
      else if (
        matchesKey(data, Key.right) ||
        matchesKey(data, Key.enter) ||
        matchesKey(data, Key.space) ||
        data === " "
      )
        activateSelected();
      else if (matchesKey(data, Key.left)) cycleSelected(-1);
      else if (matchesKey(data, Key.escape) || matchesKey(data, Key.ctrl("c"))) close();
      else if (matchesKey(data, Key.backspace)) {
        searchQuery = searchQuery.slice(0, -1);
        selectedIndex = 0;
      } else if (data.length === 1 && data >= "!" && data <= "~") {
        searchQuery += data;
        selectedIndex = 0;
      }
      if (!closed) options?.onSelection?.(selectedItem());
    },
  };
}
