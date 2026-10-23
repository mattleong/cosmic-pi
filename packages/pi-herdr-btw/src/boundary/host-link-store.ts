import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Context from "effect/Context";
import * as Layer from "effect/Layer";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import {
  HERDR_BTW_LINK_ENTRY_TYPE,
  HerdrBtwLinkRestoration,
  restoreHerdrBtwLink,
  type HerdrBtwLink,
  type HerdrBtwLinkOwner,
} from "../btw/link.ts";
import { probeSessionHeader, SessionHeaderProbe } from "./session-file.ts";

export type HerdrBtwLinkRecord = Pick<
  HerdrBtwLink,
  "childSessionId" | "childSessionPath" | "agentName" | "terminalId"
>;

export type HerdrBtwLinkRecordResult = "recorded" | "refused" | "uncertain";

export interface HerdrBtwLinkStoreContract {
  readonly restore: () => HerdrBtwLinkRestoration;
  readonly record: (link: HerdrBtwLinkRecord) => HerdrBtwLinkRecordResult;
}

export const makeHostHerdrBtwLinkStore = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  capturedOwner: HerdrBtwLinkOwner,
  probe: (path: string) => SessionHeaderProbe = probeSessionHeader,
): HerdrBtwLinkStoreContract => {
  const revalidateOwner = (): boolean =>
    invokeHostCallback(() => {
      if (
        ctx.sessionManager.getSessionId() !== capturedOwner.sessionId ||
        ctx.sessionManager.getSessionFile() !== capturedOwner.sessionPath
      )
        return false;
      const header = probe(capturedOwner.sessionPath);
      return (
        SessionHeaderProbe.$is("valid")(header) && header.header.id === capturedOwner.sessionId
      );
    }, false);
  return {
    restore: () =>
      invokeHostCallback(
        () =>
          revalidateOwner()
            ? restoreHerdrBtwLink(ctx.sessionManager.getEntries(), capturedOwner)
            : HerdrBtwLinkRestoration.malformed(),
        HerdrBtwLinkRestoration.malformed(),
      ),
    record: (link) => {
      if (!revalidateOwner()) return "refused";
      // A throwing append may already have persisted the entry.
      return invokeHostCallback<HerdrBtwLinkRecordResult>(() => {
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
      }, "uncertain");
    },
  };
};

/** Link persistence owned by one parent session's custom entries. */
export class HerdrBtwLinkStore extends Context.Service<
  HerdrBtwLinkStore,
  HerdrBtwLinkStoreContract
>()("pi-herdr-btw/boundary/host-link-store/HerdrBtwLinkStore") {
  static layer(pi: ExtensionAPI, ctx: ExtensionContext, owner: HerdrBtwLinkOwner) {
    return Layer.succeed(this, makeHostHerdrBtwLinkStore(pi, ctx, owner));
  }
}
