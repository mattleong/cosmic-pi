import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import { decodeUnknownOrUndefined, sanitizeTerminalLine } from "pi-cosmic-core";

export const COSMIC_UI_PROTOCOL_VERSION = 2 as const;
export const COSMIC_UI_HOST_QUERY = "cosmic-ui:v2:host:query";
export const COSMIC_UI_HOST_STATE = "cosmic-ui:v2:host:state";
export const COSMIC_UI_FOOTER_UPSERT = "cosmic-ui:v2:footer:upsert";
export const COSMIC_UI_FOOTER_REMOVE = "cosmic-ui:v2:footer:remove";

const Tone = Schema.Literals(["normal", "accent", "dim", "success", "warning", "error"]);
const Region = Schema.Literals(["identity", "metrics", "details"]);
const COSMIC_FOOTER_COLOR_TOKENS = [
  "accent",
  "border",
  "borderAccent",
  "borderMuted",
  "success",
  "error",
  "warning",
  "muted",
  "dim",
  "text",
  "thinkingText",
  "searchMatchText",
  "userMessageText",
  "customMessageText",
  "customMessageLabel",
  "toolTitle",
  "toolOutput",
  "mdHeading",
  "mdLink",
  "mdLinkUrl",
  "mdCode",
  "mdCodeBlock",
  "mdCodeBlockBorder",
  "mdQuote",
  "mdQuoteBorder",
  "mdHr",
  "mdListBullet",
  "toolDiffAdded",
  "toolDiffRemoved",
  "toolDiffContext",
  "syntaxComment",
  "syntaxKeyword",
  "syntaxFunction",
  "syntaxVariable",
  "syntaxString",
  "syntaxNumber",
  "syntaxType",
  "syntaxOperator",
  "syntaxPunctuation",
  "thinkingOff",
  "thinkingMinimal",
  "thinkingLow",
  "thinkingMedium",
  "thinkingHigh",
  "thinkingXhigh",
  "thinkingMax",
  "bashMode",
] as const satisfies ReadonlyArray<ThemeColor>;
export type CosmicFooterColor = (typeof COSMIC_FOOTER_COLOR_TOKENS)[number];

export interface CosmicFooterTheme {
  fg(color: CosmicFooterColor, value: string): string;
}
export interface CosmicUiHostQuery {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
  respond(state: CosmicUiHostState): void;
}

const Version = Schema.Literal(COSMIC_UI_PROTOCOL_VERSION);
const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const HostQueryData = Schema.Struct({ version: Version, respond: Schema.Unknown });
const HostStateData = Schema.Struct({
  version: Version,
  /** True only while Cosmic UI owns the live custom-footer slot. */
  active: Schema.Boolean,
  /** Visibility preferences have loaded for the current session. */
  ready: Schema.Boolean,
  /** Hidden contribution IDs, also respected by provider status fallback and polling. */
  hidden: Schema.Array(Schema.String),
});
/** Placement shared by text and status contributions. */
const placementFields = {
  id: NonEmpty,
  region: Region,
  align: Schema.optional(Schema.Literals(["left", "right"])),
  priority: Schema.optional(Schema.Finite),
  order: Schema.optional(Schema.Finite),
};
const TextContributionData = Schema.Struct({
  kind: Schema.Literal("text"),
  ...placementFields,
  text: Schema.String,
  compactText: Schema.optional(Schema.String),
  tone: Schema.optional(Tone),
  /** Line label; details entries with a label render as their own labeled line. */
  label: Schema.optional(NonEmpty),
  /** Valid Pi theme color token; tones warning/error still take precedence. */
  color: Schema.optional(Schema.Literals(COSMIC_FOOTER_COLOR_TOKENS)),
  /**
   * Id of another text entry this one decorates: this entry's text is prefixed
   * onto the target instead of rendering separately. Renders standalone when
   * the target entry is absent.
   */
  decorates: Schema.optional(NonEmpty),
});
/**
 * Declares footer placement for a host status entry published through
 * `ctx.ui.setStatus`. `id` is the host status key; the status text keeps
 * flowing through the host, so the status still renders without a Cosmic host.
 * Undeclared status entries fall back to generic defaults.
 */
const StatusContributionData = Schema.Struct({
  kind: Schema.Literal("status"),
  ...placementFields,
});
const UpsertData = Schema.Struct({
  version: Version,
  owner: NonEmpty,
  contribution: Schema.Union([TextContributionData, StatusContributionData]),
});
const RemoveData = Schema.Struct({
  version: Version,
  owner: NonEmpty,
  id: Schema.optional(NonEmpty),
});

// Producers may update their own values; normalization still detaches and freezes them.
export type CosmicFooterTextContribution = Types.Mutable<typeof TextContributionData.Type>;
export type CosmicFooterStatusContribution = Types.Mutable<typeof StatusContributionData.Type>;
export type CosmicFooterUpsertEvent = Types.DeepMutable<typeof UpsertData.Type>;
export type CosmicFooterContribution = CosmicFooterUpsertEvent["contribution"];
export type CosmicFooterRemoveEvent = Types.Mutable<typeof RemoveData.Type>;
export type CosmicUiHostStateEvent = Types.Mutable<typeof HostStateData.Type>;
export type CosmicUiHostState = Omit<CosmicUiHostStateEvent, "version">;

const canonicalContributions = new WeakSet<CosmicFooterContribution>();

/** Returns one detached, frozen contribution. Already-normalized values retain their identity. */
export const detachCosmicFooterContribution = (
  contribution: CosmicFooterContribution,
): CosmicFooterContribution => {
  if (canonicalContributions.has(contribution)) return contribution;
  const detached = Object.freeze({ ...contribution });
  canonicalContributions.add(detached);
  return detached;
};

const detachHostState = ({ active, ready, hidden }: CosmicUiHostState) => ({
  active,
  ready,
  hidden: Object.freeze([...hidden]),
});

/**
 * Reads every hostile query field exactly once and returns a detached plain snapshot.
 * Callers at the event-bus boundary must invoke this through core's `invokeHostCallback`.
 */
export function normalizeCosmicUiHostQuery<ValueInput>(
  value: ValueInput,
): CosmicUiHostQuery | undefined {
  const query = decodeUnknownOrUndefined(HostQueryData, value);
  if (!query || !Predicate.isFunction(query.respond)) return undefined;
  const respond = query.respond;
  return Object.freeze({
    version: query.version,
    respond: (state: CosmicUiHostState) =>
      void Function.prototype.apply.call(respond, query, [Object.freeze(detachHostState(state))]),
  });
}

/** Reads every hostile host-state field exactly once into a detached plain snapshot. */
export function normalizeCosmicUiHostStateEvent<ValueInput>(
  value: ValueInput,
): CosmicUiHostStateEvent | undefined {
  const event = decodeUnknownOrUndefined(HostStateData, value);
  return event && Object.freeze({ version: event.version, ...detachHostState(event) });
}

/** Reads every hostile upsert field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterUpsertEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterUpsertEvent | undefined {
  const event = decodeUnknownOrUndefined(UpsertData, value);
  if (!event) return undefined;
  let contribution = event.contribution;
  if (contribution.kind === "text") {
    const { text, compactText, label, ...rest } = contribution;
    const sanitizedLabel = label === undefined ? undefined : sanitizeTerminalLine(label);
    if (sanitizedLabel === "") return undefined;
    contribution = {
      ...rest,
      text: sanitizeTerminalLine(text),
      ...(compactText !== undefined && { compactText: sanitizeTerminalLine(compactText) }),
      ...(sanitizedLabel !== undefined && { label: sanitizedLabel }),
    };
  }
  return Object.freeze({
    version: event.version,
    owner: event.owner,
    contribution: detachCosmicFooterContribution(contribution),
  });
}

/** Reads every hostile remove field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterRemoveEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterRemoveEvent | undefined {
  const event = decodeUnknownOrUndefined(RemoveData, value);
  if (!event) return undefined;
  const { version, owner, id } = event;
  return Object.freeze({ version, owner, ...(id !== undefined && { id }) });
}
