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
  readonly restore: () => HerdrBtwLinkRestoration;
  readonly record: (link: HerdrBtwLinkRecord) => HerdrBtwLinkRecordResult;
}

export const makeHostHerdrBtwLinkStore = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  capturedOwner: HerdrBtwLinkOwner,
  probe: (path: string) => SessionHeaderProbe = probeSessionHeader,
): HerdrBtwLinkStore => {
  const revalidateOwner = (): boolean => {
    try {
      if (
        ctx.sessionManager.getSessionId() !== capturedOwner.sessionId ||
        ctx.sessionManager.getSessionFile() !== capturedOwner.sessionPath
      )
        return false;
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
