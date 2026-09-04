import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import {
  SearchableSelectPage,
  type SearchableSelectHostOptions,
  type SearchableSelectPageChoice,
} from "./searchable-select.ts";

export interface ModelPickerModel {
  readonly provider: string;
  readonly id: string;
  /** Canonical selection identity override for native runtimes and pseudo-model rows. */
  readonly selector?: string | undefined;
  readonly name?: string | undefined;
  readonly reasoning?: boolean | undefined;
  readonly supportedEfforts?: ReadonlyArray<string> | undefined;
  /** Optional complete presentation overrides; callers retain domain-specific model metadata. */
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly searchText?: string | undefined;
}

export type ModelPickerScope = "scoped" | "all";

export const modelSelector = (
  model: Pick<ModelPickerModel, "provider" | "id" | "selector">,
): string => model.selector ?? `${model.provider}/${model.id}`;

const boundedMiddle = (value: string, maximum: number): string => {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${characters.slice(0, left).join("")}…${characters.slice(characters.length - (maximum - left - 1)).join("")}`;
};

const modelItem = <M extends ModelPickerModel>(model: M, current?: string): SelectItem => {
  const selector = sanitizeTerminalLine(modelSelector(model));
  if (model.label) {
    const base = { value: selector, label: sanitizeTerminalLine(model.label) };
    return model.description
      ? { ...base, description: sanitizeTerminalLine(model.description) }
      : base;
  }
  const efforts = model.supportedEfforts?.map(sanitizeTerminalLine).join(", ") || "default";
  const name =
    model.name && model.name !== model.id
      ? `${boundedMiddle(sanitizeTerminalLine(model.name), 48)} · `
      : "";
  return {
    value: selector,
    label: `${boundedMiddle(selector, 88)}${current === selector ? " (current)" : ""}`,
    description: `${name}${model.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${efforts}`,
  };
};

/** Projects already-authorized model data into terminal-safe searchable choices. */
export const createModelPickerChoices = <M extends ModelPickerModel>(
  models: ReadonlyArray<M>,
  current?: string,
): Array<SearchableSelectPageChoice<M>> =>
  models.map((model) => {
    const selector = sanitizeTerminalLine(modelSelector(model));
    return {
      value: selector,
      item: modelItem(model, current),
      searchText: sanitizeTerminalLine(model.searchText ?? `${selector} ${model.name ?? ""}`),
      payload: model,
    };
  });

export interface ModelPickerAction {
  readonly id: string;
  readonly label: string;
  readonly description?: string | undefined;
  readonly searchText?: string | undefined;
  readonly select: () => void;
}

type ModelPickerPageEntry<M extends ModelPickerModel> =
  | { readonly _tag: "Model"; readonly model: M }
  | { readonly _tag: "Action"; readonly action: ModelPickerAction };

export interface ModelPickerPageOptions<
  M extends ModelPickerModel,
> extends SearchableSelectHostOptions {
  readonly theme: Theme;
  readonly breadcrumb?: string | undefined;
  readonly title?: string | undefined;
  readonly subtitle?: string | undefined;
  readonly scopedModels: ReadonlyArray<M>;
  readonly allModels?: ReadonlyArray<M> | undefined;
  readonly initialScope?: ModelPickerScope | undefined;
  readonly current?: string | undefined;
  readonly notice?: string | undefined;
  readonly actions?: ReadonlyArray<ModelPickerAction> | undefined;
  readonly select: (model: M) => void;
  readonly cancel: () => void;
}

/**
 * Pi-native model selector over the generic searchable page. The caller owns model discovery,
 * authorization, compatibility policy, validation, persistence, and lifecycle.
 */
export class ModelPickerPage<M extends ModelPickerModel> implements Component, Focusable {
  private readonly options: ModelPickerPageOptions<M>;
  private scope: ModelPickerScope;
  private page: SearchableSelectPage<ModelPickerPageEntry<M>>;
  private _focused = false;

  constructor(options: ModelPickerPageOptions<M>) {
    this.options = options;
    const canScope = Boolean(options.allModels && options.scopedModels.length > 0);
    this.scope = canScope ? (options.initialScope ?? "scoped") : "all";
    this.page = this.buildPage(options.current);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.page.focused = value;
  }

  get activeScope(): ModelPickerScope {
    return this.scope;
  }

  private models(): ReadonlyArray<M> {
    return this.scope === "scoped"
      ? this.options.scopedModels
      : (this.options.allModels ?? this.options.scopedModels);
  }

  private scopeSubtitle(): string {
    const base = this.options.subtitle ? `${this.options.subtitle} · ` : "";
    if (!this.options.allModels || this.options.scopedModels.length === 0) return base.slice(0, -3);
    return `${base}${this.scope === "scoped" ? "Scoped models" : "All authenticated models"} · Tab switch`;
  }

  private buildPage(
    selected: string | undefined,
    search?: { readonly query: string; readonly active: boolean },
  ): SearchableSelectPage<ModelPickerPageEntry<M>> {
    const modelChoices: Array<SearchableSelectPageChoice<ModelPickerPageEntry<M>>> =
      createModelPickerChoices(this.models(), this.options.current).map((choice) => ({
        ...choice,
        payload: { _tag: "Model", model: choice.payload },
      }));
    const actionChoices: Array<SearchableSelectPageChoice<ModelPickerPageEntry<M>>> = (
      this.options.actions ?? []
    ).map((entry) => {
      const value = `action:${entry.id}`;
      const item = {
        value,
        label: sanitizeTerminalLine(entry.label),
      };
      return {
        value,
        item: entry.description
          ? { ...item, description: sanitizeTerminalLine(entry.description) }
          : item,
        searchText: sanitizeTerminalLine(entry.searchText ?? entry.label),
        payload: { _tag: "Action", action: entry },
      };
    });
    return new SearchableSelectPage({
      theme: this.options.theme,
      breadcrumb: this.options.breadcrumb ?? "/models",
      title: this.options.title ?? "Choose model",
      subtitle: this.scopeSubtitle(),
      choices: [...modelChoices, ...actionChoices],
      current: selected ?? this.options.current,
      notice: this.options.notice,
      emptyText: "No matching models",
      initialQuery: search?.query,
      initialSearchMode: search?.active,
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (entry) => {
        if (entry._tag === "Model") this.options.select(entry.model);
        else entry.action.select();
      },
      cancel: this.options.cancel,
    });
  }

  handleInput(data: string): void {
    const canSwitch = Boolean(this.options.allModels && this.options.scopedModels.length > 0);
    if (canSwitch && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
      const selected = this.page.selectedValue;
      const search = this.page.searchState;
      this.scope = this.scope === "scoped" ? "all" : "scoped";
      this.page = this.buildPage(selected, search);
      this.page.focused = this._focused;
      this.options.requestRender();
      return;
    }
    this.page.handleInput(data);
  }

  render(width: number): string[] {
    return this.page.render(width);
  }

  invalidate(): void {
    this.page.invalidate();
  }
}

export const makeModelPickerPage = <M extends ModelPickerModel>(
  options: ModelPickerPageOptions<M>,
): ModelPickerPage<M> => new ModelPickerPage(options);
