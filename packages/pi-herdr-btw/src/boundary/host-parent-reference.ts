// Pi registration bridge for Herdr-created child parent references.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
  HERDR_BTW_CHILD_SESSION_FLAG,
  HERDR_BTW_PARENT_FILE_FLAG,
  HERDR_BTW_PARENT_FLAG,
} from "../btw/marker.ts";
import {
  parentReferenceInstruction,
  resolveParentReferenceCandidate,
  type HerdrBtwParentReference,
} from "../parent-link/policy.ts";
import {
  compareSessionFileIdentity,
  probeSessionHeader,
  type SessionFileIdentityComparator,
  type SessionHeaderProbe,
} from "./session-file.ts";

export interface ParentReferenceRegistrationOptions {
  /** Test seams for deterministic header and filesystem-identity probing. */
  readonly probe?: ((path: string) => SessionHeaderProbe) | undefined;
  readonly compareIdentity?: SessionFileIdentityComparator | undefined;
}

export interface HerdrBtwParentReferenceBridge {
  readonly capture: (ctx: ExtensionContext) => HerdrBtwParentReference | undefined;
  readonly activate: (reference: HerdrBtwParentReference | undefined) => void;
  readonly clear: () => void;
}

/**
 * Registers the fixed parent-marker flags and before-turn prompt hook. The
 * application's generation-checked slot remains the activation owner.
 */
export const registerHerdrBtwParentReference = (
  pi: ExtensionAPI,
  options: ParentReferenceRegistrationOptions = {},
): HerdrBtwParentReferenceBridge => {
  const probe = options.probe ?? probeSessionHeader;
  const compareIdentity = options.compareIdentity ?? compareSessionFileIdentity;
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

  const capture = (ctx: ExtensionContext): HerdrBtwParentReference | undefined => {
    try {
      const sessionId = ctx.sessionManager.getSessionId();
      const sessionFile = ctx.sessionManager.getSessionFile();
      const candidate = resolveParentReferenceCandidate({
        parentIdMarker: pi.getFlag(HERDR_BTW_PARENT_FLAG),
        parentFileMarker: pi.getFlag(HERDR_BTW_PARENT_FILE_FLAG),
        childSessionMarker: pi.getFlag(HERDR_BTW_CHILD_SESSION_FLAG),
        sessionId,
        sessionFile,
      });
      if (!candidate || !sessionFile) return undefined;
      if (compareIdentity(candidate.path, sessionFile) !== "distinct") return undefined;
      const parentHeader = probe(candidate.path);
      return parentHeader._tag === "valid" && parentHeader.header.id === candidate.id
        ? candidate
        : undefined;
    } catch {
      // A hostile or shutting-down host deactivates the reference fail-closed.
      return undefined;
    }
  };

  pi.on("before_agent_start", (event, ctx) => {
    // Options may survive repeated hooks: remove only our section before revalidation.
    delete event.systemPromptOptions.sections.herdr_btw_parent_reference;
    if (!activeReference) return undefined;
    // Revalidate the bounded parent header for every child run. This is an
    // identity check only; no transcript content is read or imported.
    const current = capture(ctx);
    if (!current || current.id !== activeReference.id || current.path !== activeReference.path) {
      activeReference = undefined;
      return undefined;
    }
    event.systemPromptOptions.sections.herdr_btw_parent_reference = parentReferenceInstruction(
      current.path,
      current.id,
    );
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
