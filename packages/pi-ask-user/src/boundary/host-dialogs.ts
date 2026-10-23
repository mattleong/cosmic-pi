import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import {
  notifyAtHostBoundary,
  stripTerminalControls,
  type HostNotificationLevel,
} from "pi-cosmic-core";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserAnswer, AskUserAnswerDraft, AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire, finalizeAskUserAnswer } from "../questionnaire/reducer.ts";
import type { AskUserHost } from "../questionnaire/service.ts";
import {
  type AskUserChoice,
  type AskUserChoiceQuestion,
  type AskUserQuestion,
  type AskUserRequest,
} from "../questionnaire/schema.ts";
import { validateQuestionnaireInput } from "../questionnaire/validation.ts";
import type { AskUserPromptGate } from "./host-prompt.ts";
import { askUserTuiHost } from "./host-tui.ts";
import { titleLabel } from "../ui/layout.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

const hostError = (operation: string) =>
  AskUserHostError.make({ operation, message: `Couldn't ${operation} the questionnaire.` });

const notifyBestEffort = (
  ui: ExtensionUIContext,
  message: string,
  level: HostNotificationLevel,
): Effect.Effect<void> => Effect.sync(() => notifyAtHostBoundary({ ui }, message, level));

const dialogCall = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, AskUserHostError> =>
  Effect.tryPromise({ try: run, catch: () => hostError("open") });

const boundedInput = Effect.fn("AskUserHost.boundedInput")(function* (
  ui: ExtensionUIContext,
  title: string,
  placeholder: string,
  kind: "custom" | "text" | "note" = "custom",
): Effect.fn.Return<string | undefined, AskUserHostError> {
  let rejected: { readonly text: string; readonly error: string } | undefined;
  while (true) {
    const draft = rejected;
    // Native input can't be prefilled, so a nonblank answer that was too long reopens in the
    // editor for trimming. Pi's editor dialog takes no abort signal.
    const value = yield* draft === undefined
      ? dialogCall((signal) => ui.input(title, placeholder, { signal }))
      : dialogCall(() => ui.editor(`${title}\n\n${draft.error}`, draft.text));
    if (value === undefined) return undefined;
    const checked = validateQuestionnaireInput(value, kind);
    if (checked.error === undefined) return checked.value;
    yield* notifyBestEffort(ui, checked.error, "warning");
    rejected = value.trim() ? { text: value, error: checked.error } : undefined;
  }
});

const previewText = (question: AskUserQuestion): string => {
  if (question.mode === "text") return "";
  const previews = Arr.filterMap(question.choices, (choice, index) =>
    choice.preview
      ? Result.succeed(
          `\n--- ${index + 1}. ${stripTerminalControls(choice.label)} preview ---\n${stripTerminalControls(choice.preview).slice(0, 600)}`,
        )
      : Result.failVoid,
  );
  return previews.join("\n").slice(0, 1_500);
};

const optionLines = (question: AskUserChoiceQuestion): string[] =>
  question.choices.map(
    (choice, index) =>
      `${index + 1}. ${stripTerminalControls(choice.label)} — ${stripTerminalControls(choice.description)}`,
  );

const choiceDraft = (choices: ReadonlyArray<AskUserChoice>): AskUserAnswerDraft => ({
  kind: "choices",
  values: choices.map((choice) => choice.value),
});

const askSingleQuestion = Effect.fn("AskUserHost.askSingleQuestion")(function* (
  ui: ExtensionUIContext,
  question: AskUserChoiceQuestion,
  title: string,
): Effect.fn.Return<AskUserAnswerDraft | undefined, AskUserHostError> {
  const options = [
    ...optionLines(question),
    `${question.choices.length + 1}. Write a custom answer`,
  ];
  while (true) {
    const selected = yield* dialogCall((signal) => ui.select(title, options, { signal }));
    if (selected === undefined) return undefined;
    const index = options.indexOf(selected);
    if (index < 0) return undefined;
    const choice = question.choices[index];
    if (choice !== undefined) return choiceDraft([choice]);
    const text = yield* boundedInput(ui, `${title}\n\nWrite your answer:`, "Your answer");
    if (text !== undefined) return { kind: "custom", text };
    yield* notifyBestEffort(
      ui,
      "Custom answer dismissed; choose an option or cancel the question",
      "info",
    );
  }
});

const askMultipleQuestion = Effect.fn("AskUserHost.askMultipleQuestion")(function* (
  ui: ExtensionUIContext,
  question: AskUserChoiceQuestion,
  title: string,
): Effect.fn.Return<AskUserAnswerDraft | undefined, AskUserHostError> {
  const modes = ["Choose listed options", "Write a custom answer"];
  while (true) {
    const mode = yield* dialogCall((signal) =>
      ui.select(`${title}\n\nHow would you like to answer?`, modes, { signal }),
    );
    if (mode === undefined) return undefined;
    if (mode === modes[1]) {
      const text = yield* boundedInput(ui, `${title}\n\nWrite your answer:`, "Your answer");
      if (text !== undefined) return { kind: "custom", text };
      yield* notifyBestEffort(
        ui,
        "Custom answer dismissed; choose options, write an answer, or cancel the question",
        "info",
      );
      continue;
    }
    if (mode !== modes[0]) return undefined;

    while (true) {
      const value = yield* boundedInput(
        ui,
        `${title}\n\n${optionLines(question).join("\n")}\n\nEnter choice numbers separated by commas.`,
        "1,3",
      );
      if (value === undefined) {
        yield* notifyBestEffort(
          ui,
          "Choice selection dismissed; choose how to answer or cancel the question",
          "info",
        );
        break;
      }
      const tokens = value.split(/[\s,]+/).filter(Boolean);
      if (tokens.length === 0 || !tokens.every((token) => /^\d+\.?$/.test(token))) {
        yield* notifyBestEffort(
          ui,
          'Enter only choice numbers, or go back and choose "Write a custom answer"',
          "warning",
        );
        continue;
      }
      const indices = tokens.map((token) => Number.parseInt(token, 10) - 1);
      if (indices.some((index) => index < 0 || index >= question.choices.length)) {
        yield* notifyBestEffort(
          ui,
          `Use choice numbers from 1 to ${question.choices.length}`,
          "warning",
        );
        continue;
      }
      return choiceDraft(Arr.getSomes(indices.map((index) => Arr.get(question.choices, index))));
    }
  }
});

const attachNote = (answer: AskUserAnswerDraft, note: string | undefined): AskUserAnswerDraft => {
  const { note: _previous, ...withoutNote } = answer;
  return note ? { ...withoutNote, note } : withoutNote;
};

const askOptionalNote = Effect.fn("AskUserHost.askOptionalNote")(function* (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  answer: AskUserAnswerDraft,
  existingNote: string | undefined,
): Effect.fn.Return<AskUserAnswerDraft | undefined, AskUserHostError> {
  const title = `Optional note for [${titleLabel(question.title)}]`;
  while (true) {
    const options = existingNote
      ? ["Keep current note", "Edit note", "Remove note"]
      : ["Continue without a note", "Add a note"];
    const currentNote = existingNote
      ? `\n\nCurrent note: ${stripTerminalControls(existingNote).slice(0, 600)}`
      : "";
    const selected = yield* dialogCall((signal) =>
      ui.select(`${title}${currentNote}`, options, { signal }),
    );
    if (selected === undefined) return undefined;
    if (selected === options[0]) return attachNote(answer, existingNote);
    if (existingNote && selected === options[2]) return attachNote(answer, undefined);
    if (selected !== options[1]) return undefined;

    const note = yield* boundedInput(
      ui,
      `${title}\n\nLeave blank to omit the note.`,
      "Optional context",
      "note",
    );
    if (note !== undefined) return attachNote(answer, note || undefined);
    yield* notifyBestEffort(ui, "Note dismissed; choose how to continue", "info");
  }
});

const askRpcQuestion = Effect.fn("AskUserHost.askRpcQuestion")(function* (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  existingNote?: string,
): Effect.fn.Return<AskUserAnswerDraft | undefined, AskUserHostError> {
  const title = `[${titleLabel(question.title)}] ${stripTerminalControls(question.prompt)}${previewText(question)}`;
  const answer = yield* Match.value(question).pipe(
    Match.when({ mode: "text" }, () =>
      boundedInput(ui, title, "Your answer", "text").pipe(
        Effect.map((text) => (text === undefined ? undefined : { kind: "text" as const, text })),
      ),
    ),
    Match.when({ mode: "single" }, (choice) => askSingleQuestion(ui, choice, title)),
    Match.when({ mode: "multiple" }, (choice) => askMultipleQuestion(ui, choice, title)),
    Match.exhaustive,
  );
  if (!answer) return undefined;
  return yield* askOptionalNote(ui, question, answer, existingNote);
});

const answerSummary = (answer: AskUserAnswer): string => {
  const value = answer.kind === "choices" ? answer.labels.join(", ") : answer.text;
  const note = answer.note ? ` · note: ${stripTerminalControls(answer.note).slice(0, 80)}` : "";
  return `${stripTerminalControls(value).slice(0, 120)}${note}`;
};

const answeredQuestions = (request: AskUserRequest, drafts: readonly AskUserAnswerDraft[]) =>
  Arr.filterMap(request.questions, (question, index) => {
    const draft = drafts[index];
    return draft === undefined
      ? Result.failVoid
      : Result.succeed({ question, answer: finalizeAskUserAnswer(question, draft) });
  });

const runRpc = Effect.fn("AskUserHost.runRpc")(function* (
  ctx: ExtensionContext,
  request: AskUserRequest,
): Effect.fn.Return<AskUserOutcome, AskUserHostError> {
  const drafts: AskUserAnswerDraft[] = [];
  for (const question of request.questions) {
    const draft = yield* askRpcQuestion(ctx.ui, question);
    if (!draft) return cancelQuestionnaire();
    drafts.push(draft);
  }

  while (true) {
    const reviewTitle = [
      "Review answers",
      ...answeredQuestions(request, drafts).map(
        ({ question, answer }, index) =>
          `${index + 1}. [${titleLabel(question.title)}] ${answerSummary(answer)}`,
      ),
    ].join("\n");
    const editOptions = request.questions.map(
      (question, index) => `Edit ${index + 1}. ${titleLabel(question.title)}`,
    );
    const options = ["Submit answers", ...editOptions, "Cancel questionnaire"];
    const selected = yield* dialogCall((signal) => ctx.ui.select(reviewTitle, options, { signal }));
    if (selected === undefined || selected === options.at(-1)) {
      return cancelQuestionnaire();
    }
    if (selected === options[0]) {
      return {
        outcome: "submitted",
        answers: answeredQuestions(request, drafts).map(({ answer }) => answer),
      };
    }
    const editIndex = editOptions.indexOf(selected);
    const question = request.questions[editIndex];
    if (question === undefined) return cancelQuestionnaire();
    const replacement = yield* askRpcQuestion(ctx.ui, question, drafts[editIndex]?.note);
    if (!replacement) return cancelQuestionnaire();
    drafts[editIndex] = replacement;
  }
});

export const askUserHost = (
  ctx: ExtensionContext,
  bridge: AskUserDialogBridge,
  promptGate?: AskUserPromptGate,
): AskUserHost =>
  ctx.mode === "tui" ? askUserTuiHost(ctx, bridge, promptGate) : (request) => runRpc(ctx, request);
