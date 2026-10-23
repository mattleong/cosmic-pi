import type { ThemeColor } from "@earendil-works/pi-coding-agent";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Schema from "effect/Schema";
import type * as Types from "effect/Types";
import {
  decodeUnknownOrUndefined,
  ForeignCallable,
  invokeBestEffort,
  sanitizeTerminalLine,
} from "pi-cosmic-core";

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
  "scrollbarTrack",
  "scrollbarThumb",
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
// An invalid optional field falls back to its default so one bad optional hint does not
// withdraw the whole contribution.
const optionalOrDefault = <S extends Schema.Top>(schema: S) =>
  Schema.optional(schema.pipe(Schema.catchDecoding(() => Effect.succeedNone)));
const HostQueryData = Schema.Struct({
  version: Version,
  respond: ForeignCallable<[state: CosmicUiHostState]>(),
});
const HostStateData = Schema.Struct({
  version: Version,
  active: Schema.Boolean,
  ready: Schema.Boolean,
  hidden: Schema.Array(Schema.String),
});
const placementFields = {
  id: NonEmpty,
  region: Region,
  align: optionalOrDefault(Schema.Literals(["left", "right"])),
  priority: optionalOrDefault(Schema.Finite),
  order: optionalOrDefault(Schema.Finite),
};
const TextContributionData = Schema.Struct({
  kind: Schema.Literal("text"),
  ...placementFields,
  text: Schema.String,
  compactText: optionalOrDefault(Schema.String),
  tone: optionalOrDefault(Tone),
  label: optionalOrDefault(NonEmpty),
  color: optionalOrDefault(Schema.Literals(COSMIC_FOOTER_COLOR_TOKENS)),
  decorates: optionalOrDefault(NonEmpty),
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

export type CosmicFooterTextContribution = Types.Mutable<typeof TextContributionData.Type>;
export type CosmicFooterStatusContribution = Types.Mutable<typeof StatusContributionData.Type>;
export type CosmicFooterUpsertEvent = Types.DeepMutable<typeof UpsertData.Type>;
export type CosmicFooterContribution = CosmicFooterUpsertEvent["contribution"];
export type CosmicFooterRemoveEvent = Types.Mutable<typeof RemoveData.Type>;
export type CosmicUiHostStateEvent = Types.Mutable<typeof HostStateData.Type>;
export type CosmicUiHostState = Omit<CosmicUiHostStateEvent, "version">;

const canonicalContributions = new WeakSet<CosmicFooterContribution>();

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

const hostQuery = (query: typeof HostQueryData.Type | undefined): CosmicUiHostQuery | undefined => {
  if (!query) return undefined;
  const respond = query.respond;
  return Object.freeze({
    version: query.version,
    respond: (state: CosmicUiHostState) =>
      invokeBestEffort(() => respond.call(query, Object.freeze(detachHostState(state)))),
  });
};

export const normalizeCosmicUiHostQuery = Fn.flow(
  decodeUnknownOrUndefined(HostQueryData),
  hostQuery,
);

const hostStateEvent = (
  event: typeof HostStateData.Type | undefined,
): CosmicUiHostStateEvent | undefined =>
  event && Object.freeze({ version: event.version, ...detachHostState(event) });

export const normalizeCosmicUiHostStateEvent = Fn.flow(
  decodeUnknownOrUndefined(HostStateData),
  hostStateEvent,
);

const footerUpsertEvent = (
  event: typeof UpsertData.Type | undefined,
): CosmicFooterUpsertEvent | undefined => {
  if (!event) return undefined;
  let contribution = event.contribution;
  if (contribution.kind === "text") {
    const { text, compactText, label, ...rest } = contribution;
    // A label only groups the text onto its own line, so one that cleans to nothing leaves the
    // contribution unlabeled rather than withdrawing its text.
    const sanitizedLabel = label === undefined ? "" : sanitizeTerminalLine(label);
    contribution = {
      ...rest,
      text: sanitizeTerminalLine(text),
      ...(compactText !== undefined && { compactText: sanitizeTerminalLine(compactText) }),
      ...(sanitizedLabel !== "" && { label: sanitizedLabel }),
    };
  }
  return Object.freeze({
    version: event.version,
    owner: event.owner,
    contribution: detachCosmicFooterContribution(contribution),
  });
};

export const normalizeCosmicFooterUpsertEvent = Fn.flow(
  decodeUnknownOrUndefined(UpsertData),
  footerUpsertEvent,
);

const footerRemoveEvent = (
  event: typeof RemoveData.Type | undefined,
): CosmicFooterRemoveEvent | undefined => {
  if (!event) return undefined;
  const { version, owner, id } = event;
  return Object.freeze({ version, owner, ...(id !== undefined && { id }) });
};

export const normalizeCosmicFooterRemoveEvent = Fn.flow(
  decodeUnknownOrUndefined(RemoveData),
  footerRemoveEvent,
);
