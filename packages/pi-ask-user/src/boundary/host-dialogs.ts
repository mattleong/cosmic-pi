// Pi dialog APIs are Promise-shaped host boundaries.
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
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
import { makeAskUserTuiHost } from "./host-tui.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

const hostError = (operation: string) =>
  new AskUserHostError({ operation, message: `Unable to ${operation} the user questionnaire.` });

const notifyBestEffort = (
  ui: ExtensionUIContext,
  message: string,
  level: HostNotificationLevel,
): Effect.Effect<void> => Effect.sync(() => notifyAtHostBoundary({ ui }, message, level));

/** Adapts one Promise-shaped Pi dialog call; interruption aborts the forwarded signal. */
const dialogCall = <A>(
  run: (signal: AbortSignal) => Promise<A>,
): Effect.Effect<A, AskUserHostError> =>
  Effect.tryPromise({ try: run, catch: () => hostError("open") });

const boundedInput = (
  ui: ExtensionUIContext,
  title: string,
  placeholder: string,
  kind: "custom" | "text" | "note" = "custom",
): Effect.Effect<string | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    while (true) {
      const value = yield* dialogCall((signal) => ui.input(title, placeholder, { signal }));
      if (value === undefined) return undefined;
      const checked = validateQuestionnaireInput(value, kind);
      if (checked.error === undefined) return checked.value;
      yield* notifyBestEffort(ui, checked.error, "warning");
    }
  });

const previewText = (question: AskUserQuestion): string => {
  if (question.mode === "text") return "";
  const previews = question.choices.flatMap((choice, index) =>
    choice.preview
      ? [
          `\n--- ${index + 1}. ${stripTerminalControls(choice.label)} preview ---\n${stripTerminalControls(choice.preview).slice(0, 600)}`,
        ]
      : [],
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

const askSingleQuestion = (
  ui: ExtensionUIContext,
  question: AskUserChoiceQuestion,
  title: string,
): Effect.Effect<AskUserAnswerDraft | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    const options = [
      ...optionLines(question),
      `${question.choices.length + 1}. Write a custom answer`,
    ];
    while (true) {
      const selected = yield* dialogCall((signal) => ui.select(title, options, { signal }));
      if (selected === undefined) return undefined;
      const index = options.indexOf(selected);
      if (index < 0) return undefined;
      if (index < question.choices.length) {
        return choiceDraft([question.choices[index]!]);
      }
      const text = yield* boundedInput(ui, `${title}\n\nWrite your answer:`, "Your answer");
      if (text !== undefined) return { kind: "custom", text };
      yield* notifyBestEffort(
        ui,
        "Custom answer dismissed; choose an option or cancel the question.",
        "info",
      );
    }
  });

const askMultipleQuestion = (
  ui: ExtensionUIContext,
  question: AskUserChoiceQuestion,
  title: string,
): Effect.Effect<AskUserAnswerDraft | undefined, AskUserHostError> =>
  Effect.gen(function* () {
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
          "Custom answer dismissed; choose listed options, write a custom answer, or cancel the question.",
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
            "Choice selection dismissed; choose an answer mode or cancel the question.",
            "info",
          );
          break;
        }
        const tokens = value.split(/[\s,]+/).filter(Boolean);
        if (!tokens.every((token) => /^\d+\.?$/.test(token))) {
          yield* notifyBestEffort(
            ui,
            'Enter only choice numbers, or go back and choose "Write a custom answer."',
            "warning",
          );
          continue;
        }
        const indices = tokens.map((token) => Number.parseInt(token, 10) - 1);
        if (indices.some((index) => index < 0 || index >= question.choices.length)) {
          yield* notifyBestEffort(
            ui,
            `Use choice numbers from 1 to ${question.choices.length}.`,
            "warning",
          );
          continue;
        }
        return choiceDraft(indices.map((index) => question.choices[index]!));
      }
    }
  });

const attachNote = (answer: AskUserAnswerDraft, note: string | undefined): AskUserAnswerDraft => {
  const { note: _previous, ...withoutNote } = answer;
  return note ? { ...withoutNote, note } : withoutNote;
};

const askOptionalNote = (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  answer: AskUserAnswerDraft,
  existingNote: string | undefined,
): Effect.Effect<AskUserAnswerDraft | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    const title = `Optional note for [${stripTerminalControls(question.title)}]`;
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
      yield* notifyBestEffort(ui, "Note dismissed; choose how to continue.", "info");
    }
  });

const askRpcQuestion = (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  existingNote?: string,
): Effect.Effect<AskUserAnswerDraft | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    const title = `[${stripTerminalControls(question.title)}] ${stripTerminalControls(question.prompt)}${previewText(question)}`;
    const answer: AskUserAnswerDraft | undefined =
      question.mode === "text"
        ? yield* boundedInput(ui, title, "Your answer", "text").pipe(
            Effect.map((text) =>
              text === undefined ? undefined : { kind: "text" as const, text },
            ),
          )
        : question.mode === "single"
          ? yield* askSingleQuestion(ui, question, title)
          : yield* askMultipleQuestion(ui, question, title);
    if (!answer) return undefined;
    return yield* askOptionalNote(ui, question, answer, existingNote);
  });

const answerSummary = (answer: AskUserAnswer): string => {
  const value = answer.kind === "choices" ? answer.labels.join(", ") : answer.text;
  const note = answer.note ? ` · note: ${stripTerminalControls(answer.note).slice(0, 80)}` : "";
  return `${stripTerminalControls(value).slice(0, 120)}${note}`;
};

const runRpc = (
  ctx: ExtensionContext,
  request: AskUserRequest,
): Effect.Effect<AskUserOutcome, AskUserHostError> =>
  Effect.gen(function* () {
    const drafts: AskUserAnswerDraft[] = [];
    for (const question of request.questions) {
      const draft = yield* askRpcQuestion(ctx.ui, question);
      if (!draft) return cancelQuestionnaire();
      drafts.push(draft);
    }

    while (true) {
      const reviewTitle = [
        "Review answers",
        ...drafts.map((draft, index) => {
          const question = request.questions[index]!;
          return `${index + 1}. [${stripTerminalControls(question.title)}] ${answerSummary(finalizeAskUserAnswer(question, draft))}`;
        }),
      ].join("\n");
      const editOptions = request.questions.map(
        (question, index) => `Edit ${index + 1}. ${stripTerminalControls(question.title)}`,
      );
      const options = ["Submit answers", ...editOptions, "Cancel questionnaire"];
      const selected = yield* dialogCall((signal) =>
        ctx.ui.select(reviewTitle, options, { signal }),
      );
      if (selected === undefined || selected === options[options.length - 1]) {
        return cancelQuestionnaire();
      }
      if (selected === options[0]) {
        return {
          outcome: "submitted",
          answers: drafts.map((draft, index) =>
            finalizeAskUserAnswer(request.questions[index]!, draft),
          ),
        };
      }
      const editIndex = editOptions.indexOf(selected);
      if (editIndex < 0) return cancelQuestionnaire();
      const question = request.questions[editIndex]!;
      const replacement = yield* askRpcQuestion(ctx.ui, question, drafts[editIndex]?.note);
      if (!replacement) return cancelQuestionnaire();
      drafts[editIndex] = replacement;
    }
  });

export const makeAskUserHost = (
  ctx: ExtensionContext,
  bridge: AskUserDialogBridge,
  promptGate?: AskUserPromptGate,
): AskUserHost =>
  ctx.mode === "tui"
    ? makeAskUserTuiHost(ctx, bridge, promptGate)
    : (request) => runRpc(ctx, request);
