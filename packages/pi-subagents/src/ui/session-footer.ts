import * as Rec from "effect/Record";
import type { CosmicFooterTextContribution } from "pi-cosmic-ui/protocol";
import type { ResolvedProfileSetSelection } from "../config/options.ts";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";

export const SESSION_FOOTER_ID = "subagents";

const profileSetLabel = (origin: ResolvedProfileSetSelection): string =>
  origin.scope === "builtin" ? "built-in" : (origin.name ?? "invalid set");

/**
 * Current Session's profile set, marked when edited, and any non-default delegation mode. It is
 * labeled so it doesn't read as a second active model, and keeps the glyph form when narrow.
 */
export const sessionFooterContribution = (
  snapshot: SessionProfileSnapshot,
): CosmicFooterTextContribution => {
  const origin = snapshot.baseline.origin;
  const mode = snapshot.effectiveConfig.delegation;
  const edited = Rec.size<string, unknown>(snapshot.overrides) > 0 ? "*" : "";
  const delegation = mode === "normal" ? "" : ` · ${mode}`;
  const value = `${profileSetLabel(origin)}${edited}${delegation}`;
  return {
    kind: "text",
    id: SESSION_FOOTER_ID,
    region: "identity",
    text: `subagents: ${value}`,
    compactText: `⧉ ${value}`,
    tone:
      origin.scope !== "builtin" && origin.invalid === true
        ? "warning"
        : mode === "normal"
          ? "dim"
          : "accent",
    priority: 70,
    order: 260,
  };
};
