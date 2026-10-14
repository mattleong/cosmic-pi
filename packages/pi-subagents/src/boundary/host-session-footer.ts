import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { hasTerminalUI } from "pi-cosmic-core";
import { makeSetStatusSafely } from "pi-cosmic-ui/boundary/host-status";
import { createCosmicFooterClient, createHostStateWatch } from "pi-cosmic-ui/client";
import type { SessionProfileSnapshot } from "../profiles/session-overrides.ts";
import { SESSION_FOOTER_ID, sessionFooterContribution } from "../ui/session-footer.ts";

// Separate from the fleet status owner so clearing one never removes the other.
const OWNER = "pi-subagents.session";

export interface SubagentSessionFooter {
  readonly show: (ctx: ExtensionContext, snapshot: SessionProfileSnapshot) => void;
  readonly clear: () => void;
}

/**
 * Shows Current Session's profile set and delegation mode in the Cosmic UI footer, or as a
 * plain Pi status entry when Cosmic UI is not active. Hidden footer items stay hidden in both.
 */
export const subagentSessionFooter = (
  events: ExtensionAPI["events"] | undefined,
): SubagentSessionFooter => {
  const client = createCosmicFooterClient(events, OWNER);
  const setStatus = makeSetStatusSafely(OWNER);
  let shown:
    | { readonly ctx: ExtensionContext; readonly snapshot: SessionProfileSnapshot }
    | undefined;
  const paint = () => {
    if (!shown) return;
    const { ctx, snapshot } = shown;
    client.query();
    const contribution = client.isVisible(SESSION_FOOTER_ID)
      ? sessionFooterContribution(snapshot)
      : undefined;
    const terminal = hasTerminalUI(ctx);
    if (terminal && client.installed) {
      if (contribution) client.upsert(contribution);
      else client.remove(SESSION_FOOTER_ID);
    }
    setStatus(ctx, terminal && client.active ? undefined : contribution?.text);
  };
  const watch = createHostStateWatch(client, paint);
  return {
    show: (ctx, snapshot) => {
      shown = { ctx, snapshot };
      watch.start();
      paint();
    },
    clear: () => {
      const previous = shown;
      shown = undefined;
      watch.stop();
      client.shutdown();
      setStatus(previous?.ctx, undefined);
    },
  };
};
