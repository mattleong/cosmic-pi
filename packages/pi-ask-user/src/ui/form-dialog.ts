import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  SelectList,
  matchesKey,
  wrapTextWithAnsi,
  type Focusable,
  type SelectItem,
  type TUI,
} from "@earendil-works/pi-tui";
import { stripTerminalControls } from "pi-cosmic-core";
import { FullScreenKeymap } from "pi-cosmic-ui/manager/keymap";
import { DialogViewport, SELECTION_MARKER } from "./viewport.ts";
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
import { selectListTheme } from "./layout.ts";
import { clipToWidth } from "pi-cosmic-ui/manager";

interface Options {
  readonly tui: TUI;
  readonly getHeight?: () => number;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly request: OwnedFormRequest;
  readonly owner: ExtensionFormOwner;
  readonly done: (outcome: FormOutcome) => void;
  /** Hides the docked form; the host owns hide/resume and drops input while hidden. */
  readonly collapse: () => void;
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
  private closed = false;
  private readonly viewport = new DialogViewport();
  private readonly keymap = new FullScreenKeymap();
  private _focused = false;
  constructor(options: Options) {
    this.options = options;
    this.values = new Map(initialFormValues(options.request));
    const selectList = selectListTheme(options.theme, SELECTION_MARKER);
    this.editor = new Editor(
      options.tui,
      { borderColor: (text) => options.theme.fg("accent", text), selectList },
      { paddingX: 1 },
    );
    this.editor.onSubmit = (text) => {
      const field = this.field();
      if (!field || this.closed) return;
      const value = parseFormInput(field, text);
      this.error = value === undefined ? "Enter a valid value" : validateFormValue(field, value);
      if (!this.error && value !== undefined) {
        this.values.set(field.key, value);
        this.editing = false;
        this.editor.focused = false;
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
  get focused(): boolean {
    return this._focused;
  }
  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.editing;
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
    this.viewport.follow();
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
    const list = new SelectList(items, 8, selectListTheme(this.options.theme, SELECTION_MARKER));
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
    if (this.closed) return;
    if (!this.editing) {
      const resolution = this.keymap.resolve(data, {
        mode: "navigation",
        matchesKeybinding: (input, id) => this.options.keybindings.matches(input, id),
        reservedKeys: new Set(["b"]),
      });
      if (resolution?._tag === "Action" && this.viewport.page(resolution.action)) {
        this.options.tui.requestRender();
        return;
      }
      this.viewport.follow();
    }
    if (this.editing) {
      if (this.options.keybindings.matches(data, "tui.select.cancel")) {
        this.editing = false;
        this.editor.focused = false;
        this.error = undefined;
        this.viewport.follow();
      } else this.editor.handleInput(data);
    } else if (matchesKey(data, "b")) this.options.collapse();
    else if (matchesKey(data, "tab")) this.advance();
    else if (matchesKey(data, "shift+tab")) {
      this.fieldIndex = Math.max(0, this.fieldIndex - 1);
      this.list = this.makeList();
    } else this.list.handleInput(data);
    this.options.tui.requestRender();
  }
  render(width: number): string[] {
    const height = this.options.getHeight?.() ?? 24;
    if (this.closed || width < 1 || height < 1) return [];
    const w = Math.floor(width);
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
    if (
      (field?.type === "enum" || field?.type === "multi-enum") &&
      selected?.startsWith("option:")
    ) {
      const option = field.options[Number(selected.slice(7))];
      if (option)
        intro.push(
          ...wrapTextWithAnsi(
            stripTerminalControls(`${option.title ?? option.value}\n${option.value}`),
            w,
          ),
        );
    }
    const identity = [
      stripTerminalControls(`${this.options.owner.extensionId}: ${this.options.owner.label}`),
      // Show the actual target before caller-controlled prose; neither is truncated.
      ...(this.options.request.kind === "url"
        ? wrapTextWithAnsi(
            stripTerminalControls(`Host: ${new URL(this.options.request.url).host}`),
            w,
          )
        : []),
    ];
    // Pin the complete host when there is still room for content and an action.
    // Oversized identities join the scrollable text rather than hiding their suffix.
    const pinned = identity.length <= height - 3 ? identity : [];
    const lines = [...(pinned.length ? [] : identity), ...intro];
    if (field) {
      lines.push(
        stripTerminalControls(
          `${field.title ?? field.key} (${field.type}, ${field.required ? "required" : "optional"})`,
        ),
      );
      lines.push(`Current: ${displayFormValue(this.values.get(field.key))}`);
    } else lines.push("Review answers. Select a field to edit it before accepting.");
    const errors =
      this.error && height - pinned.length > 1
        ? [clipToWidth(this.options.theme.fg("warning", this.error), w, "")]
        : [];
    if (this.editing) {
      this.editor.focused = this._focused;
      lines.push(...this.editor.render(w));
    } else lines.push(...this.list.render(w));
    lines.push(
      this.editing
        ? "Enter saves value; Escape returns to field"
        : "PgUp/PgDn scroll; Home/End first/last; Tab/Shift+Tab fields; b hides; Escape cancels",
    );
    return [
      ...pinned.map((line) => clipToWidth(line, w, "")),
      ...this.viewport.render(lines, w, height - pinned.length - errors.length),
      ...errors,
    ];
  }
  invalidate(): void {
    this.editor.invalidate();
    this.list.invalidate();
  }
}
