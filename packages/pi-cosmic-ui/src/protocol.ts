import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

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
  contribution: Schema.Union([TextContributionData, SurfaceContributionData]),
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

const optionalFunction = (value: unknown) => value === undefined || typeof value === "function";
const decodeSafely = <S extends Schema.ConstraintDecoder<unknown>>(
  schema: S,
  value: unknown,
): S["Type"] | undefined => {
  try {
    return Option.getOrUndefined(Schema.decodeUnknownOption(schema)(value));
  } catch {
    return undefined;
  }
};

export function isCosmicUiHostQuery(value: unknown): value is CosmicUiHostQuery {
  const query = decodeSafely(HostQueryData, value);
  return query !== undefined && typeof query.respond === "function";
}
export function isCosmicFooterUpsertEvent(value: unknown): value is CosmicFooterUpsertEvent {
  const event = decodeSafely(UpsertData, value);
  if (!event) return false;
  const contribution = event.contribution;
  if (contribution.kind === "text")
    return (
      (contribution.priority === undefined || Number.isFinite(contribution.priority)) &&
      (contribution.order === undefined || Number.isFinite(contribution.order))
    );
  return (
    Number.isFinite(contribution.preferredWidth) &&
    contribution.preferredWidth > 0 &&
    typeof contribution.render === "function" &&
    optionalFunction(contribution.attach) &&
    optionalFunction(contribution.detach) &&
    optionalFunction(contribution.invalidate) &&
    optionalFunction(contribution.dispose)
  );
}
export function isCosmicFooterRemoveEvent(value: unknown): value is CosmicFooterRemoveEvent {
  return decodeSafely(RemoveData, value) !== undefined;
}
export function isCosmicFooterInvalidateEvent(
  value: unknown,
): value is CosmicFooterInvalidateEvent {
  return decodeSafely(InvalidateData, value) !== undefined;
}
