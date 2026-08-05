import { describe, expect, it } from "vitest";
import {
  normalizeAskUserRequest,
  validateAskUserRequest,
} from "../src/questionnaire/validation.ts";
import type { AskUserRequest } from "../src/tools/schema.ts";

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

  it("rejects duplicate keys, values, labels, and sentinel labels", () => {
    const duplicateKey = base();
    duplicateKey.questions.push({ ...duplicateKey.questions[0]! });
    expect(validateAskUserRequest(duplicateKey)?.message).toContain("Question key");

    const duplicateValue = base();
    duplicateValue.questions[0]!.choices[1]!.value = "small";
    expect(validateAskUserRequest(duplicateValue)?.message).toContain("Choice value");

    const duplicateLabel = base();
    duplicateLabel.questions[0]!.choices[1]!.label = "SMALL";
    expect(validateAskUserRequest(duplicateLabel)?.message).toContain(
      "Choice label must be unique",
    );

    const reserved = base();
    reserved.questions[0]!.choices[1]!.label = "Continue";
    expect(validateAskUserRequest(reserved)?.message).toContain("reserved");
  });
});
