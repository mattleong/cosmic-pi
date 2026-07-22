import type { ResolvedConfig, SettingsOptionDescriptor } from "../config/index.ts";

export type SettingsPickerItem = {
  id: string;
  label: string;
  description?: string;
  currentValue: string;
  values?: string[];
  submenu?: (
    currentValue: string,
    done: (selectedValue?: string) => void,
  ) => { render(width: number): string[]; invalidate(): void; handleInput?(data: string): void };
};

export function settingsItemsFromDescriptors(
  descriptors: readonly SettingsOptionDescriptor[],
  cfg: ResolvedConfig,
): SettingsPickerItem[] {
  return descriptors.map((descriptor) => ({
    id: descriptor.id,
    label: descriptor.label,
    currentValue: descriptor.currentValue(cfg),
    ...(descriptor.values ? { values: [...descriptor.values] } : {}),
    description: descriptor.description,
  }));
}
