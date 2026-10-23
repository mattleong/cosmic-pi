import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import {
  countLabel,
  decodeUnknownOrUndefined,
  failureMessage,
  invokeHostCallback,
  isAgentGuidance,
} from "pi-cosmic-core";
import type { CompactSummaryProvider } from "./compact-summary";
import { argumentFailureIssue } from "./argument-failure";
import { hostContainer, type HostContainer } from "../shared/untrusted-value";
import {
  ownContainer,
  ownDataReader,
  ownString,
  visibleDiagnosticLine,
} from "./native-safe-content";

const MAX_LOADED = 256;
const Length = Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_LOADED));
const ToolName = Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(256));
const Receipt = Schema.Struct({
  loaded: Schema.Array(ToolName).check(Schema.isMaxLength(MAX_LOADED)),
});
const decodeReceipt = decodeUnknownOrUndefined(Receipt);
const ownLength = ownDataReader(Length);
const ownValue = ownDataReader(Schema.Unknown);

export function nativeToolSearchReceipt(
  details: HostContainer | undefined,
): typeof Receipt.Type | undefined {
  const source = ownContainer(details, "loaded");
  if (!invokeHostCallback(() => Arr.isArray(source), false)) return undefined;
  const length = ownLength(source, "length");
  if (length === undefined) return undefined;
  const loaded = Array.from({ length }, (_, index) => ownValue(source, String(index)));
  return decodeReceipt({ loaded });
}

export function nativeToolSearchSubject(args: HostContainer | undefined): string {
  const query = ownString(args, "query");
  return query === undefined ? "" : visibleDiagnosticLine(Fn.pipe(query, Str.slice(0, 512)), 160);
}

export const nativeToolSearchSummary: CompactSummaryProvider = ({
  phase,
  args,
  result,
  context,
}) => {
  const heading = {
    subject: nativeToolSearchSubject(hostContainer(args)),
    showTiming: true as const,
  };
  if (phase !== "settled") return heading;
  if (!result) return undefined;
  if (context.isError) {
    const first = Option.getOrUndefined(
      Arr.findFirst(result.content, (part) => part.type === "text"),
    );
    const text = first?.type === "text" ? Fn.pipe(first.text, Str.slice(0, 8192)) : "";
    const fallback = "Tool search failed";
    return {
      ...heading,
      outcome: "error",
      issues: [
        argumentFailureIssue(text) ?? {
          severity: "error",
          code: "tool-search-error",
          message: isAgentGuidance(text) ? fallback : failureMessage(text, fallback),
        },
      ],
    };
  }
  const receipt = nativeToolSearchReceipt(hostContainer(result.details));
  return receipt
    ? {
        ...heading,
        outcome: "returned",
        counters: [`${countLabel(receipt.loaded.length, "tool")} listed`],
      }
    : undefined;
};
