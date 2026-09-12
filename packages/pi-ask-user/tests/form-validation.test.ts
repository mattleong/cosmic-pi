import { expect, it } from "vitest";
import type { FormField, OwnedFormRequest } from "../src/protocol.ts";
import { formContent, initialFormValues } from "../src/questionnaire/form-model.ts";
import {
  parseFormInput,
  validateFormOutcome,
  validateFormRequest,
  validateFormValue,
} from "../src/questionnaire/form-validation.ts";

it("preserves false, zero, empty strings, defaults and explicit omission", () => {
  const request: OwnedFormRequest = {
    kind: "form",
    message: "",
    fields: [
      { key: "zero", type: "integer", default: 0, required: true },
      { key: "false", type: "boolean", default: false, required: true },
      { key: "empty", type: "string", default: "", required: true },
      { key: "absent", type: "string" },
    ],
  };
  expect(validateFormRequest(request)).toBeUndefined();
  const content = formContent(initialFormValues(request));
  expect(content).toEqual({ zero: 0, false: false, empty: "" });
  expect(validateFormOutcome(request, { action: "accept", content })).toEqual({
    action: "accept",
    content,
  });
  expect(
    validateFormOutcome(request, { action: "accept", content: { ...content, extra: true } }),
  ).toBeUndefined();
  expect(validateFormOutcome(request, { action: "accept", content: {} })).toBeUndefined();
  expect(validateFormOutcome(request, { action: "decline" })).toEqual({ action: "decline" });
  expect(validateFormOutcome(request, { action: "cancel" })).toEqual({ action: "cancel" });
  expect(parseFormInput({ key: "x", type: "number" }, "")).toBeUndefined();
  expect(parseFormInput({ key: "x", type: "number" }, "0")).toBe(0);
});

it("validates fixed field constraints and never includes private values in errors", () => {
  const cases: readonly [FormField, string | number | boolean | readonly string[]][] = [
    [{ key: "x", type: "integer" }, 0.5],
    [{ key: "x", type: "number", minimum: 1 }, 0],
    [{ key: "x", type: "number", maximum: 1 }, 2],
    [{ key: "x", type: "string", minLength: 2 }, "x"],
    [{ key: "x", type: "string", maxLength: 2 }, "private"],
    [{ key: "x", type: "string", format: "date" }, "2023-02-29"],
    [{ key: "x", type: "string", format: "date-time" }, "2024-02-29T25:00:00Z"],
    [{ key: "x", type: "string", format: "email" }, "private@@example.test"],
    [{ key: "x", type: "string", format: "uri" }, "private relative path"],
    [{ key: "x", type: "enum", options: [{ value: "ok" }] }, "private"],
    [{ key: "x", type: "multi-enum", options: [{ value: "ok" }] }, ["ok", "ok"]],
    [{ key: "x", type: "multi-enum", minItems: 1, options: [{ value: "ok" }] }, []],
  ];
  for (const [field, value] of cases) {
    const error = validateFormValue(field, value);
    expect(error).toBeDefined();
    expect(error).not.toContain("private");
  }
  expect(
    validateFormValue({ key: "x", type: "string", format: "date" }, "2024-02-29"),
  ).toBeUndefined();
  expect(
    validateFormValue(
      { key: "x", type: "string", format: "date-time" },
      "2024-02-29T23:59:59+01:00",
    ),
  ).toBeUndefined();
  expect(
    validateFormValue({ key: "x", type: "string", minLength: 1, maxLength: 1 }, "😀"),
  ).toBeUndefined();
});

it.each([
  "",
  "@example.test",
  "a@",
  "a@.",
  "a..b@example.test",
  ".a@example.test",
  "a.@example.test",
  "a@.example.test",
  "a@example.test.",
  "a@example..test",
  "a@-example.test",
  "a@example-.test",
  "a@exam_ple.test",
  "a b@example.test",
  "a\n@example.test",
  "a@example.test\n",
  "a@example.test\u2028",
  "a\t@example.test",
  "a\u0000@example.test",
  "a\u007f@example.test",
  "a\u0085@example.test",
  "a(b)@example.test",
  '"a"@example.test',
  "a<b>@example.test",
  "a\\b@example.test",
  "a@@example.test",
  `${"a".repeat(65)}@example.test`,
  `a@${"b".repeat(64)}.test`,
  `${"a".repeat(64)}@${"b".repeat(63)}.${"c".repeat(63)}.${"d".repeat(63)}`,
])("rejects malformed required email answers and defaults: %j", (value) => {
  const field = { key: "email", type: "string", format: "email", required: true } as const;
  const request: OwnedFormRequest = { kind: "form", message: "", fields: [field] };
  expect(
    validateFormOutcome(request, { action: "accept", content: { email: value } }),
  ).toBeUndefined();
  expect(validateFormRequest({ ...request, fields: [{ ...field, default: value }] })).toBeDefined();
});

it.each([
  "\u0000https://example.test",
  "https://example.test\u0000",
  "https://example.test/\u0001path",
  "https://example.test/\u007fpath",
  "https://example.test/\u0085path",
  "https://exam\nple.test",
  "https://example.test/\tpath",
  "https://example.test\r",
  " https://example.test",
  "https://example.test/path with spaces",
  "https://example.test/\u00a0path",
  "/relative/path",
])("rejects malformed required URI answers and defaults before normalization: %j", (value) => {
  const field = { key: "uri", type: "string", format: "uri", required: true } as const;
  const request: OwnedFormRequest = { kind: "form", message: "", fields: [field] };
  expect(
    validateFormOutcome(request, { action: "accept", content: { uri: value } }),
  ).toBeUndefined();
  expect(validateFormRequest({ ...request, fields: [{ ...field, default: value }] })).toBeDefined();
});

it.each([
  ["email", "a@example.test"],
  ["email", "first.last+tag@sub-domain.example.test"],
  ["email", "O'Connor_1@example.test"],
  ["email", "user@localhost"],
  ["email", `${"a".repeat(64)}@${"b".repeat(63)}.test`],
  ["uri", "https://example.test/a%20path?x=1#section"],
  ["uri", "mailto:first.last+tag@example.test"],
  ["uri", "urn:example:item:123"],
  ["uri", "file:///tmp/example.txt"],
  ["date", "2024-02-29"],
  ["date-time", "2024-02-29T23:59:59.123+01:00"],
  ["date-time", "2024-02-29t23:59:59z"],
] as const)("preserves valid required %s answers and defaults: %s", (format, value) => {
  const field = { key: "value", type: "string", format, required: true, default: value } as const;
  const request: OwnedFormRequest = { kind: "form", message: "", fields: [field] };
  expect(validateFormRequest(request)).toBeUndefined();
  const outcome = { action: "accept", content: formContent(initialFormValues(request)) } as const;
  expect(validateFormOutcome(request, outcome)).toEqual(outcome);
  expect(validateFormOutcome(request, { action: "accept", content: {} })).toBeUndefined();
});

it("rejects conflicting bounds, duplicate options and invalid defaults", () => {
  for (const field of [
    { key: "x", type: "integer", default: 0.5 },
    { key: "x", type: "string", minLength: 3, maxLength: 1 },
    { key: "x", type: "enum", options: [{ value: "x" }, { value: "x" }] },
    { key: "x", type: "multi-enum", options: [{ value: "x" }], default: ["foreign"] },
  ] satisfies FormField[])
    expect(validateFormRequest({ kind: "form", message: "", fields: [field] })).toBeDefined();
});
