import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import { supportsFastModel } from "pi-better-openai/fast-models";
import { safeAdvisorLabel } from "../domain/label.ts";
import type { ResolvedAdvisorConfig } from "./resolve.ts";

export const CLEAR_MODEL_OPTION = "Clear advisor model";

export interface AdvisorModelChoice {
  item: SelectItem;
  searchText: string;
  rawValue: string;
}

export function createAdvisorModelChoices(
  models: readonly Model<Api>[],
  config: Pick<ResolvedAdvisorConfig, "provider" | "model">,
): AdvisorModelChoice[] {
  const currentValue =
    config.provider && config.model ? `${config.provider}/${config.model}` : undefined;
  return models.map((model) => {
    const rawValue = `${model.provider}/${model.id}`;
    const safeValue = `${safeAdvisorLabel(model.provider) ?? "provider"}/${safeAdvisorLabel(model.id) ?? "model"}`;
    const levels = getSupportedThinkingLevels(model).join(", ");
    const name = model.name && model.name !== model.id ? safeAdvisorLabel(model.name) : undefined;
    return {
      item: {
        value: rawValue,
        label: rawValue === currentValue ? `${safeValue} (current)` : safeValue,
        description: `${name ? `${name} · ` : ""}reasoning: ${levels}${supportsFastModel(model.provider, model.id) ? " · fast mode available" : ""}`,
      } satisfies SelectItem,
      searchText: `${safeValue} ${name ?? ""}`,
      rawValue,
    };
  });
}

export function selectAdvisorModel(
  ctx: ExtensionCommandContext,
  models: readonly Model<Api>[],
  config: Pick<ResolvedAdvisorConfig, "provider" | "model">,
): Promise<string | undefined> {
  const choices = createAdvisorModelChoices(models, config);
  if (ctx.mode !== "tui" || typeof ctx.ui.custom !== "function") {
    const labels = [...choices.map((choice) => choice.item.label), CLEAR_MODEL_OPTION];
    return ctx.ui
      .select("Dedicated advisor model", labels)
      .then((selected) =>
        selected === CLEAR_MODEL_OPTION
          ? CLEAR_MODEL_OPTION
          : choices.find((choice) => choice.item.label === selected)?.rawValue,
      );
  }

  const currentValue =
    config.provider && config.model ? `${config.provider}/${config.model}` : undefined;
  const tuiChoices: Array<{ item: SelectItem; searchText: string }> = choices.map(
    ({ item, searchText }) => ({ item, searchText }),
  );
  tuiChoices.push({
    item: { value: CLEAR_MODEL_OPTION, label: CLEAR_MODEL_OPTION },
    searchText: CLEAR_MODEL_OPTION,
  });

  return ctx.ui
    .custom<string | null>((tui, theme, keybindings, done) => {
      const input = new Input();
      const topBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
      const bottomBorder = new DynamicBorder((text: string) => theme.fg("accent", text));
      let title: Text;
      let searchLabel: Text;
      let hint: Text;
      const rebuildThemedText = () => {
        title = new Text(theme.fg("accent", theme.bold("Select Advisor Model")), 1, 0);
        searchLabel = new Text(theme.fg("dim", "Search models:"), 1, 0);
        hint = new Text(
          theme.fg("dim", "Type to search · ↑↓ navigate · enter select · esc cancel"),
          1,
          0,
        );
      };
      rebuildThemedText();
      const listTheme = {
        selectedPrefix: (text: string) => theme.fg("accent", text),
        selectedText: (text: string) => theme.fg("accent", text),
        description: (text: string) => theme.fg("muted", text),
        scrollInfo: (text: string) => theme.fg("dim", text),
        noMatch: (_text: string) => theme.fg("warning", "  No matching models"),
      };
      let query = "";
      let selectList = buildModelSelectList(tuiChoices, query, currentValue, listTheme, done);

      return {
        get focused() {
          return input.focused;
        },
        set focused(value: boolean) {
          input.focused = value;
        },
        render(width: number) {
          return [
            ...topBorder.render(width),
            ...title.render(width),
            ...searchLabel.render(width),
            ...input.render(width),
            "",
            ...selectList.render(width),
            "",
            ...hint.render(width),
            ...bottomBorder.render(width),
          ];
        },
        invalidate() {
          topBorder.invalidate();
          bottomBorder.invalidate();
          input.invalidate();
          selectList.invalidate();
          rebuildThemedText();
        },
        handleInput(data: string) {
          if (
            keybindings.matches(data, "tui.select.up") ||
            keybindings.matches(data, "tui.select.down") ||
            keybindings.matches(data, "tui.select.confirm") ||
            keybindings.matches(data, "tui.select.cancel")
          ) {
            selectList.handleInput(data);
          } else {
            input.handleInput(data);
            const nextQuery = input.getValue();
            if (nextQuery !== query) {
              query = nextQuery;
              selectList = buildModelSelectList(tuiChoices, query, currentValue, listTheme, done);
            }
          }
          tui.requestRender();
        },
      };
    })
    .then((value) => value ?? undefined);
}

export function buildModelSelectList(
  choices: Array<{ item: SelectItem; searchText: string }>,
  query: string,
  currentValue: string | undefined,
  theme: ConstructorParameters<typeof SelectList>[2],
  done: (value: string | null) => void,
): SelectList {
  const filtered = fuzzyFilter(choices, query, (choice) => choice.searchText);
  const selectList = new SelectList(
    filtered.map((choice) => choice.item),
    10,
    theme,
  );
  if (!query && currentValue) {
    const currentIndex = filtered.findIndex((choice) => choice.item.value === currentValue);
    if (currentIndex >= 0) selectList.setSelectedIndex(currentIndex);
  }
  selectList.onSelect = (item) => done(item.value);
  selectList.onCancel = () => done(null);
  return selectList;
}
