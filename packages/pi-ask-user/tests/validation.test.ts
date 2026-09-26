import { describe, expect, it } from "vitest";
import {
  normalizeAskUserRequest,
  validateAskUserRequest,
  validateQuestionnaireInput,
} from "../src/questionnaire/validation.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

const base = () =>
  ({
    questions: [
      {
        key: "scope",
        title: "Scope",
        prompt: "Which scope should we use?",
        mode: "single",
        choices: [
          { value: "small", label: "Small", description: "Minimal change." },
          { value: "large", label: "Large", description: "Broader change." },
        ],
      },
    ],
  }) satisfies AskUserRequest;

describe("ask-user validation", () => {
  it("normalizes text prompts and applies the same fixed trimmed input bounds", () => {
    const normalized = normalizeAskUserRequest({
      questions: [{ key: " note ", title: " Note ", prompt: " Explain? ", mode: "text" }],
    });
    expect(normalized).toEqual({
      questions: [{ key: "note", title: "Note", prompt: "Explain?", mode: "text" }],
    });
    expect(validateAskUserRequest(normalized)).toBeUndefined();
    for (const kind of ["text", "custom"] as const) {
      expect(validateQuestionnaireInput(" \n\t ", kind).error).toBeDefined();
      expect(validateQuestionnaireInput(" x\ny ", kind)).toEqual({ value: "x\ny" });
      expect(validateQuestionnaireInput(" " + "😀".repeat(2000) + " ", kind)).toEqual({
        value: "😀".repeat(2000),
      });
      expect(validateQuestionnaireInput("😀".repeat(2000) + "x", kind).error).toBeDefined();
    }
    expect(validateQuestionnaireInput(" ", "note")).toEqual({ value: "" });
    expect(validateQuestionnaireInput("x".repeat(2000), "note").error).toBeUndefined();
    expect(validateQuestionnaireInput("x".repeat(2001), "note").error).toBeDefined();
  });
  it("accepts a valid request and normalizes stable identifiers", () => {
    const request = base();
    request.questions[0]!.key = " scope ";
    request.questions[0]!.choices[0]!.value = " small ";
    const normalized = normalizeAskUserRequest(request);
    expect(normalized.questions[0]?.key).toBe("scope");
    const question = normalized.questions[0];
    expect(question?.mode !== "text" && question?.choices[0]?.value).toBe("small");
    expect(validateAskUserRequest(normalized)).toBeUndefined();
  });

  it("rejects blank fields before duplicate checks and collisions by position without content", () => {
    type Request = ReturnType<typeof base>;
    const blank = " \t ";
    const [q1, c1, c2] = ["Question 1", "Question 1, choice 1", "Question 1, choice 2"];
    const question = (request: Request) => request.questions[0]!;
    const keys = (request: Request, ...values: string[]) =>
      request.questions.splice(0, 1, ...values.map((key) => ({ ...question(request), key })));
    const choices = (
      request: Request,
      field: "value" | "label" | "description",
      ...values: string[]
    ) =>
      values.forEach((value, i) =>
        Object.assign(question(request).choices[i]!, { [field]: value }),
      );
    const cases: ReadonlyArray<readonly [(request: Request) => void, string, string, ...string[]]> =
      [
        [(r) => keys(r, blank, blank), q1, "empty key"],
        [(r) => Object.assign(question(r), { title: blank }), q1, "empty title"],
        [(r) => Object.assign(question(r), { prompt: blank }), q1, "empty prompt"],
        [(r) => choices(r, "value", blank, blank), c1, "empty value"],
        [(r) => choices(r, "label", blank, blank), c1, "empty label"],
        [(r) => choices(r, "description", blank), c1, "empty description"],
        [
          (r) => keys(r, "private-key", "private-key"),
          "Question 2",
          "duplicate key",
          "private-key",
        ],
        [(r) => choices(r, "value", "private", "private"), c2, "duplicate value", "private"],
        [
          (r) => choices(r, "label", "Private", "PRIVATE"),
          c2,
          "duplicate label",
          "Private",
          "PRIVATE",
        ],
        [(r) => choices(r, "label", "Small", "Continue"), c2, "reserved label", "Continue"],
      ];
    for (const [edit, position, reason, ...privateText] of cases) {
      const request = base();
      edit(request);
      const message = validateAskUserRequest(normalizeAskUserRequest(request))?.message;
      expect(message).toContain(position);
      expect(message).toContain(reason);
      for (const text of privateText) expect(message).not.toContain(text);
    }
  });
});
