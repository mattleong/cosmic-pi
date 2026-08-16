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
  return descriptors.map((descriptor) =>
    (() => {
      const objectPart595_0 = {
        id: descriptor.id,
        label: descriptor.label,
        currentValue: descriptor.currentValue(cfg),
      };
      const objectPart595_1 = descriptor.values
        ? { ...objectPart595_0, values: [...descriptor.values] }
        : objectPart595_0;
      const objectPart595_2 = { ...objectPart595_1, description: descriptor.description };
      return objectPart595_2;
    })(),
  );
}
