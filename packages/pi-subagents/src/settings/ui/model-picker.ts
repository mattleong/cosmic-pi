import type { Api, Model } from "@earendil-works/pi-ai";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai/compat";
import { DynamicBorder, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { fuzzyFilter, Input, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import type { ModelPolicy } from "../../config/options.ts";
import type { ProfileCandidateEffort, ProfileId } from "../../profiles/model.ts";
import { CLAUDE_CLI_ALIAS_MODELS } from "../../run/model-catalog.ts";
import type { SubagentEffort } from "../../run/model.ts";

export type ProfileModelChoice =
  | { readonly kind: "model"; readonly selector: string; readonly policy: ModelPolicy }
  | { readonly kind: "parent"; readonly policy: ModelPolicy }
  | { readonly kind: "disabled" }
  | { readonly kind: "inherit" };

export interface ProfileModelPickerChoice {
  readonly choice: ProfileModelChoice;
  readonly item: SelectItem;
  readonly searchText: string;
  readonly supportedEfforts?: ReadonlyArray<SubagentEffort> | undefined;
}

const choiceValue = (choice: ProfileModelChoice): string =>
  choice.kind === "model" ? choice.selector : choice.kind;

export function createProfileModelChoices(input: {
  readonly models: readonly Model<Api>[];
  readonly parentModel?: Model<Api> | undefined;
  readonly currentSelector?: string | undefined;
  readonly projectScope: boolean;
  readonly policyFor: (backend: "pi" | "claude-cli", model: string) => ModelPolicy;
}): ProfileModelPickerChoice[] {
  const result: ProfileModelPickerChoice[] = [];
  if (input.projectScope)
    result.push({
      choice: { kind: "inherit" },
      item: {
        value: "inherit",
        label: `Inherit global${input.currentSelector === "inherit" ? " (current)" : ""}`,
      },
      searchText: "inherit global",
    });
  if (input.parentModel) {
    const canonical = `${input.parentModel.provider}/${input.parentModel.id}`;
    const policy = input.policyFor("pi", canonical);
    if (policy !== "denied") {
      const efforts = getSupportedThinkingLevels(
        input.parentModel,
      ) as ReadonlyArray<SubagentEffort>;
      result.push({
        choice: { kind: "parent", policy },
        item: {
          value: "parent",
          label: `Parent model${input.currentSelector === "parent" ? " (current)" : ""}`,
          description: `${canonical} · ${input.parentModel.reasoning ? "reasoning" : "no reasoning"} · efforts: ${efforts.join(", ") || "none"}${policy === "discouraged" ? " · discouraged" : ""}`,
        },
        searchText: `parent ${canonical} ${input.parentModel.name ?? ""}`,
        supportedEfforts: efforts,
      });
    }
  }
  for (const model of input.models) {
    const canonical = `${model.provider}/${model.id}`;
    const policy = input.policyFor("pi", canonical);
    if (policy === "denied") continue;
    const selector = `pi/${canonical}`;
    const efforts = getSupportedThinkingLevels(model) as ReadonlyArray<SubagentEffort>;
    result.push({
      choice: { kind: "model", selector, policy },
      item: {
        value: selector,
        label: `${canonical}${input.currentSelector === selector ? " (current)" : ""}`,
        description: `${model.name && model.name !== model.id ? `${model.name} · ` : ""}${model.reasoning ? "reasoning" : "no reasoning"} · efforts: ${efforts.join(", ") || "none"}${policy === "discouraged" ? " · discouraged" : ""}`,
      },
      searchText: `${canonical} ${model.name ?? ""}`,
      supportedEfforts: efforts,
    });
  }
  const claudeSelectors = new Set(
    input.currentSelector?.startsWith("claude-cli/")
      ? [
          ...CLAUDE_CLI_ALIAS_MODELS.map((model) => model.id),
          input.currentSelector.slice("claude-cli/".length),
        ]
      : CLAUDE_CLI_ALIAS_MODELS.map((model) => model.id),
  );
  for (const id of claudeSelectors) {
    const policy = input.policyFor("claude-cli", id);
    if (policy === "denied") continue;
    const selector = `claude-cli/${id}`;
    result.push({
      choice: { kind: "model", selector, policy },
      item: {
        value: selector,
        label: `${selector}${input.currentSelector === selector ? " (current)" : ""}`,
        description: `reasoning · efforts: low, medium, high, xhigh, max · requires a trusted project · launch readiness checked only when starting${policy === "discouraged" ? " · discouraged" : ""}`,
      },
      searchText: `${selector} claude cli`,
      supportedEfforts: ["low", "medium", "high", "xhigh", "max"],
    });
  }
  result.push({
    choice: { kind: "disabled" },
    item: {
      value: "disabled",
      label: `Disabled${input.currentSelector === "disabled" ? " (current)" : ""}`,
    },
    searchText: "disabled off",
  });
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
  readonly scope: "global" | "project";
  readonly path: string;
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
              theme.fg("accent", theme.bold(`Profile: ${pickerContext.profile} · Select model`)),
              1,
              0,
            ).render(width),
            ...new Text(
              theme.fg(
                "dim",
                `Scope: ${pickerContext.scope === "global" ? "Global" : "Project"} · ${pickerContext.path}`,
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
              theme.fg("dim", "Type to search · ↑↓ navigate · enter select · esc back to profiles"),
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
