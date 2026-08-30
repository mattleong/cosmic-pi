import { describe, expect, it } from "vitest";
import {
  normalizeAskUserRequest,
  validateAskUserRequest,
} from "../src/questionnaire/validation.ts";
import type { AskUserRequest } from "../src/questionnaire/schema.ts";

const base = (): AskUserRequest => ({
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
});

describe("ask-user validation", () => {
  it("accepts a valid request and normalizes stable identifiers", () => {
    const request = base();
    request.questions[0]!.key = " scope ";
    request.questions[0]!.choices[0]!.value = " small ";
    const normalized = normalizeAskUserRequest(request);
    expect(normalized.questions[0]?.key).toBe("scope");
    expect(normalized.questions[0]?.choices[0]?.value).toBe("small");
    expect(validateAskUserRequest(normalized)).toBeUndefined();
  });

  it("rejects normalized blank required fields before duplicate checks", () => {
    const blankKey = base();
    blankKey.questions.push({
      ...blankKey.questions[0]!,
      choices: blankKey.questions[0]!.choices.map((choice) => ({ ...choice })),
    });
    blankKey.questions[0]!.key = " \t ";
    blankKey.questions[1]!.key = " \t ";

    const blankTitle = base();
    blankTitle.questions[0]!.title = " \t ";

    const blankPrompt = base();
    blankPrompt.questions[0]!.prompt = " \t ";

    const blankValue = base();
    blankValue.questions[0]!.choices[0]!.value = " \t ";
    blankValue.questions[0]!.choices[1]!.value = " \t ";

    const blankLabel = base();
    blankLabel.questions[0]!.choices[0]!.label = " \t ";
    blankLabel.questions[0]!.choices[1]!.label = " \t ";

    const blankDescription = base();
    blankDescription.questions[0]!.choices[0]!.description = " \t ";

    const cases = [
      [blankKey, "Question 1 has an empty key."],
      [blankTitle, "Question 1 has an empty title."],
      [blankPrompt, "Question 1 has an empty prompt."],
      [blankValue, "Question 1, choice 1 has an empty value."],
      [blankLabel, "Question 1, choice 1 has an empty label."],
      [blankDescription, "Question 1, choice 1 has an empty description."],
    ] as const;

    for (const [candidate, message] of cases) {
      expect(validateAskUserRequest(normalizeAskUserRequest(candidate))?.message).toBe(message);
    }
  });

  it("rejects every semantic collision without exposing request content", () => {
    const duplicateKey = base();
    duplicateKey.questions[0]!.key = "private-question-key";
    duplicateKey.questions.push({ ...duplicateKey.questions[0]! });
    const keyMessage = validateAskUserRequest(duplicateKey)?.message;
    expect(keyMessage).toContain("Question 2");
    expect(keyMessage).toContain("duplicate key");
    expect(keyMessage).not.toContain("private-question-key");

    const duplicateValue = base();
    duplicateValue.questions[0]!.choices[0]!.value = "private-choice-value";
    duplicateValue.questions[0]!.choices[1]!.value = "private-choice-value";
    const valueMessage = validateAskUserRequest(duplicateValue)?.message;
    expect(valueMessage).toContain("Question 1, choice 2");
    expect(valueMessage).toContain("duplicate value");
    expect(valueMessage).not.toContain("private-choice-value");

    const duplicateLabel = base();
    duplicateLabel.questions[0]!.choices[0]!.label = "Private Choice Label";
    duplicateLabel.questions[0]!.choices[1]!.label = "PRIVATE CHOICE LABEL";
    const labelMessage = validateAskUserRequest(duplicateLabel)?.message;
    expect(labelMessage).toContain("Question 1, choice 2");
    expect(labelMessage).toContain("duplicate label");
    expect(labelMessage).not.toContain("Private Choice Label");
    expect(labelMessage).not.toContain("PRIVATE CHOICE LABEL");

    const reserved = base();
    reserved.questions[0]!.choices[1]!.label = "Continue";
    const reservedMessage = validateAskUserRequest(reserved)?.message;
    expect(reservedMessage).toContain("Question 1, choice 2");
    expect(reservedMessage).toContain("reserved label");
    expect(reservedMessage).not.toContain("Continue");
  });
});
