import type { ResolvedConfig, SettingsOptionDescriptor } from "../config.ts";
import {
  type CodexPetPackage,
  codexHome,
  findCodexPet,
  formatNoReadyCodexPetsMessage,
} from "../pets.ts";

export const PET_EMPTY_VALUE = "not selected";

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

export function readyPetPickerValues(pets: CodexPetPackage[]): string[] | undefined {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  return readyPets.length > 0 ? readyPets.map((pet) => pet.slug) : undefined;
}

export function petConfigPickerValue(cfg: ResolvedConfig): string {
  return cfg.pets.slug || PET_EMPTY_VALUE;
}

export function petSlugFromPickerValue(value: string): string {
  return value === PET_EMPTY_VALUE ? "" : value;
}

function findPickerPet(value: string, pets: CodexPetPackage[]): CodexPetPackage | undefined {
  return findCodexPet(
    pets.filter((pet) => pet.hasSpritesheet),
    value,
  );
}

export function petPickerDescription(cfg: ResolvedConfig, pets: CodexPetPackage[]): string {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  if (readyPets.length === 0)
    return "No ready custom pets found. Use /pets help to create one, then return here.";
  if (!cfg.pets.slug) {
    const firstPet = readyPets[0]!;
    const lastPet = readyPets[readyPets.length - 1]!;
    return `No pet selected. Enter/Space/→ selects ${firstPet.name}; ← selects ${lastPet.name}.`;
  }
  const selectedPet = findPickerPet(cfg.pets.slug, readyPets);
  const selected = selectedPet
    ? `Selected: ${selectedPet.name} (${selectedPet.slug})`
    : `Selected: ${cfg.pets.slug}`;
  return `${selected}. Enter/Space/→ cycles pets; ← cycles back. Preview appears in the footer while this menu is open.`;
}

export function formatPetSelectPrompt(
  pets: CodexPetPackage[],
  home = codexHome(),
): { message: string; level: "info" | "warning" } {
  const readyPets = pets.filter((pet) => pet.hasSpritesheet);
  if (readyPets.length === 0) {
    return { message: formatNoReadyCodexPetsMessage(pets, home), level: "warning" };
  }

  const brokenPets = pets.filter((pet) => !pet.hasSpritesheet);
  const lines = [
    "Choose one with /pets select <slug>:",
    ...readyPets.map((pet) => `- ${pet.slug} (${pet.name})`),
  ];
  if (brokenPets.length > 0) {
    lines.push(
      "",
      "Not ready:",
      ...brokenPets.map(
        (pet) =>
          `- ${pet.slug} (${pet.name}) — ${pet.spritesheetIssue ?? `missing ${pet.spritesheetPath}`}`,
      ),
    );
  }
  return { message: lines.join("\n"), level: "info" };
}
