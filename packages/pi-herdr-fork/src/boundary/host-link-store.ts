// Guarded Pi host boundary persisting the reusable fork link in the parent session.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  HERDR_FORK_LINK_ENTRY_TYPE,
  restoreHerdrForkLink,
  type HerdrForkLink,
  type HerdrForkLinkOwner,
  type HerdrForkLinkRestoration,
} from "../fork/link.ts";

export interface HerdrForkLinkStore {
  /** Reconstructs the authoritative link from current parent-session entries. */
  readonly restore: () => HerdrForkLinkRestoration;
  /** Appends a confirmed link entry; `false` reports a failed host append. */
  readonly record: (link: HerdrForkLink) => boolean;
}

/**
 * The store reads through the read-only session manager of the captured
 * session and appends through `pi.appendEntry`, so restoration always follows
 * the current session across reload and resume. A throwing host is reported
 * as malformed (restore) or unrecorded (record) so callers fail closed.
 */
export const makeHostHerdrForkLinkStore = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  owner: HerdrForkLinkOwner,
): HerdrForkLinkStore => ({
  restore: () => {
    try {
      return restoreHerdrForkLink(ctx.sessionManager.getEntries(), owner);
    } catch {
      return { _tag: "malformed" };
    }
  },
  record: (link) => {
    try {
      pi.appendEntry(HERDR_FORK_LINK_ENTRY_TYPE, link);
      return true;
    } catch {
      return false;
    }
  },
});
