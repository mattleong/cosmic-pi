// Versioned durable link between a parent Pi session and its reusable fork.
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HerdrForkSessionIdSchema } from "./marker.ts";

export const HERDR_FORK_LINK_ENTRY_TYPE = "pi-herdr-fork/reusable-link";

const BoundedId = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));
const BoundedPath = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(4_096));

/**
 * Version 1 of the reusable-link record persisted in the parent session.
 * It carries the bounded child session identity plus the exact live Herdr
 * identity needed to revalidate and focus an already-running fork agent.
 */
export const HerdrForkLinkSchema = Schema.Struct({
  version: Schema.Literal(1),
  parentSessionId: HerdrForkSessionIdSchema,
  parentSessionPath: BoundedPath,
  childSessionId: HerdrForkSessionIdSchema,
  childSessionPath: BoundedPath,
  agentName: BoundedId,
  terminalId: BoundedId,
});

export type HerdrForkLink = typeof HerdrForkLinkSchema.Type;

export interface HerdrForkLinkOwner {
  readonly sessionId: string;
  readonly sessionPath: string;
}

const HerdrForkLinkOwnerSchema = Schema.Struct({
  version: Schema.Literal(1),
  parentSessionId: HerdrForkSessionIdSchema,
  parentSessionPath: BoundedPath,
});

const CustomEntrySchema = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.String.check(Schema.isMaxLength(256)),
  data: Schema.optional(Schema.Unknown),
});

export type HerdrForkLinkRestoration =
  | { readonly _tag: "none" }
  | { readonly _tag: "restored"; readonly link: HerdrForkLink }
  | { readonly _tag: "malformed" };

/**
 * Reconstructs the authoritative link owned by one parent session. Native
 * forks copy custom entries, so links owned by ancestor sessions are ignored.
 * The newest entry for the requested owner wins. An undecodable link whose
 * owner cannot be established is reported as malformed so callers fail closed.
 */
export const restoreHerdrForkLink = (
  entries: Iterable<unknown>,
  owner: HerdrForkLinkOwner,
): HerdrForkLinkRestoration => {
  let restoration: HerdrForkLinkRestoration = { _tag: "none" };
  for (const entry of entries) {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(CustomEntrySchema)(entry));
    if (decoded?.customType !== HERDR_FORK_LINK_ENTRY_TYPE) continue;
    const linkOwner = Option.getOrUndefined(
      Schema.decodeUnknownOption(HerdrForkLinkOwnerSchema)(decoded.data),
    );
    if (!linkOwner) {
      restoration = { _tag: "malformed" };
      continue;
    }
    if (
      linkOwner.parentSessionId !== owner.sessionId ||
      linkOwner.parentSessionPath !== owner.sessionPath
    )
      continue;
    const link = Option.getOrUndefined(
      Schema.decodeUnknownOption(HerdrForkLinkSchema)(decoded.data),
    );
    restoration = link ? { _tag: "restored", link } : { _tag: "malformed" };
  }
  return restoration;
};
