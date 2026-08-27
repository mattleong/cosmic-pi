// Guarded Pi host boundary persisting the reusable BTW link in the parent session.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
  type HerdrBtwLinkOwner,
  type HerdrBtwLinkRestoration,
} from "../btw/link.ts";

export interface HerdrBtwLinkStore {
  /** Reconstructs the authoritative link from current parent-session entries. */
  readonly restore: () => HerdrBtwLinkRestoration;
  /** Appends a confirmed link entry; `false` reports a failed host append. */
  readonly record: (link: HerdrBtwLink) => boolean;
}

/**
 * The store reads through the read-only session manager of the captured
 * session and appends through `pi.appendEntry`, so restoration always follows
 * the current session across reload and resume. A throwing host is reported
 * as malformed (restore) or unrecorded (record) so callers fail closed.
 */
export const makeHostHerdrBtwLinkStore = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: HerdrBtwLinkOwner,
): HerdrBtwLinkStore => ({
  restore: () => {
    try {
      return restoreHerdrBtwLink(ctx.sessionManager.getEntries(), owner);
    } catch {
      return { _tag: "malformed" };
    }
  },
  record: (link) => {
    try {
      pi.appendEntry(HERDR_BTW_LINK_ENTRY_TYPE, link);
      return true;
    } catch {
      return false;
    }
  },
});
