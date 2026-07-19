export const COSMIC_UI_PROTOCOL_VERSION = 1 as const;
export const COSMIC_UI_HOST_QUERY = "cosmic-ui:v1:host:query";
export const COSMIC_UI_FOOTER_UPSERT = "cosmic-ui:v1:footer:upsert";
export const COSMIC_UI_FOOTER_REMOVE = "cosmic-ui:v1:footer:remove";

export interface FooterTextPrimitive {
  kind: "text";
  id: string;
  region: "identity" | "metrics" | "details";
  text: string;
  compactText?: string;
  align?: "left" | "right";
  tone?: "normal" | "dim" | "success" | "warning" | "error";
  priority?: number;
  order?: number;
}

export type BetterXaiFooterPrimitive = FooterTextPrimitive;
