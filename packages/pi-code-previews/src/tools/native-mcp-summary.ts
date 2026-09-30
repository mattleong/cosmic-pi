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
  sanitizeDiagnosticError,
} from "pi-cosmic-core";
import type { CompactIssue } from "./compact-issues";
import type { CompactSummary, CompactSummaryProvider } from "./compact-summary";
import { getBoundedTextContent } from "./data/results";
import { nativeMcpHeading, type NativeMcpIdentity } from "./native-mcp-subject";

const Text = Schema.String.check(Schema.isMaxLength(4096));
const Evidence = Schema.Struct({
  server: Text,
  tool: Text,
  fullOutputPath: Schema.optionalKey(Text),
});
/** Native `details`: `{ server, tool, fullOutputPath? }`. Never an operation outcome. */
export type NativeMcpEvidence = typeof Evidence.Type;
const evidenceFields = ["server", "tool", "fullOutputPath"] as const;
type EvidenceInput = Partial<Record<(typeof evidenceFields)[number], string>>;

/** Own data properties only: accessors are never invoked, and other fields are ignored. */
export function nativeMcpEvidence<Details>(details: Details): NativeMcpEvidence | undefined {
  return invokeHostCallback(() => {
    if (!Predicate.isObject(details) || Array.isArray(details)) return undefined;
    const input: EvidenceInput = {};
    for (const key of evidenceFields) {
      const descriptor = Object.getOwnPropertyDescriptor(details, key);
      if (!descriptor) continue;
      if (!("value" in descriptor)) return undefined;
      if (descriptor.value === undefined) continue;
      if (!Predicate.isString(descriptor.value)) return undefined;
      input[key] = descriptor.value;
    }
    return decodeUnknownOrUndefined(Evidence, input);
  }, undefined);
}

/** Evidence belongs to this definition: its own resource tool, or its labeled server and tool. */
function belongsTo(identity: NativeMcpIdentity, evidence: NativeMcpEvidence): boolean {
  if (identity.kind === "resource") return evidence.tool === identity.name;
  return identity.server !== undefined && identity.tool !== undefined
    ? evidence.server === identity.server && evidence.tool === identity.tool
    : `${evidence.server}/${evidence.tool}` === identity.label;
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
): NativeMcpListing | undefined {
  const [part, ...rest] = result.content;
  if (rest.length > 0 || part?.type !== "text" || part.text.length > MAX_LISTING_TEXT)
    return undefined;
  if (name === "list_mcp_resources") {
    const listing = decodeUnknownOrUndefined(ResourceListing, part.text);
    return listing && listingEvidence(listing.resources.length, listing);
  }
  const listing = decodeUnknownOrUndefined(TemplateListing, part.text);
  return listing && listingEvidence(listing.resourceTemplates.length, listing);
}

function listingEvidence(
  count: number,
  listing: Pick<typeof ResourceListing.Type, "nextCursor" | "errors">,
): NativeMcpListing {
  return { count, more: listing.nextCursor !== undefined, failures: listing.errors ?? [] };
}

/** Each bounded server failure in an aggregate listing, then how many more were not shown. */
function listingFailureIssues(listing: NativeMcpListing): CompactIssue[] {
  const issues: CompactIssue[] = [];
  for (const failure of listing.failures.slice(0, MAX_LISTED_FAILURES)) {
    const server = failure.server.trim()
      ? sanitizeDiagnosticError(failure.server, { maximumLength: 60 })
      : "A server";
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

const TRUNCATED =
  /^Warning: truncated output \(original token count: \d+\)\nTotal output lines: \d+\n\n/;
const SAVE_FAILED = "\n\n[Could not save the full output: ";

/** Native middle truncation and where, or whether, the full output was saved. */
function outputIssues(
  result: AgentToolResult<unknown>,
  evidence: NativeMcpEvidence,
): CompactIssue[] {
  const first = result.content[0];
  const envelope = first?.type === "text" && TRUNCATED.test(first.text) ? first.text : undefined;
  const truncated: CompactIssue = {
    severity: "warning",
    code: "mcp-output-truncated",
    message: "Output is truncated",
  };
  if (evidence.fullOutputPath)
    return [
      {
        ...truncated,
        detail: `Full output saved to ${sanitizeDiagnosticContent(evidence.fullOutputPath)}`,
      },
    ];
  if (envelope === undefined) return [];
  const index = envelope.lastIndexOf(SAVE_FAILED);
  if (index < 0 || !envelope.endsWith("]")) return [truncated];
  return [
    truncated,
    {
      severity: "warning",
      code: "mcp-output-save-failed",
      message: "Full output couldn't be saved",
      detail: sanitizeDiagnosticContent(envelope.slice(index + SAVE_FAILED.length, -1)),
    },
  ];
}

const MAX_ERROR_TEXT = 8192;

/** The failure's own first line; text that opens with agent guidance stays in the output. */
function errorIssue(identity: NativeMcpIdentity, result: AgentToolResult<unknown>): CompactIssue {
  const text = result.content
    .flatMap((part) => (part.type === "text" ? [part.text] : []))
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
  const line =
    part?.type === "text"
      ? part.text
          .slice(0, 1024)
          .split("\n")
          .find((entry) => entry.trim())
      : undefined;
  return line ? sanitizeDiagnosticError(line, { maximumLength: 80 }) : "";
}

/**
 * Native MCP results report delivery, not domain success: a settled call that Pi does not flag
 * as an error is `returned`. Truncation and aggregate listing failures raise warnings; results
 * whose details are missing, malformed, or foreign decline to the generic row.
 */
export const nativeMcpSummary =
  (identity: NativeMcpIdentity): CompactSummaryProvider<any, any, any> =>
  ({ phase, args, result, context }) => {
    const heading = { ...nativeMcpHeading(identity, args), showTiming: true as const };
    if (phase !== "settled") {
      const progress = nativeMcpProgress(result);
      return progress ? { ...heading, metadata: [progress] } : heading;
    }
    if (!result) return undefined;
    const evidence = nativeMcpEvidence(result.details);
    const owned = evidence && belongsTo(identity, evidence) ? evidence : undefined;
    const output = owned ? outputIssues(result, owned) : [];
    if (context.isError)
      return { ...heading, outcome: "error", issues: [errorIssue(identity, result), ...output] };
    if (!owned) return undefined;
    const summary: CompactSummary = { ...heading, outcome: "returned", issues: output };
    if (identity.kind === "tool" || identity.name === "read_mcp_resource")
      return output.length > 0 ? summary : { ...summary, counters: contentCounters(result) };
    const listing = nativeMcpListing(identity.name, result);
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
