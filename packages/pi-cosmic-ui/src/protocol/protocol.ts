import * as Predicate from "effect/Predicate";

import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { sanitizeTerminalLine } from "pi-cosmic-core";

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
const decode = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));

const decodeSafely = <S extends Schema.ConstraintDecoder<unknown>, Value>(
  schema: S,
  value: Value,
): S["Type"] | undefined => {
  try {
    return decode(schema, value);
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
  return Object.freeze({ version: query.version, respond: () => respond() });
}

/** Reads every hostile upsert field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterUpsertEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterUpsertEvent | undefined {
  const event = decodeSafely(UpsertData, value);
  if (!event) return undefined;
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
      contribution: Object.freeze(detached),
    }) as CosmicFooterUpsertEvent;
  }
  // SAFETY: Boundary decoding validates the value before it is narrowed to this declared contract.
  return Object.freeze({
    version: event.version,
    owner: event.owner,
    contribution: Object.freeze({ ...contribution }),
  }) as CosmicFooterUpsertEvent;
}

/** Reads every hostile remove field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterRemoveEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterRemoveEvent | undefined {
  const event = decode(RemoveData, value);
  if (!event) return undefined;
  return Object.freeze(
    (() => {
      const objectPart8792_0 = { version: event.version, owner: event.owner };
      const objectPart8792_1 =
        event.id === undefined ? objectPart8792_0 : { ...objectPart8792_0, id: event.id };
      return objectPart8792_1;
    })(),
  );
}

/** Reads every hostile invalidation field exactly once into a detached plain snapshot. */
export function normalizeCosmicFooterInvalidateEvent<ValueInput>(
  value: ValueInput,
): CosmicFooterInvalidateEvent | undefined {
  const event = decode(InvalidateData, value);
  if (!event) return undefined;
  return Object.freeze(
    (() => {
      const objectPart9257_0 = { version: event.version };
      const objectPart9257_1 =
        event.owner === undefined ? objectPart9257_0 : { ...objectPart9257_0, owner: event.owner };
      const objectPart9257_2 =
        event.id === undefined ? objectPart9257_1 : { ...objectPart9257_1, id: event.id };
      return objectPart9257_2;
    })(),
  );
}

const isNormalized = <A, Value>(
  normalize: <Input>(value: Input) => A | undefined,
  value: Value,
): value is Value & A => {
  try {
    return normalize(value) !== undefined;
  } catch {
    return false;
  }
};

export function isCosmicUiHostQuery<ValueInput>(
  value: ValueInput,
): value is ValueInput & CosmicUiHostQuery {
  return isNormalized(normalizeCosmicUiHostQuery, value);
}
export function isCosmicFooterUpsertEvent<ValueInput>(
  value: ValueInput,
): value is ValueInput & CosmicFooterUpsertEvent {
  return isNormalized(normalizeCosmicFooterUpsertEvent, value);
}
export function isCosmicFooterRemoveEvent<ValueInput>(
  value: ValueInput,
): value is ValueInput & CosmicFooterRemoveEvent {
  return isNormalized(normalizeCosmicFooterRemoveEvent, value);
}
export function isCosmicFooterInvalidateEvent<ValueInput>(
  value: ValueInput,
): value is ValueInput & CosmicFooterInvalidateEvent {
  return isNormalized(normalizeCosmicFooterInvalidateEvent, value);
}
