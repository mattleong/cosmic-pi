import { SettingsList, type SettingItem } from "@earendil-works/pi-tui";

/** An unstyled settings list over a panel model's items, as the settings panel mounts one. */
export const plainSettingsList = (model: { readonly items: SettingItem[] }) =>
  new SettingsList(
    model.items,
    10,
    {
      label: (text) => text,
      value: (text) => text,
      description: (text) => text,
      cursor: ">",
      hint: (text) => text,
    },
    () => undefined,
    () => undefined,
  );
