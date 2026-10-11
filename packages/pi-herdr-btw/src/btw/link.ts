import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import { BoundedId, BoundedPath, HerdrBtwSessionIdSchema } from "./marker.ts";

export const HERDR_BTW_LINK_ENTRY_TYPE = "pi-herdr-btw/reusable-link";

const HerdrBtwLinkOwnerSchema = Schema.Struct({
  version: Schema.Literal(1),
  parentSessionId: HerdrBtwSessionIdSchema,
  parentSessionPath: BoundedPath,
});

export const HerdrBtwLinkSchema = Schema.Struct({
  ...HerdrBtwLinkOwnerSchema.fields,
  childSessionId: HerdrBtwSessionIdSchema,
  childSessionPath: BoundedPath,
  agentName: BoundedId,
  terminalId: BoundedId,
});

export type HerdrBtwLink = typeof HerdrBtwLinkSchema.Type;

export interface HerdrBtwLinkOwner {
  readonly sessionId: string;
  readonly sessionPath: string;
}

const CustomEntrySchema = Schema.Struct({
  type: Schema.Literal("custom"),
  customType: Schema.String.check(Schema.isMaxLength(256)),
  data: Schema.optional(Schema.Unknown),
});

export type HerdrBtwLinkRestoration =
  | { readonly _tag: "none" }
  | { readonly _tag: "restored"; readonly link: HerdrBtwLink }
  | { readonly _tag: "malformed" };

export const restoreHerdrBtwLink = (
  entries: Iterable<unknown>,
  owner: HerdrBtwLinkOwner,
): HerdrBtwLinkRestoration => {
  let restoration: HerdrBtwLinkRestoration = { _tag: "none" };
  for (const entry of entries) {
    const decoded = Option.getOrUndefined(Schema.decodeUnknownOption(CustomEntrySchema)(entry));
    if (decoded?.customType !== HERDR_BTW_LINK_ENTRY_TYPE) continue;
    const linkOwner = decodeUnknownOrUndefined(HerdrBtwLinkOwnerSchema, decoded.data);
    if (!linkOwner) {
      restoration = { _tag: "malformed" };
      continue;
    }
    if (
      linkOwner.parentSessionId !== owner.sessionId ||
      linkOwner.parentSessionPath !== owner.sessionPath
    )
      continue;
    const link = decodeUnknownOrUndefined(HerdrBtwLinkSchema, decoded.data);
    restoration = link ? { _tag: "restored", link } : { _tag: "malformed" };
  }
  return restoration;
};
