import * as Schema from "effect/Schema";
import {
  countLabel,
  decodeUnknownOrUndefined,
  failureMessage,
  invokeHostCallback,
  isAgentGuidance,
} from "pi-cosmic-core";
import type { CompactSummaryProvider } from "./compact-summary";
import { argumentFailureIssue } from "./argument-failure";
import { hostContainer, HostContainerSchema, type HostContainer } from "../shared/untrusted-value";
import { ownData, visibleDiagnosticLine } from "./native-safe-content";

const MAX_LOADED = 256;
const Length = Schema.Natural.check(Schema.isLessThanOrEqualTo(MAX_LOADED));
const ToolName = Schema.String.check(Schema.isPattern(/\S/u), Schema.isMaxLength(256));
const Receipt = Schema.Struct({
  loaded: Schema.Array(ToolName).check(Schema.isMaxLength(MAX_LOADED)),
});
const decodeReceipt = decodeUnknownOrUndefined(Receipt);

export function nativeToolSearchReceipt(
  details: HostContainer | undefined,
): typeof Receipt.Type | undefined {
  const source = ownData(details, "loaded", HostContainerSchema);
  if (!invokeHostCallback(() => Array.isArray(source), false)) return undefined;
  const length = ownData(source, "length", Length);
  if (length === undefined) return undefined;
  const loaded = Array.from({ length }, (_, index) =>
    ownData(source, String(index), Schema.Unknown),
  );
  return decodeReceipt({ loaded });
}

export function nativeToolSearchSubject(args: HostContainer | undefined): string {
  const query = ownData(args, "query", Schema.String);
  return query === undefined ? "" : visibleDiagnosticLine(query.slice(0, 512), 160);
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
    const first = result.content.find((part) => part.type === "text");
    const text = first?.type === "text" ? first.text.slice(0, 8192) : "";
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
