// Guarded Pi host boundary persisting the reusable BTW link in the parent session.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
  type HerdrBtwLinkOwner,
  type HerdrBtwLinkRestoration,
} from "../btw/link.ts";
import { probeSessionHeader, type SessionHeaderProbe } from "./session-file.ts";

export type HerdrBtwLinkRecord = Pick<
  HerdrBtwLink,
  "childSessionId" | "childSessionPath" | "agentName" | "terminalId"
>;

export type HerdrBtwLinkRecordResult = "recorded" | "refused" | "uncertain";

export interface HerdrBtwLinkStore {
  /** Reconstructs the authoritative link from current parent-session entries. */
  readonly restore: () => HerdrBtwLinkRestoration;
  /** Appends child facts after stamping the captured version and parent owner. */
  readonly record: (link: HerdrBtwLinkRecord) => HerdrBtwLinkRecordResult;
}

/**
 * Uses the owner captured by application startup, then revalidates the live
 * session ID, path, and bounded no-follow header before every read or append.
 * A replacement session, missing identity, or throwing pre-append host call
 * fails closed. Callers supply child facts only; the store stamps version and
 * owner.
 */
export const makeHostHerdrBtwLinkStore = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  capturedOwner: HerdrBtwLinkOwner,
  /** Test seam for deterministic bounded parent-header probing. */
  probe: (path: string) => SessionHeaderProbe = probeSessionHeader,
): HerdrBtwLinkStore => {
  // Fail-closed owner revalidation shared by restore and record: the captured owner must still
  // match the live extension context and carry the owner header before either operation proceeds.
  const revalidateOwner = (): boolean => {
    try {
      if (
        ctx.sessionManager.getSessionId() !== capturedOwner.sessionId ||
        ctx.sessionManager.getSessionFile() !== capturedOwner.sessionPath
      )
        return false;
      // An empty captured owner still fails: probe("") is invalid and header IDs are non-empty.
      const header = probe(capturedOwner.sessionPath);
      return header._tag === "valid" && header.header.id === capturedOwner.sessionId;
    } catch {
      return false;
    }
  };
  return {
    restore: () => {
      try {
        if (!revalidateOwner()) return { _tag: "malformed" };
        return restoreHerdrBtwLink(ctx.sessionManager.getEntries(), capturedOwner);
      } catch {
        return { _tag: "malformed" };
      }
    },
    record: (link) => {
      if (!revalidateOwner()) return "refused";

      try {
        pi.appendEntry(HERDR_BTW_LINK_ENTRY_TYPE, {
          version: 1,
          parentSessionId: capturedOwner.sessionId,
          parentSessionPath: capturedOwner.sessionPath,
          childSessionId: link.childSessionId,
          childSessionPath: link.childSessionPath,
          agentName: link.agentName,
          terminalId: link.terminalId,
        });
        return "recorded";
      } catch {
        return "uncertain";
      }
    },
  };
};
