import { describe, expect, it } from "vitest";
import {
  cancelQuestionnaire,
  createQuestionnaireState,
  isQuestionnaireComplete,
  reduceQuestionnaire,
  submitQuestionnaire,
} from "../src/questionnaire/reducer.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

const request: AskUserRequest = {
  questions: [
    {
      key: "library",
      title: "Library",
      prompt: "Which library should we use?",
      mode: "single",
      choices: [
        { value: "date-fns", label: "date-fns", description: "Small functional helpers." },
        { value: "luxon", label: "Luxon", description: "Rich date-time objects." },
      ],
    },
    {
      key: "checks",
      title: "Checks",
      prompt: "Which checks should run?",
      mode: "multiple",
      choices: [
        { value: "unit", label: "Unit tests", description: "Fast isolated tests." },
        { value: "integration", label: "Integration", description: "Cross-boundary tests." },
      ],
    },
  ],
};

describe("questionnaire reducer", () => {
  it("requires valid text, keeps notes through edits, and does not accept choice actions for text", () => {
    let state = createQuestionnaireState({
      questions: [{ key: "details", title: "Details", prompt: "Describe?", mode: "text" }],
    });
    for (const text of [" \n ", "x".repeat(4001)]) {
      state = reduceQuestionnaire(state, { type: "set-text", question: 0, text });
      expect(submitQuestionnaire(state)).toBeUndefined();
    }
    state = reduceQuestionnaire(state, { type: "set-note", question: 0, note: " context " });
    state = reduceQuestionnaire(state, { type: "set-text", question: 0, text: " first " });
    state = reduceQuestionnaire(state, { type: "select-one", question: 0, choice: 0 });
    state = reduceQuestionnaire(state, { type: "set-custom", question: 0, text: "wrong mode" });
    expect(state.drafts[0]?.answer).toEqual({ kind: "text", text: "first" });
    state = reduceQuestionnaire(state, {
      type: "set-text",
      question: 0,
      text: " revised\nanswer ",
    });
    expect(submitQuestionnaire(state)).toEqual({
      outcome: "submitted",
      answers: [{ key: "details", kind: "text", text: "revised\nanswer", note: "context" }],
    });
  });
  it("builds stable choice and custom answer details", () => {
    let state = createQuestionnaireState(request);
    state = reduceQuestionnaire(state, { type: "select-one", question: 0, choice: 1 });
    state = reduceQuestionnaire(state, {
      type: "set-note",
      question: 0,
      note: "Prefer its timezone API.",
    });
    state = reduceQuestionnaire(state, {
      type: "set-custom",
      question: 1,
      text: "Run the smoke suite.",
    });

    expect(isQuestionnaireComplete(state)).toBe(true);
    expect(state.drafts.map((draft) => draft.answer)).toEqual([
      { kind: "choices", values: ["luxon"] },
      { kind: "custom", text: "Run the smoke suite." },
    ]);
    expect(submitQuestionnaire(state)).toEqual({
      outcome: "submitted",
      answers: [
        {
          key: "library",
          kind: "choices",
          values: ["luxon"],
          labels: ["Luxon"],
          note: "Prefer its timezone API.",
        },
        { key: "checks", kind: "custom", text: "Run the smoke suite." },
      ],
    });
  });

  it("tracks multi-select order by authored choice order and retains a separate note", () => {
    let state = createQuestionnaireState(request);
    state = reduceQuestionnaire(state, { type: "select-one", question: 0, choice: 0 });
    state = reduceQuestionnaire(state, {
      type: "set-note",
      question: 1,
      note: "Run both in CI.",
    });
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 1 });
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
    expect(isQuestionnaireComplete(state)).toBe(true);
    expect(state.drafts[1]?.answer).toEqual({
      kind: "choices",
      values: ["unit", "integration"],
    });
    expect(submitQuestionnaire(state)?.answers[1]).toEqual({
      key: "checks",
      kind: "choices",
      values: ["unit", "integration"],
      labels: ["Unit tests", "Integration"],
      note: "Run both in CI.",
    });
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 1 });
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
    expect(isQuestionnaireComplete(state)).toBe(false);
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
    expect(submitQuestionnaire(state)?.answers[1]).toMatchObject({
      values: ["unit"],
      note: "Run both in CI.",
    });
  });

  it.each([{}, { note: "Keep the note" }])(
    "replaces custom answers and omits empty selections while retaining note %s",
    (notes) => {
      let state = createQuestionnaireState(request);
      state = {
        ...state,
        drafts: [
          { cursor: 0 },
          {
            cursor: 1,
            answer: { kind: "custom", text: "Other checks" },
            ...notes,
          },
        ],
      };
      state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
      expect(state.drafts[1]).toEqual({
        cursor: 1,
        answer: { kind: "choices", values: ["unit"] },
        ...notes,
      });
      state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
      expect(state.drafts[1]).toEqual({ cursor: 1, ...notes });
    },
  );

  it("discards unknown selections and removes every duplicate of a toggled value", () => {
    let state = createQuestionnaireState(request);
    state = {
      ...state,
      drafts: [
        { cursor: 0 },
        {
          cursor: 0,
          answer: { kind: "choices", values: ["unknown", "integration", "unit", "unit"] },
        },
      ],
    };
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
    expect(state.drafts[1]?.answer).toEqual({ kind: "choices", values: ["integration"] });
    state = reduceQuestionnaire(state, { type: "toggle-many", question: 1, choice: 0 });
    expect(state.drafts[1]?.answer).toEqual({ kind: "choices", values: ["unit", "integration"] });
  });

  it("requires every question and discards drafts on cancellation", () => {
    const state = reduceQuestionnaire(createQuestionnaireState(request), {
      type: "select-one",
      question: 0,
      choice: 0,
    });
    expect(isQuestionnaireComplete(state)).toBe(false);
    expect(submitQuestionnaire(state)).toBeUndefined();
    expect(cancelQuestionnaire()).toEqual({ outcome: "cancelled", answers: [] });
  });
});
