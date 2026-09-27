import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  decodeFormOutcome,
  type FormField,
  type FormOutcome,
  type FormValue,
  type OwnedFormRequest,
} from "./form-protocol.ts";

function validDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const [year = 0, month = 0, day = 0] = value.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return month >= 1 && month <= 12 && day >= 1 && day <= (days[month - 1] ?? 0);
}
/** Conservative ASCII dot-atom mailboxes and DNS labels, not full RFC 5322 syntax. */
function validEmail(value: string): boolean {
  const at = value.indexOf("@");
  if (value.length > 254 || at < 1 || at > 64 || at !== value.lastIndexOf("@") || /\s/.test(value))
    return false;
  const local = value.slice(0, at);
  const domain = value.slice(at + 1);
  return (
    domain.length <= 253 &&
    local.split(".").every((part) => /^[a-zA-Z0-9!#$%&'*+/=?^_`{|}~-]+$/.test(part)) &&
    domain
      .split(".")
      .every((label) => /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?$/.test(label))
  );
}
function validFormat(value: string, format: "email" | "uri" | "date" | "date-time"): boolean {
  switch (format) {
    case "email":
      return validEmail(value);
    case "uri":
      // URL parsing can silently trim or discard controls. Validate the original text first.
      if (
        /\s/.test(value) ||
        [...value].some((char) => {
          const code = char.charCodeAt(0);
          return code <= 32 || (code >= 127 && code <= 159);
        })
      )
        return false;
      return invokeHostCallback(() => Boolean(new URL(value).protocol), false);
    case "date":
      return validDate(value);
    case "date-time": {
      if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value))
        return false;
      if (!validDate(value.slice(0, 10))) return false;
      const hour = Number(value.slice(11, 13));
      const minute = Number(value.slice(14, 16));
      const second = Number(value.slice(17, 19));
      const offset = /([+-])(\d{2}):(\d{2})$/.exec(value);
      return (
        hour < 24 &&
        minute < 60 &&
        second < 60 &&
        (!offset || (Number(offset[2]) < 24 && Number(offset[3]) < 60))
      );
    }
  }
}
/** Fixed bounded checks only. This is not a remote JSON Schema compiler. Errors contain no values. */
export function validateFormValue(
  field: FormField,
  value: FormValue | undefined,
): string | undefined {
  if (value === undefined) return field.required ? "A value is required" : undefined;
  switch (field.type) {
    case "string": {
      if (!Predicate.isString(value)) return "Enter text";
      const length = [...value].length;
      if (
        value.length > 4096 ||
        length < (field.minLength ?? 0) ||
        length > (field.maxLength ?? 4096)
      )
        return "Text length is outside the allowed range";
      if (field.format && !validFormat(value, field.format))
        return "Text doesn't match the requested format";
      return undefined;
    }
    case "number":
    case "integer":
      if (
        !Predicate.isNumber(value) ||
        !Number.isFinite(value) ||
        (field.type === "integer" && !Number.isInteger(value))
      )
        return "Enter a valid number";
      return value < (field.minimum ?? -Infinity) || value > (field.maximum ?? Infinity)
        ? "Number is outside the allowed range"
        : undefined;
    case "boolean":
      return Predicate.isBoolean(value) ? undefined : "Choose true or false";
    case "enum":
      return Predicate.isString(value) && field.options.some((option) => option.value === value)
        ? undefined
        : "Choose one listed option";
    case "multi-enum":
      if (
        !Array.isArray(value) ||
        value.length > 64 ||
        new Set(value).size !== value.length ||
        value.some((item) => !field.options.some((option) => option.value === item))
      )
        return "Choose listed options without duplicates";
      return value.length < (field.minItems ?? 0) || value.length > (field.maxItems ?? 64)
        ? "Selection count is outside the allowed range"
        : undefined;
  }
}
export function validateFormRequest(request: OwnedFormRequest): string | undefined {
  if (request.kind === "url") {
    try {
      if (
        !new URL(request.url).host ||
        [...request.url].some(
          (char) =>
            char.charCodeAt(0) <= 32 || (char.charCodeAt(0) >= 127 && char.charCodeAt(0) <= 159),
        )
      )
        return "The URL isn't valid";
    } catch {
      return "The URL isn't valid";
    }
    return undefined;
  }
  if (new Set(request.fields.map((field) => field.key)).size !== request.fields.length)
    return "Field keys must be unique";
  for (const field of request.fields) {
    if (field.type === "string" && (field.minLength ?? 0) > (field.maxLength ?? 4096))
      return "Text length bounds conflict";
    if (
      (field.type === "number" || field.type === "integer") &&
      (field.minimum ?? -Infinity) > (field.maximum ?? Infinity)
    )
      return "Number bounds conflict";
    if (field.type === "enum" || field.type === "multi-enum") {
      if (new Set(field.options.map((option) => option.value)).size !== field.options.length)
        return "Option values must be unique";
      if (
        field.type === "multi-enum" &&
        ((field.minItems ?? 0) > (field.maxItems ?? 64) ||
          (field.minItems ?? 0) > field.options.length)
      )
        return "Selection count bounds conflict";
    }
    if (field.default !== undefined && validateFormValue(field, field.default))
      return "The default value isn't valid";
  }
  return undefined;
}
export function validateFormOutcome<Input>(
  request: OwnedFormRequest,
  input: Input,
): FormOutcome | undefined {
  const outcome = decodeFormOutcome(input);
  if (!outcome || outcome.action !== "accept") return outcome;
  if (request.kind === "url") return outcome.content === undefined ? outcome : undefined;
  const content = outcome.content ?? {};
  if (Object.keys(content).some((key) => !request.fields.some((field) => field.key === key)))
    return undefined;
  for (const field of request.fields) {
    const value = Object.hasOwn(content, field.key) ? content[field.key] : undefined;
    if (validateFormValue(field, value)) return undefined;
  }
  return { action: "accept", content };
}
export function parseFormInput(field: FormField, text: string): FormValue | undefined {
  if (field.type === "string") return text;
  if (
    (field.type === "number" || field.type === "integer") &&
    text.trim() !== "" &&
    /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?$/.test(text.trim())
  ) {
    const value = Number(text);
    return Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}
