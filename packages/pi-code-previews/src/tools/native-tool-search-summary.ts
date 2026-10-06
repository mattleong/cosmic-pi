import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  countLabel,
  decodeUnknownOrUndefined,
  failureMessage,
  invokeHostCallback,
  isAgentGuidance,
  sanitizeDiagnosticError,
} from "pi-cosmic-core";
import type { CompactSummaryProvider } from "./compact-summary";

const MAX_LOADED = 256;
const ToolName = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const Receipt = Schema.Struct({
  loaded: Schema.Array(ToolName).check(Schema.isMaxLength(MAX_LOADED)),
});

/** Only bounded own data from Pi's receipt, never accessors or unrelated recovery fields. */
export function nativeToolSearchReceipt<Details>(
  details: Details,
): typeof Receipt.Type | undefined {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(details) || Array.isArray(details)) return undefined;
    const descriptor = Object.getOwnPropertyDescriptor(details, "loaded");
    if (!descriptor || !("value" in descriptor) || !Array.isArray(descriptor.value))
      return undefined;
    const source = descriptor.value;
    const length = Object.getOwnPropertyDescriptor(source, "length")?.value;
    if (!Number.isSafeInteger(length) || length < 0 || length > MAX_LOADED) return undefined;
    const loaded: string[] = [];
    for (let index = 0; index < length; index++) {
      const entry = Object.getOwnPropertyDescriptor(source, String(index));
      if (!entry || !("value" in entry) || !Predicate.isString(entry.value)) return undefined;
      if (entry.value.length > 256 || !entry.value.trim()) return undefined;
      loaded.push(entry.value);
    }
    return decodeUnknownOrUndefined(Receipt, { loaded });
  }, undefined);
}

/** Argument-only subject; complete arguments remain available on expansion. */
export function nativeToolSearchSubject<Args>(args: Args): string {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(args)) return "";
    const query = Object.getOwnPropertyDescriptor(args, "query");
    if (!query || !("value" in query) || !Predicate.isString(query.value)) return "";
    return sanitizeDiagnosticError(query.value.slice(0, 512), { maximumLength: 160 });
  }, "");
}

/** A historical loaded receipt is not evidence of the current active set or domain success. */
export const nativeToolSearchSummary: CompactSummaryProvider = ({
  phase,
  args,
  result,
  context,
}) => {
  const heading = { subject: nativeToolSearchSubject(args), showTiming: true as const };
  if (phase !== "settled") return heading;
  if (!result) return undefined;
  if (context.isError) {
    const first = result.content.find((part) => part.type === "text");
    const text = first?.type === "text" ? first.text.slice(0, 8192) : "";
    const fallback = "Tool search failed";
    return {
      ...heading,
      outcome: "error",
      issues: [
        {
          severity: "error",
          code: "tool-search-error",
          message: isAgentGuidance(text) ? fallback : failureMessage(text, fallback),
        },
      ],
    };
  }
  const receipt = nativeToolSearchReceipt(result.details);
  return receipt
    ? {
        ...heading,
        outcome: "returned",
        counters: [`${countLabel(receipt.loaded.length, "tool")} listed`],
      }
    : undefined;
};
