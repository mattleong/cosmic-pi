// Pi dialog APIs are Promise-shaped host boundaries.
import type { ExtensionContext, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  notifyAtHostBoundary,
  stripTerminalControls,
  type HostNotificationLevel,
} from "pi-cosmic-core";
import { AskUserHostError } from "../questionnaire/errors.ts";
import type { AskUserAnswer, AskUserOutcome } from "../questionnaire/model.ts";
import { cancelQuestionnaire } from "../questionnaire/reducer.ts";
import {
  MAX_CUSTOM_ANSWER_LENGTH,
  MAX_NOTE_LENGTH,
  type AskUserQuestion,
  type AskUserRequest,
} from "../questionnaire/schema.ts";
import { captureExternalEditorCommand, editWithExternalEditor } from "./host-external-editor.ts";
import type { AskUserDialogBridge } from "./host-ui.ts";

interface HostDialogsContract {
  readonly ask: (request: AskUserRequest) => Effect.Effect<AskUserOutcome, AskUserHostError>;
}

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
  operation = "open",
): Effect.Effect<A, AskUserHostError> =>
  Effect.tryPromise({ try: run, catch: () => hostError(operation) });

const boundedInput = (
  ui: ExtensionUIContext,
  title: string,
  placeholder: string,
  options: {
    readonly maximum?: number;
    readonly noun?: "answer" | "note";
    readonly allowEmpty?: boolean;
  } = {},
): Effect.Effect<string | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    const maximum = options.maximum ?? MAX_CUSTOM_ANSWER_LENGTH;
    const noun = options.noun ?? "answer";
    while (true) {
      const value = yield* dialogCall((signal) => ui.input(title, placeholder, { signal }));
      if (value === undefined) return undefined;
      const trimmed = value.trim();
      if ((options.allowEmpty || trimmed.length > 0) && trimmed.length <= maximum) return trimmed;
      yield* notifyBestEffort(
        ui,
        trimmed.length === 0
          ? `The ${noun} cannot be empty.`
          : `Keep the ${noun} under ${maximum} characters.`,
        "warning",
      );
    }
  });

const previewText = (question: AskUserQuestion): string => {
  const previews = question.choices.flatMap((choice, index) =>
    choice.preview
      ? [
          `\n--- ${index + 1}. ${stripTerminalControls(choice.label)} preview ---\n${stripTerminalControls(choice.preview).slice(0, 600)}`,
        ]
      : [],
  );
  return previews.join("\n").slice(0, 1_500);
};

const optionLines = (question: AskUserQuestion): string[] =>
  question.choices.map(
    (choice, index) =>
      `${index + 1}. ${stripTerminalControls(choice.label)} — ${stripTerminalControls(choice.description)}`,
  );

const choiceAnswer = (
  question: AskUserQuestion,
  choices: ReadonlyArray<AskUserQuestion["choices"][number]>,
): AskUserAnswer => ({
  key: question.key,
  kind: "choices",
  values: choices.map((choice) => choice.value),
  labels: choices.map((choice) => choice.label),
});

const askSingleQuestion = (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  title: string,
): Effect.Effect<AskUserAnswer | undefined, AskUserHostError> =>
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
        return choiceAnswer(question, [question.choices[index]!]);
      }
      const text = yield* boundedInput(ui, `${title}\n\nWrite your answer:`, "Your answer");
      if (text !== undefined) return { key: question.key, kind: "custom", text };
      yield* notifyBestEffort(
        ui,
        "Custom answer dismissed; choose an option or cancel the question.",
        "info",
      );
    }
  });

const askMultipleQuestion = (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  title: string,
): Effect.Effect<AskUserAnswer | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    const modes = ["Choose listed options", "Write a custom answer"];
    while (true) {
      const mode = yield* dialogCall((signal) =>
        ui.select(`${title}\n\nHow would you like to answer?`, modes, { signal }),
      );
      if (mode === undefined) return undefined;
      if (mode === modes[1]) {
        const text = yield* boundedInput(ui, `${title}\n\nWrite your answer:`, "Your answer");
        if (text !== undefined) return { key: question.key, kind: "custom", text };
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
        const unique = [...new Set(indices)];
        return choiceAnswer(
          question,
          unique.map((index) => question.choices[index]!),
        );
      }
    }
  });

const attachNote = (answer: AskUserAnswer, note: string | undefined): AskUserAnswer => {
  const { note: _previous, ...withoutNote } = answer;
  return note ? { ...withoutNote, note } : withoutNote;
};

const askOptionalNote = (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  answer: AskUserAnswer,
  existingNote: string | undefined,
): Effect.Effect<AskUserAnswer | undefined, AskUserHostError> =>
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
        { maximum: MAX_NOTE_LENGTH, noun: "note", allowEmpty: true },
      );
      if (note !== undefined) return attachNote(answer, note || undefined);
      yield* notifyBestEffort(ui, "Note dismissed; choose how to continue.", "info");
    }
  });

const askRpcQuestion = (
  ui: ExtensionUIContext,
  question: AskUserQuestion,
  existingNote?: string,
): Effect.Effect<AskUserAnswer | undefined, AskUserHostError> =>
  Effect.gen(function* () {
    const title = `[${stripTerminalControls(question.title)}] ${stripTerminalControls(question.prompt)}${previewText(question)}`;
    const answer =
      question.mode === "single"
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
    const answers: AskUserAnswer[] = [];
    for (const question of request.questions) {
      const answer = yield* askRpcQuestion(ctx.ui, question);
      if (!answer) return cancelQuestionnaire();
      answers.push(answer);
    }

    while (true) {
      const reviewTitle = [
        "Review answers",
        ...answers.map(
          (answer, index) =>
            `${index + 1}. [${stripTerminalControls(request.questions[index]!.title)}] ${answerSummary(answer)}`,
        ),
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
      if (selected === options[0]) return { outcome: "submitted", answers };
      const editIndex = editOptions.indexOf(selected);
      if (editIndex < 0) return cancelQuestionnaire();
      const question = request.questions[editIndex]!;
      const replacement = yield* askRpcQuestion(ctx.ui, question, answers[editIndex]?.note);
      if (!replacement) return cancelQuestionnaire();
      answers[editIndex] = replacement;
    }
  });

// Promise-shaped Pi overlay boundary; the caller adapts it with an interruption-linked signal.
function runTui(
  ctx: ExtensionContext,
  bridge: AskUserDialogBridge,
  request: AskUserRequest,
  signal: AbortSignal,
): Promise<AskUserOutcome> {
  return import("../ui/dialog.ts").then(({ AskUserDialog }) => {
    if (signal.aborted) return cancelQuestionnaire();
    const editorCommand = captureExternalEditorCommand(ctx);
    let close: ((outcome: AskUserOutcome) => void) | undefined;
    let bridgeToken: number | undefined;
    let dialog: import("../ui/dialog.ts").AskUserDialog | undefined;
    const abort = () => close?.(cancelQuestionnaire());
    signal.addEventListener("abort", abort, { once: true });
    return ctx.ui
      .custom<AskUserOutcome>(
        (tui, theme, keybindings, done) => {
          const settle = (outcome: AskUserOutcome): void => {
            try {
              done(outcome);
            } catch {
              const token = bridgeToken;
              if (token === undefined) return;
              bridgeToken = undefined;
              try {
                bridge.clear(token);
              } catch {
                // Settlement must not throw back into Pi or an abort listener.
              }
            }
          };
          close = settle;
          dialog = new AskUserDialog({
            tui,
            theme,
            keybindings,
            request,
            done: settle,
            editExternally: (value) => editWithExternalEditor(tui, editorCommand, value, signal),
            onCollapse: () => {
              if (bridgeToken !== undefined) bridge.markCollapsed(bridgeToken);
            },
          });
          if (signal.aborted) settle(cancelQuestionnaire());
          else bridgeToken = bridge.activate(() => dialog?.resume());
          return dialog;
        },
        {
          overlay: true,
          overlayOptions: {
            anchor: "bottom-center",
            width: "100%",
            maxHeight: "100%",
            margin: { left: 0, right: 0, bottom: 0 },
          },
          onHandle: (handle) => dialog?.setOverlayHandle(handle),
        },
      )
      .finally(() => {
        signal.removeEventListener("abort", abort);
        if (bridgeToken !== undefined) bridge.clear(bridgeToken);
      });
  });
}

export class HostDialogs extends Context.Service<HostDialogs, HostDialogsContract>()(
  "pi-ask-user/boundary/host-dialogs/HostDialogs",
) {
  static layer(ctx: ExtensionContext, bridge: AskUserDialogBridge): Layer.Layer<HostDialogs> {
    return Layer.succeed(HostDialogs, {
      ask: (request) =>
        ctx.mode === "tui"
          ? dialogCall((signal) => runTui(ctx, bridge, request, signal), "render")
          : runRpc(ctx, request),
    });
  }
}
