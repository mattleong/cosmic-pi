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

export function isCosmicUiHostQuery(value: unknown): value is CosmicUiHostQuery {
  if (!value || typeof value !== "object") return false;
  const query = value as Partial<CosmicUiHostQuery>;
  return query.version === COSMIC_UI_PROTOCOL_VERSION && typeof query.respond === "function";
}

function optionalString(value: unknown): boolean {
  return value === undefined || typeof value === "string";
}

function optionalFiniteNumber(value: unknown): boolean {
  return value === undefined || (typeof value === "number" && Number.isFinite(value));
}

function optionalFunction(value: unknown): boolean {
  return value === undefined || typeof value === "function";
}

export function isCosmicFooterUpsertEvent(value: unknown): value is CosmicFooterUpsertEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CosmicFooterUpsertEvent>;
  const contribution = event.contribution as Partial<CosmicFooterContribution> | undefined;
  if (
    event.version !== COSMIC_UI_PROTOCOL_VERSION ||
    typeof event.owner !== "string" ||
    !event.owner ||
    !contribution ||
    typeof contribution.id !== "string" ||
    !contribution.id
  )
    return false;
  if (contribution.kind === "text") {
    return (
      (contribution.region === "identity" ||
        contribution.region === "metrics" ||
        contribution.region === "details") &&
      typeof contribution.text === "string" &&
      optionalString(contribution.compactText) &&
      (contribution.align === undefined ||
        contribution.align === "left" ||
        contribution.align === "right") &&
      (contribution.tone === undefined ||
        contribution.tone === "normal" ||
        contribution.tone === "accent" ||
        contribution.tone === "dim" ||
        contribution.tone === "success" ||
        contribution.tone === "warning" ||
        contribution.tone === "error") &&
      optionalFiniteNumber(contribution.priority) &&
      optionalFiniteNumber(contribution.order)
    );
  }
  return (
    contribution.kind === "surface" &&
    contribution.region === "media" &&
    typeof contribution.preferredWidth === "number" &&
    Number.isFinite(contribution.preferredWidth) &&
    contribution.preferredWidth > 0 &&
    (contribution.preferredPlacement === undefined ||
      contribution.preferredPlacement === "stacked" ||
      contribution.preferredPlacement === "inline-left" ||
      contribution.preferredPlacement === "inline-right" ||
      contribution.preferredPlacement === "badge" ||
      contribution.preferredPlacement === "habitat") &&
    optionalFunction(contribution.attach) &&
    optionalFunction(contribution.detach) &&
    typeof contribution.render === "function" &&
    optionalFunction(contribution.invalidate) &&
    optionalFunction(contribution.dispose)
  );
}

export function isCosmicFooterRemoveEvent(value: unknown): value is CosmicFooterRemoveEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CosmicFooterRemoveEvent>;
  return (
    event.version === COSMIC_UI_PROTOCOL_VERSION &&
    typeof event.owner === "string" &&
    Boolean(event.owner) &&
    (event.id === undefined || (typeof event.id === "string" && Boolean(event.id)))
  );
}

export function isCosmicFooterInvalidateEvent(
  value: unknown,
): value is CosmicFooterInvalidateEvent {
  if (!value || typeof value !== "object") return false;
  const event = value as Partial<CosmicFooterInvalidateEvent>;
  return (
    event.version === COSMIC_UI_PROTOCOL_VERSION &&
    (event.owner === undefined || (typeof event.owner === "string" && Boolean(event.owner))) &&
    (event.id === undefined || (typeof event.id === "string" && Boolean(event.id)))
  );
}
