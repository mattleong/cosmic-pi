import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import {
  countLabel,
  decodeUnknownOrUndefined,
  failureMessage,
  invokeHostCallback,
  isAgentGuidance,
  sanitizeDiagnosticContent,
} from "pi-cosmic-core";
import { getBoundedTextContent } from "./data/results";
import type { CompactIssue } from "./compact-issues";
import type { CompactSummary, CompactSummaryProvider } from "./compact-summary";
import { nativeMcpReceiptMatches, type NativeMcpIdentity } from "./native-mcp-identity";
import { nativeMcpArgumentText, nativeMcpHeading } from "./native-mcp-subject";
import { visibleDiagnosticLine } from "./native-safe-content";
import { nativeTruncationIssues, parseNativeTruncatedOutput } from "./native-truncation";

const Text = Schema.String.check(Schema.isMaxLength(4096));
const Evidence = Schema.Struct({
  server: Text,
  tool: Text,
  fullOutputPath: Schema.optionalKey(Text),
});
/** Native `details`: `{ server, tool, fullOutputPath? }`. Never an operation outcome. */
export type NativeMcpEvidence = typeof Evidence.Type;

/** Own data properties only: accessors are never invoked, and other fields are ignored. */
export function nativeMcpEvidence<Details>(details: Details): NativeMcpEvidence | undefined {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(details)) return undefined;
    const input: Partial<Record<string, string>> = {};
    for (const key of Object.keys(Evidence.fields)) {
      const descriptor = Object.getOwnPropertyDescriptor(details, key);
      if (!descriptor) continue;
      if (!("value" in descriptor)) return undefined;
      if (descriptor.value === undefined) continue;
      if (!Predicate.isString(descriptor.value)) return undefined;
      if (key === "fullOutputPath" && !descriptor.value.trim()) continue;
      input[key] = descriptor.value;
    }
    return decodeUnknownOrUndefined(Evidence, input);
  }, undefined);
}

/**
 * The result's native receipt, only when it matches the alias/namespace, or a resource tool and
 * its observed server.
 */
export function nativeMcpReceipt<Args>(
  identity: NativeMcpIdentity,
  result: AgentToolResult<unknown>,
  args: Args,
): NativeMcpEvidence | undefined {
  const evidence = nativeMcpEvidence(result.details);
  return evidence &&
    nativeMcpReceiptMatches(identity, evidence) &&
    (identity.kind !== "resource" || evidence.server === nativeMcpArgumentText(args, "server"))
    ? evidence
    : undefined;
}

const ListingFailure = Schema.Struct({ server: Schema.String, error: Schema.String });
const listingFields = {
  server: Schema.optionalKey(Schema.String),
  nextCursor: Schema.optionalKey(Schema.String),
  errors: Schema.optionalKey(Schema.Array(ListingFailure)),
};
const ResourceListing = Schema.fromJsonString(
  Schema.Struct({
    ...listingFields,
    resources: Schema.Array(
      Schema.Struct({ server: Schema.String, uri: Schema.String, name: Schema.String }),
    ),
  }),
);
const TemplateListing = Schema.fromJsonString(
  Schema.Struct({
    ...listingFields,
    resourceTemplates: Schema.Array(
      Schema.Struct({ server: Schema.String, uriTemplate: Schema.String, name: Schema.String }),
    ),
  }),
);
/** Native listings are one JSON text block under the 20 KB model limit unless truncated. */
const MAX_LISTING_TEXT = 64 * 1024;
const MAX_LISTED_FAILURES = 3;

interface NativeMcpListing {
  readonly count: number;
  readonly more: boolean;
  readonly failures: readonly (typeof ListingFailure.Type)[];
}

/** Only the complete native JSON envelope is listing evidence; anything else declines. */
function nativeMcpListing(
  name: "list_mcp_resources" | "list_mcp_resource_templates",
  result: AgentToolResult<unknown>,
  server: string,
): NativeMcpListing | undefined {
  const [part, ...rest] = result.content;
  if (rest.length > 0 || part?.type !== "text" || part.text.length > MAX_LISTING_TEXT)
    return undefined;
  // Decoding keeps only declared fields, so a listing has exactly one item array.
  const listing =
    name === "list_mcp_resources"
      ? decodeUnknownOrUndefined(ResourceListing, part.text)
      : decodeUnknownOrUndefined(TemplateListing, part.text);
  if (!listing || (listing.server ?? "") !== server) return undefined;
  const items = "resources" in listing ? listing.resources : listing.resourceTemplates;
  return {
    count: items.length,
    more: listing.nextCursor !== undefined,
    failures: listing.errors ?? [],
  };
}

/** Each bounded server failure in an aggregate listing, then how many more were not shown. */
function listingFailureIssues(listing: NativeMcpListing): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const failure of listing.failures.slice(0, MAX_LISTED_FAILURES)) {
    const server = visibleDiagnosticLine(failure.server, 60) || "A server";
    const reason = isAgentGuidance(failure.error) ? "" : failureMessage(failure.error, "", 100);
    const detail = sanitizeDiagnosticContent(failure.error).trim();
    const issue: CompactIssue = {
      severity: "warning",
      code: "mcp-listing-server-failed",
      message: reason ? `${server} couldn't be listed: ${reason}` : `${server} couldn't be listed`,
    };
    issues.push(detail !== "" && detail !== reason ? { ...issue, detail } : issue);
  }
  const hidden = listing.failures.length - issues.length;
  if (hidden > 0)
    issues.push({
      severity: "warning",
      code: "mcp-listing-servers-failed",
      message: `${countLabel(hidden, "more server")} couldn't be listed`,
    });
  return issues;
}

/** Only an owned, recognized, recoverable envelope may replace the raw collapsed preview. */
export function nativeMcpHasRecoverableClipping<Args>(
  identity: NativeMcpIdentity,
  result: AgentToolResult<unknown>,
  args: Args,
): boolean {
  const first = result.content[0];
  return Boolean(
    nativeMcpReceipt(identity, result, args)?.fullOutputPath &&
    first?.type === "text" &&
    parseNativeTruncatedOutput(first.text)?.footer === "saved" &&
    !result.content.slice(1).some((part) => part.type === "text"),
  );
}

/** Native middle truncation and where, or whether, the full output was saved. */
function outputIssues(
  result: AgentToolResult<unknown>,
  evidence: NativeMcpEvidence,
): CompactIssue[] {
  const first = result.content[0];
  const envelope = first?.type === "text" ? parseNativeTruncatedOutput(first.text) : undefined;
  return nativeTruncationIssues(envelope, evidence.fullOutputPath, {
    code: "mcp",
    subject: "Output",
  });
}

const MAX_ERROR_TEXT = 8192;

/**
 * The failure's own first line, read inside Pi's truncation envelope when the error was long.
 * Text that opens with agent guidance stays in the output.
 */
function errorIssue(identity: NativeMcpIdentity, result: AgentToolResult<unknown>): CompactIssue {
  const text = result.content
    .flatMap((part) =>
      part.type === "text" ? [parseNativeTruncatedOutput(part.text)?.body ?? part.text] : [],
    )
    .join("\n")
    .slice(0, MAX_ERROR_TEXT);
  const fallback =
    identity.kind === "tool" ? "The MCP tool reported an error" : "The resource request failed";
  return {
    severity: "error",
    code: "mcp-error",
    message: isAgentGuidance(text) ? fallback : failureMessage(text, fallback),
  };
}

/** Lines and images the call returned; no count when the text is beyond the counting budget. */
function contentCounters(result: AgentToolResult<unknown>): string[] {
  const text = getBoundedTextContent(result.content)?.trim();
  const images = result.content.filter((part) => part.type === "image").length;
  const labels: string[] = [];
  if (text) labels.push(countLabel(text.split("\n").length, "line"));
  if (images > 0) labels.push(countLabel(images, "image"));
  const [first] = labels;
  return labels.length > 1 && first ? [labels.join(", "), first] : labels;
}

/** A running call's latest native progress message, one bounded plain line. */
export function nativeMcpProgress(result: AgentToolResult<unknown> | undefined): string {
  const part = result?.content.find((entry) => entry.type === "text");
  const text = part?.type === "text" ? part.text.slice(0, 1024) : "";
  // Redact only up to the first visible line; this runs on every animation frame.
  for (const line of text.split("\n")) {
    const visible = visibleDiagnosticLine(line, 80);
    if (visible) return visible;
  }
  return "";
}

/**
 * Native MCP results report delivery, not domain success: a settled call that Pi does not flag
 * as an error is `returned`. Recoverable clipping is informational; unsaved output and aggregate
 * listing failures raise warnings. Missing, malformed, or foreign details decline to the generic row.
 */
export const nativeMcpSummary =
  (identity: NativeMcpIdentity): CompactSummaryProvider<any, any, any> =>
  ({ phase, args, result, context }) => {
    const pending = { ...nativeMcpHeading(identity, args), showTiming: true as const };
    if (phase !== "settled") {
      const progress = nativeMcpProgress(result);
      return progress ? { ...pending, metadata: [progress] } : pending;
    }
    if (!result) return undefined;
    const owned = nativeMcpReceipt(identity, result, args);
    const heading = { ...nativeMcpHeading(identity, args, owned), showTiming: true as const };
    const output = owned ? outputIssues(result, owned) : [];
    if (context.isError)
      return { ...heading, outcome: "error", issues: [errorIssue(identity, result), ...output] };
    if (!owned) return undefined;
    const summary: CompactSummary = { ...heading, outcome: "returned", issues: output };
    if (identity.kind === "tool" || identity.name === "read_mcp_resource")
      return output.length > 0 ? summary : { ...summary, counters: contentCounters(result) };
    const listing = nativeMcpListing(identity.name, result, owned.server);
    const noun = identity.name === "list_mcp_resources" ? "resource" : "template";
    if (!listing)
      // A truncated or replaced aggregate listing can hide the servers that failed.
      return owned.server === ""
        ? {
            ...summary,
            issues: [
              ...output,
              {
                severity: "warning",
                code: "mcp-listing-unverified",
                message: "Listing failures couldn't be checked",
              },
            ],
          }
        : summary;
    return {
      ...summary,
      counters: [countLabel(listing.count, noun)],
      issues: [
        ...listingFailureIssues(listing),
        ...output,
        ...(listing.more
          ? [
              {
                severity: "info" as const,
                code: "mcp-listing-more",
                message: `More ${noun}s are available`,
              },
            ]
          : []),
      ],
    };
  };
