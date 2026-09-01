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

export interface HostHerdrBtwLinkStoreOptions {
  /** Test seam for deterministic bounded parent-header probing. */
  readonly probeSessionHeader?: ((path: string) => SessionHeaderProbe) | undefined;
}

const readOwner = (ctx: ExtensionContext): HerdrBtwLinkOwner | undefined => {
  const sessionId = ctx.sessionManager.getSessionId();
  const sessionPath = ctx.sessionManager.getSessionFile();
  return sessionId && sessionPath ? { sessionId, sessionPath } : undefined;
};

const isSameOwner = (
  captured: HerdrBtwLinkOwner,
  current: HerdrBtwLinkOwner | undefined,
): boolean =>
  current !== undefined &&
  captured.sessionId === current.sessionId &&
  captured.sessionPath === current.sessionPath;

const hasOwnerHeader = (
  captured: HerdrBtwLinkOwner,
  probe: (path: string) => SessionHeaderProbe,
): boolean => {
  const result = probe(captured.sessionPath);
  return result._tag === "valid" && result.header.id === captured.sessionId;
};

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
  options: HostHerdrBtwLinkStoreOptions = {},
): HerdrBtwLinkStore => {
  const probe = options.probeSessionHeader ?? probeSessionHeader;
  // Fail-closed owner revalidation shared by restore and record: the captured owner must still
  // match the live extension context and carry the owner header before either operation proceeds.
  const revalidateOwner = (): boolean => {
    try {
      return isSameOwner(capturedOwner, readOwner(ctx)) && hasOwnerHeader(capturedOwner, probe);
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
