import type { Theme } from "@earendil-works/pi-coding-agent";
import {
  Key,
  matchesKey,
  type Component,
  type Focusable,
  type SelectItem,
} from "@earendil-works/pi-tui";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { managerTone } from "./style.ts";
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
  /** Unavailable rows remain visible and searchable but cannot be selected. */
  readonly available?: boolean | undefined;
  readonly unavailableReason?: string | undefined;
  /** Optional complete presentation overrides; callers retain domain-specific model metadata. */
  readonly label?: string | undefined;
  readonly description?: string | undefined;
  readonly searchText?: string | undefined;
}

type ModelPickerScope = "scoped" | "all";

export const modelSelector = (
  model: Pick<ModelPickerModel, "provider" | "id" | "selector">,
): string => model.selector ?? `${model.provider}/${model.id}`;

export const boundedMiddle = (value: string, maximum: number): string => {
  const characters = [...value];
  if (characters.length <= maximum) return value;
  const left = Math.max(1, Math.floor((maximum - 1) / 2));
  return `${characters.slice(0, left).join("")}…${characters.slice(characters.length - (maximum - left - 1)).join("")}`;
};

const modelItem = <M extends ModelPickerModel>(model: M, current?: string): SelectItem => {
  const selector = sanitizeTerminalLine(modelSelector(model));
  const unavailable = model.available === false;
  const status = `${current === selector ? " (current)" : ""}${unavailable ? " (unavailable)" : ""}`;
  const unavailableReason = unavailable
    ? sanitizeTerminalLine(model.unavailableReason ?? "Model is unavailable")
    : undefined;
  if (model.label) {
    const label = sanitizeTerminalLine(model.label);
    const base = {
      value: selector,
      label: `${label}${unavailable && !/\bunavailable\b/i.test(label) ? " (unavailable)" : ""}`,
    };
    const description = unavailableReason ?? model.description;
    return description ? { ...base, description: sanitizeTerminalLine(description) } : base;
  }
  const efforts = model.supportedEfforts?.map(sanitizeTerminalLine).join(", ") || "default";
  const name =
    model.name && model.name !== model.id
      ? `${boundedMiddle(sanitizeTerminalLine(model.name), 48)} · `
      : "";
  return {
    value: selector,
    label: `${boundedMiddle(selector, 88)}${status}`,
    description:
      unavailableReason ??
      `${name}${model.reasoning ? "supports reasoning" : "no reasoning"} · reasoning levels: ${efforts}`,
  };
};

/** Projects already-authorized model data into terminal-safe searchable choices. */
export const createModelPickerChoices = <M extends ModelPickerModel>(
  models: ReadonlyArray<M>,
  current?: string,
): Array<SearchableSelectPageChoice<M>> =>
  models.map((model) => {
    const item = modelItem(model, current);
    return {
      value: item.value,
      item,
      searchText: sanitizeTerminalLine(model.searchText ?? `${item.value} ${model.name ?? ""}`),
      payload: model,
      tone: managerTone.value,
      enabled: model.available !== false,
      // An unavailable row is described by its sanitized reason, which a label may omit if blank.
      disabledReason: model.available === false ? (item.description ?? "") : undefined,
    };
  });

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
  /** Start ready to type; Escape cancels directly instead of leaving search first. */
  readonly initialSearchMode?: boolean | undefined;
  readonly current?: string | undefined;
  readonly notice?: string | undefined;
  readonly select: (model: M) => void;
  readonly cancel: () => void;
}

/**
 * Pi-native model selector over the generic searchable page. The caller owns model discovery,
 * authorization, compatibility policy, validation, persistence, and lifecycle.
 */
export class ModelPickerPage<M extends ModelPickerModel> implements Component, Focusable {
  private readonly options: ModelPickerPageOptions<M>;
  private readonly canScope: boolean;
  private scope: ModelPickerScope;
  private page: SearchableSelectPage<M>;
  private _focused = false;

  constructor(options: ModelPickerPageOptions<M>) {
    this.options = options;
    this.canScope = Boolean(options.allModels && options.scopedModels.length > 0);
    this.scope = this.canScope ? (options.initialScope ?? "scoped") : "all";
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
    if (!this.canScope) return this.options.subtitle ?? "";
    const base = this.options.subtitle ? `${this.options.subtitle} · ` : "";
    return `${base}${this.scope === "scoped" ? "Scoped models" : "All authenticated models"} · Tab switch`;
  }

  private buildPage(
    selected: string | undefined,
    search?: { readonly query: string; readonly active: boolean },
  ): SearchableSelectPage<M> {
    return new SearchableSelectPage({
      theme: this.options.theme,
      breadcrumb: this.options.breadcrumb ?? "/models",
      title: this.options.title ?? "Choose model",
      subtitle: this.scopeSubtitle(),
      choices: createModelPickerChoices(this.models(), this.options.current),
      current: selected ?? this.options.current,
      notice: this.options.notice,
      emptyText: "No matching models",
      initialQuery: search?.query,
      initialSearchMode: search?.active ?? this.options.initialSearchMode,
      cancelBehavior: this.options.initialSearchMode ? "close" : "clear-search",
      getHeight: this.options.getHeight,
      requestRender: this.options.requestRender,
      matchesKeybinding: this.options.matchesKeybinding,
      keybindingLabel: this.options.keybindingLabel,
      select: (model) => this.options.select(model),
      cancel: this.options.cancel,
    });
  }

  handleInput(data: string): void {
    if (this.canScope && (matchesKey(data, Key.tab) || matchesKey(data, Key.shift("tab")))) {
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
