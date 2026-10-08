import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined, sanitizeTerminalLine } from "pi-cosmic-core";

export const COSMIC_UI_PROTOCOL_VERSION = 2 as const;
export const COSMIC_UI_HOST_QUERY = "cosmic-ui:v2:host:query";
export const COSMIC_UI_HOST_STATE = "cosmic-ui:v2:host:state";
export const COSMIC_UI_FOOTER_UPSERT = "cosmic-ui:v2:footer:upsert";
export const COSMIC_UI_FOOTER_REMOVE = "cosmic-ui:v2:footer:remove";

const Tone = Schema.Literals(["normal", "accent", "dim", "success", "warning", "error"]);
const Region = Schema.Literals(["identity", "metrics", "details"]);
type CosmicFooterTone = typeof Tone.Type;
type CosmicFooterRegion = typeof Region.Type;
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
export interface CosmicFooterTextContribution {
  kind: "text";
  id: string;
  region: CosmicFooterRegion;
  text: string;
  compactText?: string;
  align?: "left" | "right";
  tone?: CosmicFooterTone;
  priority?: number;
  order?: number;
  /** Line label; details entries with a label render as their own labeled line. */
  label?: string;
  /** Valid Pi theme color token; tones warning/error still take precedence. */
  color?: CosmicFooterColor;
  /**
   * Id of another text entry this one decorates: this entry's text is prefixed
   * onto the target instead of rendering separately. Renders standalone when
   * the target entry is absent.
   */
  decorates?: string;
}
/**
 * Declares footer placement for a host status entry published through
 * `ctx.ui.setStatus`. `id` is the host status key; the status text keeps
 * flowing through the host, so the status still renders without a Cosmic host.
 * Undeclared status entries fall back to generic defaults.
 */
export interface CosmicFooterStatusContribution {
  kind: "status";
  id: string;
  region: CosmicFooterRegion;
  align?: "left" | "right";
  priority?: number;
  order?: number;
}
export type CosmicFooterContribution =
  | CosmicFooterTextContribution
  | CosmicFooterStatusContribution;

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

export interface CosmicUiHostState {
  /** True only while Cosmic UI owns the live custom-footer slot. */
  active: boolean;
  /** Visibility preferences have loaded for the current session. */
  ready: boolean;
  /** Hidden contribution IDs, also respected by provider status fallback and polling. */
  hidden: readonly string[];
}

export interface CosmicUiHostQuery {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
  respond(state: CosmicUiHostState): void;
}
export interface CosmicUiHostStateEvent extends CosmicUiHostState {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
}
export interface CosmicFooterUpsertEvent {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
  owner: string;
  contribution: CosmicFooterContribution;
}
export interface CosmicFooterRemoveEvent {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
  owner: string;
  id?: string;
}

const Version = Schema.Literal(COSMIC_UI_PROTOCOL_VERSION);
const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const HostQueryData = Schema.Struct({ version: Version, respond: Schema.Unknown });
const HostStateData = Schema.Struct({
  version: Version,
  active: Schema.Boolean,
  ready: Schema.Boolean,
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
  label: Schema.optional(NonEmpty),
  color: Schema.optional(Schema.Literals(COSMIC_FOOTER_COLOR_TOKENS)),
  decorates: Schema.optional(NonEmpty),
});
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
    // SAFETY: Boundary decoding validates the value; optional fields decode as possibly undefined.
    contribution: detachCosmicFooterContribution(contribution as CosmicFooterContribution),
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
