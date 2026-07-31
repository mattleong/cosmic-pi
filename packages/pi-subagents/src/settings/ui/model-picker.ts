import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ProfileCandidateEffort, ProfileId } from "../../profiles/model.ts";
import type { SubagentEffort, SubagentHost } from "../../run/model.ts";

export type ProfileModelChoice =
  | { readonly kind: "model"; readonly selector: string }
  | { readonly kind: "parent" };

export interface ProfileModelPickerChoice {
  readonly choice: ProfileModelChoice;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
}

const choiceValue = (choice: ProfileModelChoice): string =>
  choice.kind === "model" ? choice.selector : "parent";

const boundedMiddle = (value: string, maximum: number): string => {
  if (value.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${value.slice(0, left)}…${value.slice(value.length - (maximum - left - 1))}`;
};

/** Authenticated canonical Pi models, plus local Pi's special parent selector. */
export function createProfileModelChoices(input: {
  readonly models: readonly Model<Api>[];
  readonly parentModel?: Model<Api> | undefined;
  readonly currentSelector?: string | undefined;
  readonly allowParent: boolean;
}): ProfileModelPickerChoice[] {
  const result: ProfileModelPickerChoice[] = [];
  if (input.allowParent) {
    const canonical = input.parentModel
      ? `${input.parentModel.provider}/${input.parentModel.id}`
      : undefined;
    const efforts = input.parentModel
      ? (getSupportedThinkingLevels(input.parentModel) as ReadonlyArray<SubagentEffort>)
      : undefined;
    result.push({
      choice: { kind: "parent" },
      item: {
        value: "parent",
        label: `Parent model${input.currentSelector === "parent" ? " (current)" : ""}`,
        description: canonical
          ? `${boundedMiddle(canonical, 72)} · ${input.parentModel?.reasoning ? "reasoning" : "no reasoning"} · efforts: ${efforts?.join(", ") || "none"}`
          : "Uses the active parent model at launch",
      },
      searchText: `parent ${canonical ?? "active model"} ${input.parentModel?.name ?? ""}`,
      ...(efforts === undefined ? {} : { supportedEfforts: efforts }),
    });
  }
  for (const model of input.models) {
    const canonical = `${model.provider}/${model.id}`;
    const efforts = getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>;
    result.push({
      choice: { kind: "model", selector: canonical },
      item: {
        value: canonical,
        label: `${boundedMiddle(canonical, 88)}${input.currentSelector === canonical ? " (current)" : ""}`,
        description: `${model.name && model.name !== model.id ? `${boundedMiddle(model.name, 48)} · ` : ""}${model.reasoning ? "reasoning" : "no reasoning"} · efforts: ${efforts.join(", ") || "none"}`,
      },
      searchText: `${canonical} ${model.name ?? ""}`,
      supportedEfforts: efforts,
    });
  }
  return result;
}

const buildList = (
  choices: ReadonlyArray<ProfileModelPickerChoice>,
  query: string,
  current: string | undefined,
  theme: ConstructorParameters<typeof SelectList>[2],
  done: (value: string | null) => void,
): SelectList => {
  const filtered = fuzzyFilter([...choices], query, (choice) => choice.searchText);
  const list = new SelectList(
    filtered.map((choice) => choice.item),
    12,
    theme,
  );
  if (!query && current) {
    const index = filtered.findIndex((choice) => choiceValue(choice.choice) === current);
    if (index >= 0) list.setSelectedIndex(index);
  }
  list.onSelect = (item) => done(item.value);
  list.onCancel = () => done(null);
  return list;
};

export interface ProfileModelPickerContext {
  readonly profile: ProfileId;
  readonly candidateIndex: number;
  readonly host: SubagentHost;
}

export function selectProfileModel(
  ctx: ExtensionCommandContext,
  choices: ReadonlyArray<ProfileModelPickerChoice>,
  current: string | undefined,
  pickerContext: ProfileModelPickerContext,
): Promise<ProfileModelChoice | undefined> {
  return ctx.ui
    .custom<string | null>((tui, theme, keybindings, done) => {
      const input = new Input();
      const top = new DynamicBorder((text: string) => theme.fg("accent", text));
      const bottom = new DynamicBorder((text: string) => theme.fg("accent", text));
      let query = "";
      const listTheme = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (_text: string) => theme.fg("warning", "  No matching models"),
      };
      let list = buildList(choices, query, current, listTheme, done);
      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width: number) {
          return [
            ...top.render(width),
            ...new Text(
              theme.fg(
                "accent",
                theme.bold(
                  `Profile: ${pickerContext.profile} · Candidate ${pickerContext.candidateIndex + 1} · Pi model`,
                ),
              ),
              1,
              0,
            ).render(width),
            ...new Text(
              theme.fg(
                "dim",
                `${pickerContext.host === "local" ? "Local" : "Herdr"} Pi · authenticated canonical models${pickerContext.host === "local" ? " · parent allowed" : ""}`,
              ),
              1,
              0,
            ).render(width),
            ...new Text(theme.fg("dim", "Search models:"), 1, 0).render(width),
            ...input.render(width),
            "",
            ...list.render(width),
            "",
            ...new Text(
              theme.fg(
                "dim",
                "Type to search · ↑↓ navigate · enter select · esc back to candidate",
              ),
              1,
              0,
            ).render(width),
            ...bottom.render(width),
          ];
        },
        invalidate() {
          top.invalidate();
          bottom.invalidate();
          input.invalidate();
          list.invalidate();
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down") ||
            keybindings.matches(data, "tui.select.confirm") ||
            keybindings.matches(data, "tui.select.cancel")
          )
            list.handleInput(data);
          else {
            input.handleInput(data);
            const next = input.getValue();
            if (next !== query) {
              query = next;
              list = buildList(choices, query, current, listTheme, done);
            }
          }
          tui.requestRender();
        },
      };
    })
    .then((selected) => choices.find((choice) => choice.item.value === selected)?.choice);
}

export const effortPickerOptions = (
  supported: ReadonlyArray<SubagentEffort>,
): ReadonlyArray<{ readonly label: string; readonly effort: ProfileCandidateEffort }> => [
  { label: "Profile default", effort: "default" },
  ...supported.map((effort) => ({ label: effort, effort })),
];
