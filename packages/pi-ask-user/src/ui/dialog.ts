import type { KeybindingsManager, Theme } from "@earendil-works/pi-coding-agent";
import {
  Editor,
  type EditorTheme,
  type Focusable,
  isKeyRepeat,
  Key,
  matchesKey,
  type KeyId,
  type OverlayHandle,
  type TUI,
} from "@earendil-works/pi-tui";
import {
  FullScreenKeymap,
  type FullScreenSelectionKeybindingId,
} from "pi-cosmic-ui/manager/keymap";
import {
  cancelQuestionnaire,
  createQuestionnaireState,
  reduceQuestionnaire,
  submitQuestionnaire,
} from "../questionnaire/reducer.ts";
import type {
  AskUserOutcome,
  QuestionnaireAction,
  QuestionnaireState,
} from "../questionnaire/model.ts";
import {
  MAX_CHOICES,
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserQuestion,
  type AskUserRequest,
} from "../questionnaire/schema.ts";
import { PreviewPane } from "./preview-pane.ts";
import { type DialogInputMode, renderQuestionnaireView } from "./render.ts";

const CHOICE_SHORTCUTS: readonly KeyId[] = Array.from(
  { length: MAX_CHOICES },
  // SAFETY: i + 1 ranges over 1..MAX_CHOICES (4), always a single digit, which is a valid KeyId.
  (_, i) => String(i + 1) as KeyId,
);

const DIALOG_SHORTCUTS = new Set(["b", "n"]);

interface AskUserDialogOptions {
  readonly tui: TUI;
  readonly theme: Theme;
  readonly keybindings: KeybindingsManager;
  readonly request: AskUserRequest;
  readonly done: (outcome: AskUserOutcome) => void;
  readonly editExternally: (value: string) => Promise<string | undefined>;
  readonly onCollapse: () => void;
}

const editorTheme = (theme: Theme): EditorTheme => ({
  borderColor: (value) => theme.fg("accent", value),
  selectList: {
    selectedPrefix: (value) => theme.fg("accent", value),
    selectedText: (value) => theme.fg("accent", value),
    description: (value) => theme.fg("muted", value),
    scrollInfo: (value) => theme.fg("dim", value),
    noMatch: (value) => theme.fg("warning", value),
  },
});

export class AskUserDialog implements Focusable {
  private readonly options: Omit<AskUserDialogOptions, "request">;
  private state: QuestionnaireState;
  private input: DialogInputMode | undefined;
  private inputError: string | undefined;
  private alternateHelp = false;
  private externalEditorBusy = false;
  private readonly editor: Editor;
  private readonly preview: PreviewPane;
  private readonly keymap = new FullScreenKeymap();
  private _focused = false;
  private overlayHandle: OverlayHandle | undefined;

  constructor({ request, ...options }: AskUserDialogOptions) {
    this.state = createQuestionnaireState(request);
    this.options = options;
    this.editor = new Editor(options.tui, editorTheme(options.theme), { paddingX: 1 });
    this.preview = new PreviewPane(options.theme);
    this.editor.onSubmit = (value) => this.commitInput(value);
  }

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.editor.focused = value && this.input !== undefined;
  }

  setOverlayHandle(handle: OverlayHandle): void {
    this.overlayHandle = handle;
  }

  resume(): void {
    this.overlayHandle?.setHidden(false);
    this.options.tui.requestRender(true);
  }

  collapse(): void {
    this.overlayHandle?.setHidden(true);
    this.options.onCollapse();
  }

  private refresh(): void {
    this.options.tui.requestRender();
  }

  private dispatch(action: QuestionnaireAction): void {
    this.state = reduceQuestionnaire(this.state, action);
  }

  private currentQuestion(): AskUserQuestion | undefined {
    return this.state.request.questions[this.state.currentTab];
  }

  private setCursor(cursor: number): void {
    const question = this.currentQuestion();
    if (!question) return;
    const limit = question.choices.length + (question.mode === "multiple" ? 1 : 0);
    this.dispatch({
      type: "set-cursor",
      question: this.state.currentTab,
      cursor: Math.max(0, Math.min(limit, cursor)),
    });
    this.inputError = undefined;
    this.refresh();
  }

  private advance(): void {
    this.dispatch({
      type: "set-tab",
      tab: Math.min(this.state.request.questions.length, this.state.currentTab + 1),
    });
    this.inputError = undefined;
    this.refresh();
  }

  private openInput(kind: DialogInputMode["kind"]): void {
    const question = this.state.currentTab;
    const draft = this.state.drafts[question];
    const value =
      kind === "note"
        ? (draft?.note ?? "")
        : draft?.answer?.kind === "custom"
          ? draft.answer.text
          : "";
    this.input = { kind, question };
    this.inputError = undefined;
    this.editor.setText(value);
    this.editor.focused = this._focused;
    this.refresh();
  }

  private closeInput(): void {
    this.input = undefined;
    this.inputError = undefined;
    this.editor.focused = false;
    this.refresh();
  }

  private commitInput(value: string): void {
    const input = this.input;
    if (!input) return;
    const trimmed = value.trim();
    const maximum = input.kind === "note" ? MAX_NOTE_LENGTH : MAX_CUSTOM_ANSWER_LENGTH;
    if (input.kind === "custom" && trimmed.length === 0) {
      this.inputError = "Write an answer first.";
      this.refresh();
      return;
    }
    if (trimmed.length > maximum) {
      this.inputError = `Keep this ${input.kind === "note" ? "note" : "answer"} under ${maximum} characters.`;
      this.refresh();
      return;
    }
    this.dispatch(
      input.kind === "note"
        ? { type: "set-note", question: input.question, note: trimmed }
        : { type: "set-custom", question: input.question, text: trimmed },
    );
    this.input = undefined;
    this.editor.focused = false;
    if (input.kind === "custom") this.advance();
    else this.refresh();
  }

  private openExternalEditor(): void {
    if (this.externalEditorBusy) return;
    this.externalEditorBusy = true;
    this.inputError = undefined;
    const active = this.input;
    void this.options
      .editExternally(this.editor.getExpandedText())
      .then((value) => {
        if (active && this.input === active && value !== undefined) this.editor.setText(value);
      })
      .catch(() => {
        if (active && this.input === active)
          this.inputError = "The external editor failed; your draft is unchanged.";
      })
      .finally(() => {
        this.externalEditorBusy = false;
        try {
          this.refresh();
        } catch {
          // The dialog may have been disposed while the external editor was open.
        }
      });
  }

  handleInput(data: string): void {
    const matchesKeybinding = (input: string, id: FullScreenSelectionKeybindingId) =>
      this.options.keybindings.matches(input, id);

    if (this.input) {
      const resolution = this.keymap.resolve(data, {
        mode: "text-input",
        matchesKeybinding,
      });
      if (resolution?._tag === "Action" && resolution.action === "cancel") {
        this.closeInput();
        return;
      }
      if (this.options.keybindings.matches(data, "app.editor.external")) {
        this.openExternalEditor();
        return;
      }
      this.editor.handleInput(data);
      this.refresh();
      return;
    }

    const resolution = this.keymap.resolve(data, {
      mode: "navigation",
      matchesKeybinding,
      reservedKeys: DIALOG_SHORTCUTS,
    });
    if (resolution?._tag === "Shortcut") {
      if (resolution.key === "b") this.collapse();
      else if (
        resolution.key === "n" &&
        this.state.currentTab < this.state.request.questions.length
      )
        this.openInput("note");
      return;
    }
    if (resolution?._tag === "Action") {
      if (resolution.action === "cancel") {
        this.options.done(cancelQuestionnaire());
        return;
      }
      if (resolution.action === "forward" || resolution.action === "next-pane") {
        this.dispatch({ type: "move-tab", delta: 1 });
        this.refresh();
        return;
      }
      if (resolution.action === "back" || resolution.action === "previous-pane") {
        this.dispatch({ type: "move-tab", delta: -1 });
        this.refresh();
        return;
      }
      if (resolution.action === "up" || resolution.action === "down") {
        if (this.state.currentTab === this.state.request.questions.length) {
          this.dispatch({
            type: "set-review-cursor",
            cursor: this.state.reviewCursor === 0 ? 1 : 0,
          });
          this.refresh();
          return;
        }
        const draft = this.state.drafts[this.state.currentTab];
        if (draft) this.setCursor(draft.cursor + (resolution.action === "up" ? -1 : 1));
        return;
      }
      if (resolution.action === "help") {
        this.alternateHelp = !this.alternateHelp;
        this.refresh();
        return;
      }
      if (resolution.action === "quit") return;
    }

    if (this.state.currentTab === this.state.request.questions.length) {
      this.handleReviewInput(data);
      return;
    }
    this.handleQuestionInput(data);
  }

  private handleReviewInput(data: string): void {
    if (!this.options.keybindings.matches(data, "tui.select.confirm")) return;
    if (this.state.reviewCursor === 1) {
      this.options.done(cancelQuestionnaire());
      return;
    }
    const unanswered = this.state.drafts.findIndex((draft) => draft.answer === undefined);
    if (unanswered >= 0) {
      this.dispatch({ type: "set-tab", tab: unanswered });
      this.inputError = "Answer this question to finish.";
      this.refresh();
      return;
    }
    const outcome = submitQuestionnaire(this.state);
    if (outcome) this.options.done(outcome);
  }

  private handleQuestionInput(data: string): void {
    const question = this.currentQuestion();
    const draft = this.state.drafts[this.state.currentTab];
    if (!question || !draft) return;
    for (let index = 0; index < question.choices.length; index++) {
      const shortcut = CHOICE_SHORTCUTS[index];
      if (shortcut && matchesKey(data, shortcut)) {
        if (!isKeyRepeat(data)) this.activateChoice(question, index);
        return;
      }
    }
    if (
      matchesKey(data, Key.space) &&
      question.mode === "multiple" &&
      draft.cursor < question.choices.length
    ) {
      this.toggleMultiple(draft.cursor);
      return;
    }
    if (!this.options.keybindings.matches(data, "tui.select.confirm")) return;
    if (draft.cursor < question.choices.length) {
      this.activateChoice(question, draft.cursor);
      return;
    }
    if (draft.cursor === question.choices.length) {
      this.openInput("custom");
      return;
    }
    if (draft.answer) this.advance();
    else {
      this.inputError = "Select at least one choice or write a custom answer.";
      this.refresh();
    }
  }

  private activateChoice(question: AskUserQuestion, choice: number): void {
    this.dispatch({
      type: "set-cursor",
      question: this.state.currentTab,
      cursor: choice,
    });
    if (question.mode === "single") {
      this.dispatch({
        type: "select-one",
        question: this.state.currentTab,
        choice,
      });
      this.advance();
      return;
    }
    this.toggleMultiple(choice);
  }

  private toggleMultiple(choice: number): void {
    this.dispatch({
      type: "toggle-many",
      question: this.state.currentTab,
      choice,
    });
    this.refresh();
  }

  render(width: number): string[] {
    return renderQuestionnaireView(
      {
        theme: this.options.theme,
        state: this.state,
        input: this.input,
        inputError: this.inputError,
        alternateHelp: this.alternateHelp,
        externalEditorBusy: this.externalEditorBusy,
        editor: this.editor,
        preview: this.preview,
      },
      width,
    );
  }

  invalidate(): void {
    this.editor.invalidate();
    this.preview.invalidate();
  }
}
