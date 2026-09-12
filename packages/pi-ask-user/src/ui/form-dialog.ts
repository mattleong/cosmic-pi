import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  SelectList,
  matchesKey,
  truncateToWidth,
  wrapTextWithAnsi,
  type Focusable,
  type OverlayHandle,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core";
import { formContent, initialFormValues } from "../questionnaire/form-model.ts";
import type {
  ExtensionFormOwner,
  FormField,
  FormOutcome,
  FormValue,
  OwnedFormRequest,
} from "../questionnaire/form-protocol.ts";
import {
  parseFormInput,
  validateFormOutcome,
  validateFormValue,
} from "../questionnaire/form-validation.ts";
import { displayFormValue, formIntroduction, formFieldInstructions } from "./form-render.ts";

interface Options {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly request: OwnedFormRequest;
  readonly owner: ExtensionFormOwner;
  readonly done: (outcome: FormOutcome) => void;
  readonly onCollapse: () => void;
}

/** Synchronous private draft state. No answers are published to session history. */
export class OwnedFormDialog implements Focusable {
  private readonly options: Options;
  private readonly values: Map<string, FormValue>;
  private readonly editor: Editor;
  private list: SelectList;
  private fieldIndex = 0;
  private editing = false;
  private error: string | undefined;
  private overlay: OverlayHandle | undefined;
  private closed = false;
  private hidden = false;
  private textOffset = 0;
  private _focused = false;
  constructor(options: Options) {
    this.options = options;
    this.values = new Map(initialFormValues(options.request));
    const theme = this.listTheme();
    this.editor = new Editor(
      options.tui,
      { borderColor: (text) => options.theme.fg("accent", text), selectList: theme },
      { paddingX: 1 },
    );
    this.editor.onSubmit = (text) => {
      const field = this.field();
      if (!field || this.closed) return;
      const value = parseFormInput(field, text);
      this.error = value === undefined ? "Enter a valid value." : validateFormValue(field, value);
      if (!this.error && value !== undefined) {
        this.values.set(field.key, value);
        this.editing = false;
        this.advance();
      }
      this.options.tui.requestRender();
    };
    this.editor.onChange = (text) => {
      const safe = stripTerminalControls(text).slice(0, 4096);
      if (safe !== text) this.editor.setText(safe);
    };
    this.list = this.makeList();
  }
  private listTheme() {
    const theme = this.options.theme;
    return {
      selectedPrefix: (text: string) => theme.fg("accent", text),
      selectedText: (text: string) => theme.fg("accent", text),
      description: (text: string) => theme.fg("muted", text),
      scrollInfo: (text: string) => theme.fg("dim", text),
      noMatch: (text: string) => theme.fg("warning", text),
    };
  }
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.editing;
  }
  setOverlayHandle(handle: OverlayHandle): void {
    this.overlay = handle;
  }
  resume(): void {
    if (this.closed) return;
    this.hidden = false;
    this.overlay?.setHidden(false);
    this.options.tui.requestRender(true);
  }
  collapse(): void {
    if (this.closed) return;
    this.hidden = true;
    this.overlay?.setHidden(true);
    this.options.onCollapse();
  }
  dispose(): void {
    this.closed = true;
    this.editor.setText("");
    this.values.clear();
  }
  private fields(): readonly FormField[] {
    return this.options.request.kind === "form" ? this.options.request.fields : [];
  }
  private field(): FormField | undefined {
    return this.fields()[this.fieldIndex];
  }
  private advance(): void {
    this.fieldIndex = Math.min(this.fields().length, this.fieldIndex + 1);
    this.error = undefined;
    this.list = this.makeList();
  }
  private finish(action: "accept" | "decline" | "cancel"): void {
    if (this.closed) return;
    const outcome = validateFormOutcome(
      this.options.request,
      action === "accept"
        ? this.options.request.kind === "url"
          ? { action }
          : { action, content: formContent(this.values) }
        : { action },
    );
    if (!outcome) {
      this.error = "Review required fields and their allowed values.";
      return;
    }
    this.closed = true;
    this.options.done(outcome);
  }
  private makeList(selected = 0): SelectList {
    const field = this.field();
    const items: SelectItem[] = [];
    if (field) {
      if (field.type === "boolean")
        items.push({ value: "true", label: "True" }, { value: "false", label: "False" });
      else if (field.type === "enum" || field.type === "multi-enum") {
        const current = this.values.get(field.key);
        field.options.forEach((option, index) => {
          const item: SelectItem = {
            value: `option:${index}`,
            label: stripTerminalControls(
              `${field.type === "multi-enum" ? (Array.isArray(current) && current.includes(option.value) ? "[x] " : "[ ] ") : ""}${option.title ?? option.value}`,
            ),
          };
          if (option.title !== undefined) item.description = stripTerminalControls(option.value);
          items.push(item);
        });
        if (field.type === "multi-enum")
          items.push({ value: "empty", label: "Select no options (empty list)" });
      } else items.push({ value: "input", label: "Enter or edit value" });
      if (!field.required) items.push({ value: "omit", label: "Omit this field" });
      items.push({ value: "next", label: "Keep value and continue" });
    } else {
      this.fields().forEach((item, index) =>
        items.push({
          value: `edit:${index}`,
          label: stripTerminalControls(`Edit ${item.title ?? item.key}`),
          description: displayFormValue(this.values.get(item.key)),
        }),
      );
      items.push({
        value: "accept",
        label:
          this.options.request.kind === "url"
            ? "Accept: open browser"
            : "Accept and return answers",
      });
    }
    items.push(
      { value: "decline", label: "Decline request" },
      { value: "cancel", label: "Cancel" },
    );
    const list = new SelectList(items, 8, this.listTheme());
    list.setSelectedIndex(selected);
    list.onCancel = () => this.finish("cancel");
    list.onSelect = (item) => {
      if (this.closed) return;
      this.error = undefined;
      if (item.value === "accept" || item.value === "decline" || item.value === "cancel")
        this.finish(item.value);
      else if (item.value.startsWith("edit:")) {
        this.fieldIndex = Number(item.value.slice(5));
        this.list = this.makeList();
      } else if (field) this.selectField(field, item.value);
      this.options.tui.requestRender();
    };
    return list;
  }
  private selectField(field: FormField, action: string): void {
    if (action === "input") {
      this.editing = true;
      const current = this.values.get(field.key);
      this.editor.setText(stripTerminalControls(current === undefined ? "" : String(current)));
      this.editor.focused = this._focused;
    } else if (action === "omit") {
      this.values.delete(field.key);
      this.advance();
    } else if (action === "next") {
      this.error = validateFormValue(field, this.values.get(field.key));
      if (!this.error) this.advance();
    } else if (field.type === "boolean") {
      this.values.set(field.key, action === "true");
      this.advance();
    } else if (field.type === "enum" || field.type === "multi-enum") {
      if (action === "empty" && field.type === "multi-enum") {
        this.values.set(field.key, []);
        this.list = this.makeList();
        return;
      }
      const index = Number(action.slice(7));
      const option = field.options[index];
      if (!option) return;
      if (field.type === "enum") {
        this.values.set(field.key, option.value);
        this.advance();
      } else {
        const current = this.values.get(field.key);
        const values = new Set(Array.isArray(current) ? current : []);
        if (values.has(option.value)) values.delete(option.value);
        else values.add(option.value);
        this.values.set(field.key, [...values]);
        this.list = this.makeList(index);
      }
    }
  }
  handleInput(data: string): void {
    if (this.closed || this.hidden) return;
    if (this.editing) {
      if (this.options.keybindings.matches(data, "tui.select.cancel")) {
        this.editing = false;
        this.error = undefined;
      } else this.editor.handleInput(data);
    } else if (matchesKey(data, "b")) this.collapse();
    else if (matchesKey(data, "pageUp")) this.textOffset = Math.max(0, this.textOffset - 6);
    else if (matchesKey(data, "pageDown")) this.textOffset += 6;
    else if (matchesKey(data, "tab")) this.advance();
    else if (matchesKey(data, "shift+tab")) {
      this.fieldIndex = Math.max(0, this.fieldIndex - 1);
      this.list = this.makeList();
    } else this.list.handleInput(data);
    this.options.tui.requestRender();
  }
  render(width: number): string[] {
    if (this.closed) return [];
    const w = Math.max(1, width);
    const field = this.field();
    const intro = formIntroduction(this.options.request, w);
    const selected = this.list.getSelectedItem()?.value;
    const described =
      field ??
      (selected?.startsWith("edit:") ? this.fields()[Number(selected.slice(5))] : undefined);
    if (described)
      intro.push(
        ...`${formFieldInstructions(described)}\nValue: ${displayFormValue(this.values.get(described.key))}`
          .split("\n")
          .flatMap((line) => wrapTextWithAnsi(line, w)),
      );
    this.textOffset = Math.min(this.textOffset, Math.max(0, intro.length - 6));
    const lines = [
      stripTerminalControls(`${this.options.owner.extensionId}: ${this.options.owner.label}`),
      // Keep the actual target outside the caller-controlled, scrollable prose.
      ...(this.options.request.kind === "url"
        ? wrapTextWithAnsi(
            stripTerminalControls(`Host: ${new URL(this.options.request.url).host}`),
            w,
          )
        : []),
      ...intro.slice(this.textOffset, this.textOffset + 6),
    ];
    if (intro.length > 6)
      lines.push(
        `PageUp/PageDown: request text ${this.textOffset + 1}-${Math.min(this.textOffset + 6, intro.length)} / ${intro.length}`,
      );
    if (field) {
      lines.push(
        stripTerminalControls(
          `${field.title ?? field.key} (${field.type}, ${field.required ? "required" : "optional"})`,
        ),
      );
      lines.push(`Current: ${displayFormValue(this.values.get(field.key))}`);
    } else lines.push("Review answers. Select a field to edit it before accepting.");
    if (this.error) lines.push(this.options.theme.fg("warning", this.error));
    if (this.editing) {
      this.editor.focused = this._focused;
      lines.push(...this.editor.render(w));
    } else lines.push(...this.list.render(w));
    lines.push(
      this.editing
        ? "Enter saves value; Escape returns to field"
        : "Tab/Shift+Tab fields; b hides; /ask-user resumes; Escape cancels",
    );
    return lines.map((line) => truncateToWidth(line, w));
  }
  invalidate(): void {
    this.editor.invalidate();
    this.list.invalidate();
  }
}
