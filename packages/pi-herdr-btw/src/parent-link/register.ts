// Herdr-created child Pi processes gain a stable live parent reference.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { probeSessionHeader, type SessionHeaderProbe } from "../boundary/session-file.ts";
import {
  HERDR_BTW_CHILD_SESSION_FLAG,
  HERDR_BTW_PARENT_FILE_FLAG,
  HERDR_BTW_PARENT_FLAG,
} from "../btw/marker.ts";
import { parentReferenceInstruction } from "./instruction.ts";
import { resolveParentReference, type HerdrBtwParentReference } from "./reference.ts";

export interface ParentReferenceRegistrationOptions {
  /** Test seam for deterministic header probing. */
  readonly probe?: ((path: string) => SessionHeaderProbe) | undefined;
}

export interface HerdrBtwParentReferenceBridge {
  readonly capture: (ctx: ExtensionContext) => HerdrBtwParentReference | undefined;
  readonly activate: (reference: HerdrBtwParentReference | undefined) => void;
  readonly clear: () => void;
}

const captureParentReference = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  probe: (path: string) => SessionHeaderProbe,
): HerdrBtwParentReference | undefined => {
  try {
    return resolveParentReference({
      parentIdMarker: pi.getFlag(HERDR_BTW_PARENT_FLAG),
      parentFileMarker: pi.getFlag(HERDR_BTW_PARENT_FILE_FLAG),
      childSessionMarker: pi.getFlag(HERDR_BTW_CHILD_SESSION_FLAG),
      sessionId: ctx.sessionManager.getSessionId(),
      sessionFile: ctx.sessionManager.getSessionFile(),
      probe,
    });
  } catch {
    // A hostile or shutting-down host deactivates the reference fail-closed.
    return undefined;
  }
};

/**
 * Registers the fixed parent-marker flag and before-turn prompt hook. Session
 * lifecycle ownership remains with the application's generation-checked slot:
 * only its onActivated/onDeactivated hooks publish or clear this synchronous
 * host projection.
 */
export const registerHerdrBtwParentReference = (
  pi: ExtensionAPI,
  options: ParentReferenceRegistrationOptions = {},
): HerdrBtwParentReferenceBridge => {
  const probe = options.probe ?? probeSessionHeader;
  let activeReference: HerdrBtwParentReference | undefined;

  pi.registerFlag(HERDR_BTW_PARENT_FLAG, {
    description:
      "Internal pi-herdr-btw marker carrying the parent Pi session ID of a Herdr side session.",
    type: "string",
  });
  pi.registerFlag(HERDR_BTW_PARENT_FILE_FLAG, {
    description:
      "Internal pi-herdr-btw marker carrying the live parent Pi session file of a Herdr side session.",
    type: "string",
  });
  pi.registerFlag(HERDR_BTW_CHILD_SESSION_FLAG, {
    description:
      "Internal pi-herdr-btw marker binding the live parent reference to one Herdr side session.",
    type: "string",
  });

  const capture = (ctx: ExtensionContext) => captureParentReference(pi, ctx, probe);

  pi.on("before_agent_start", (event, ctx) => {
    if (!activeReference) return undefined;
    // Revalidate the bounded parent header for every child run. This is an
    // identity check only; no transcript content is read or imported.
    const current = capture(ctx);
    if (!current || current.id !== activeReference.id || current.path !== activeReference.path) {
      activeReference = undefined;
      return undefined;
    }
    activeReference = current;
    return {
      systemPrompt: `${event.systemPrompt}\n\n${parentReferenceInstruction(current.path, current.id)}`,
    };
  });

  return {
    capture,
    activate: (reference) => {
      activeReference = reference;
    },
    clear: () => {
      activeReference = undefined;
    },
  };
};
