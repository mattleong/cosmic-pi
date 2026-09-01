import * as Predicate from "effect/Predicate";
import * as Schema from "effect/Schema";
import { sanitizeTerminalLine } from "pi-cosmic-core";
import { decodeUnknownOrUndefined } from "../schema/decode.ts";
import {
  detachCosmicFooterContribution,
  detachCosmicFooterContributionFromReceiver,
} from "./canonicalization.ts";

export const COSMIC_UI_PROTOCOL_VERSION = 1 as const;
export const COSMIC_UI_HOST_QUERY = "cosmic-ui:v1:host:query";
export const COSMIC_UI_FOOTER_UPSERT = "cosmic-ui:v1:footer:upsert";
export const COSMIC_UI_FOOTER_REMOVE = "cosmic-ui:v1:footer:remove";
export const COSMIC_UI_FOOTER_INVALIDATE = "cosmic-ui:v1:footer:invalidate";

export type CosmicFooterTone = "normal" | "accent" | "dim" | "success" | "warning" | "error";
export type CosmicFooterRegion = "identity" | "metrics" | "details" | "media";
export type CosmicFooterPlacement =
  | "stacked"
  | "inline-left"
  | "inline-right"
  | "badge"
  | "habitat";

export interface CosmicFooterTheme {
  fg(color: string, value: string): string;
}
export interface CosmicFooterSurfaceRenderOptions {
  width: number;
  placement: CosmicFooterPlacement;
  theme: CosmicFooterTheme;
}
export interface CosmicFooterTextContribution {
  kind: "text";
  id: string;
  region: Exclude<CosmicFooterRegion, "media">;
  text: string;
  compactText?: string;
  align?: "left" | "right";
  tone?: CosmicFooterTone;
  priority?: number;
  order?: number;
  /** Line label; details entries with a label render as their own labeled line. */
  label?: string;
  /** Theme color token; tones warning/error still take precedence. */
  color?: string;
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
  region: Exclude<CosmicFooterRegion, "media">;
  align?: "left" | "right";
  priority?: number;
  order?: number;
}
export interface CosmicFooterSurfaceContribution {
  kind: "surface";
  id: string;
  region: "media";
  preferredWidth: number;
  preferredPlacement?: CosmicFooterPlacement;
  attach?(host: { requestRender(): void }): void;
  detach?(): void;
  render(options: CosmicFooterSurfaceRenderOptions): string[];
  invalidate?(): void;
  dispose?(): void;
}
export type CosmicFooterContribution =
  | CosmicFooterTextContribution
  | CosmicFooterStatusContribution
  | CosmicFooterSurfaceContribution;

export { detachCosmicFooterContribution };

export interface CosmicUiHostQuery {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
  respond(): void;
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
export interface CosmicFooterInvalidateEvent {
  version: typeof COSMIC_UI_PROTOCOL_VERSION;
  owner?: string;
  id?: string;
}

const NonEmpty = Schema.String.check(Schema.isNonEmpty());
const HostQueryData = Schema.Struct({
  version: Schema.Literal(COSMIC_UI_PROTOCOL_VERSION),
  respond: Schema.Unknown,
});
const TextContributionData = Schema.Struct({
  kind: Schema.Literal("text"),
  id: NonEmpty,
  region: Schema.Literals(["identity", "metrics", "details"]),
  text: Schema.String,
  compactText: Schema.optional(Schema.String),
  align: Schema.optional(Schema.Literals(["left", "right"])),
  tone: Schema.optional(
    Schema.Literals(["normal", "accent", "dim", "success", "warning", "error"]),
  ),
  priority: Schema.optional(Schema.Number),
  order: Schema.optional(Schema.Number),
  label: Schema.optional(NonEmpty),
  color: Schema.optional(NonEmpty),
  decorates: Schema.optional(NonEmpty),
});
const StatusContributionData = Schema.Struct({
  kind: Schema.Literal("status"),
  id: NonEmpty,
  region: Schema.Literals(["identity", "metrics", "details"]),
  align: Schema.optional(Schema.Literals(["left", "right"])),
  priority: Schema.optional(Schema.Number),
  order: Schema.optional(Schema.Number),
});
const SurfaceContributionData = Schema.Struct({
  kind: Schema.Literal("surface"),
  id: NonEmpty,
  region: Schema.Literal("media"),
  preferredWidth: Schema.Number,
  preferredPlacement: Schema.optional(
    Schema.Literals(["stacked", "inline-left", "inline-right", "badge", "habitat"]),
  ),
  attach: Schema.optional(Schema.Unknown),
  detach: Schema.optional(Schema.Unknown),
  render: Schema.Unknown,
  invalidate: Schema.optional(Schema.Unknown),
  dispose: Schema.optional(Schema.Unknown),
});
const UpsertData = Schema.Struct({
  version: Schema.Literal(COSMIC_UI_PROTOCOL_VERSION),
  owner: NonEmpty,
  contribution: Schema.Union([
    TextContributionData,
    StatusContributionData,
    SurfaceContributionData,
  ]),
});
const RemoveData = Schema.Struct({
  version: Schema.Literal(COSMIC_UI_PROTOCOL_VERSION),
  owner: NonEmpty,
  id: Schema.optional(NonEmpty),
});
const InvalidateData = Schema.Struct({
  version: Schema.Literal(COSMIC_UI_PROTOCOL_VERSION),
  owner: Schema.optional(NonEmpty),
  id: Schema.optional(NonEmpty),
});

const optionalFunction = <Value>(value: Value) =>
  value === undefined || Predicate.isFunction(value);

type DecodedUpsert = typeof UpsertData.Type;
interface DecodedUpsertWithReceiver {
  readonly event: DecodedUpsert;
  readonly callbackReceiver: object;
}

const decodeUpsertSafely = <Value>(value: Value): DecodedUpsertWithReceiver | undefined => {
  try {
    if (!Predicate.isObject(value)) return undefined;
    const input = {
      version: value.version,
      owner: value.owner,
      contribution: value.contribution,
    };
    if (!Predicate.isObject(input.contribution)) return undefined;
    const event = decodeUnknownOrUndefined(UpsertData, input);
    return event === undefined ? undefined : { event, callbackReceiver: input.contribution };
  } catch {
    return undefined;
  }
};

const decodeSafely = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  try {
    return decodeUnknownOrUndefined(schema, value);
  } catch {
    return undefined;
  }
};

/**
 * Reads every hostile query field exactly once and returns a detached plain snapshot.
 * Callers at the event-bus boundary must invoke this through HostCallbackBoundary.
 */
export function normalizeCosmicUiHostQuery<ValueInput>(
  value: ValueInput,
): CosmicUiHostQuery | undefined {
  const query = decodeSafely(HostQueryData, value);
  if (!query || !Predicate.isFunction(query.respond)) return undefined;
  const respond = query.respond;
  return Object.freeze({
    version: query.version,
    respond: () => {
      Function.prototype.apply.call(respond, query, []);
    },
  });
}

/** Reads every hostile upsert field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterUpsertEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterUpsertEvent | undefined {
  const decoded = decodeUpsertSafely(value);
  if (!decoded) return undefined;
  const { event, callbackReceiver } = decoded;
  const contribution = event.contribution;
  if (contribution.kind === "text" || contribution.kind === "status") {
    if (
      (contribution.priority !== undefined && !Number.isFinite(contribution.priority)) ||
      (contribution.order !== undefined && !Number.isFinite(contribution.order))
    )
      return undefined;
  } else if (
    !Number.isFinite(contribution.preferredWidth) ||
    contribution.preferredWidth <= 0 ||
    !Predicate.isFunction(contribution.render) ||
    !optionalFunction(contribution.attach) ||
    !optionalFunction(contribution.detach) ||
    !optionalFunction(contribution.invalidate) ||
    !optionalFunction(contribution.dispose)
  )
    return undefined;
  if (contribution.kind === "text") {
    const { text, compactText, label, ...rest } = contribution;
    const sanitizedLabel = label === undefined ? undefined : sanitizeTerminalLine(label);
    if (sanitizedLabel === "") return undefined;
    const detached = {
      ...rest,
      text: sanitizeTerminalLine(text),
    };
    if (compactText !== undefined)
      Object.assign(detached, { compactText: sanitizeTerminalLine(compactText) });
    if (sanitizedLabel !== undefined) Object.assign(detached, { label: sanitizedLabel });
    // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
    return Object.freeze({
      version: event.version,
      owner: event.owner,
      contribution: detachCosmicFooterContribution(detached as CosmicFooterContribution),
    }) as CosmicFooterUpsertEvent;
  }
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  return Object.freeze({
    version: event.version,
    owner: event.owner,
    contribution: detachCosmicFooterContributionFromReceiver(
      contribution as CosmicFooterContribution,
      { value: callbackReceiver },
    ),
  }) as CosmicFooterUpsertEvent;
}

/** Reads every hostile remove field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterRemoveEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterRemoveEvent | undefined {
  const event = decodeSafely(RemoveData, value);
  if (!event) return undefined;
  const snapshot: CosmicFooterRemoveEvent = {
    version: event.version,
    owner: event.owner,
  };
  if (event.id !== undefined) snapshot.id = event.id;
  return Object.freeze(snapshot);
}

/** Reads every hostile invalidation field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterInvalidateEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterInvalidateEvent | undefined {
  const event = decodeSafely(InvalidateData, value);
  if (!event) return undefined;
  const snapshot: CosmicFooterInvalidateEvent = { version: event.version };
  if (event.owner !== undefined) snapshot.owner = event.owner;
  if (event.id !== undefined) snapshot.id = event.id;
  return Object.freeze(snapshot);
}
