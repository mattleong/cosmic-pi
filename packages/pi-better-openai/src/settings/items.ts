import type { ResolvedConfig, SettingsOptionDescriptor } from "../config.ts";

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

export type SettingsItemOverrides = Record<
  string,
  Partial<Pick<SettingsPickerItem, "currentValue" | "description" | "values">>
>;

export function settingsItemsFromDescriptors(
  descriptors: readonly SettingsOptionDescriptor[],
  cfg: ResolvedConfig,
  overrides: SettingsItemOverrides = {},
): SettingsPickerItem[] {
  return descriptors.map((descriptor) => {
    const override = overrides[descriptor.id] ?? {};
    const values = override.values ?? descriptor.values;
    return {
      id: descriptor.id,
      label: descriptor.label,
      currentValue: override.currentValue ?? descriptor.currentValue(cfg),
      values: values ? [...values] : undefined,
      description: override.description ?? descriptor.description,
    };
  });
}
