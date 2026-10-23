import * as Data from "effect/Data";
import * as Schema from "effect/Schema";
import { decodeUnknownOrUndefined } from "pi-cosmic-core/schema/decode";
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
const decodeLinkOwner = decodeUnknownOrUndefined(HerdrBtwLinkOwnerSchema);
const decodeLink = decodeUnknownOrUndefined(HerdrBtwLinkSchema);

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
const decodeCustomEntry = decodeUnknownOrUndefined(CustomEntrySchema);

export type HerdrBtwLinkRestoration = Data.TaggedEnum<{
  none: Record<never, never>;
  restored: { readonly link: HerdrBtwLink };
  malformed: Record<never, never>;
}>;
export const HerdrBtwLinkRestoration = Data.taggedEnum<HerdrBtwLinkRestoration>();

/** Later entries override earlier ones, so the newest link entry not owned elsewhere decides. */
export const restoreHerdrBtwLink = (
  entries: ReadonlyArray<unknown>,
  owner: HerdrBtwLinkOwner,
): HerdrBtwLinkRestoration => {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const decoded = decodeCustomEntry(entries[index]);
    if (decoded?.customType !== HERDR_BTW_LINK_ENTRY_TYPE) continue;
    const linkOwner = decodeLinkOwner(decoded.data);
    if (!linkOwner) return HerdrBtwLinkRestoration.malformed();
    if (
      linkOwner.parentSessionId !== owner.sessionId ||
      linkOwner.parentSessionPath !== owner.sessionPath
    )
      continue;
    const link = decodeLink(decoded.data);
    return link ? HerdrBtwLinkRestoration.restored({ link }) : HerdrBtwLinkRestoration.malformed();
  }
  return HerdrBtwLinkRestoration.none();
};
