import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { nodeFs } from "pi-cosmic-core/platform/node-builtins";
import {
  parentReferenceInstruction,
  parseParentReference,
  REX_BTW_CHILD_FLAG,
  REX_BTW_PARENT_FILE_FLAG,
  REX_BTW_PARENT_FLAG,
  type ParentReference,
} from "./launch.ts";

const SECTION = "rex_btw_parent_reference";

/** True for a regular file reached without following a final symlink. */
export const isRegularFile = (path: string): boolean => {
  try {
    return nodeFs.lstatSync(path, { throwIfNoEntry: false })?.isFile() === true;
  } catch {
    return false;
  }
};

/** This session's parent reference, when it is a BTW child launched with one. */
export const launchedParent = (pi: ExtensionAPI): ParentReference | undefined =>
  invokeHostCallback(
    () =>
      parseParentReference(pi.getFlag(REX_BTW_PARENT_FLAG), pi.getFlag(REX_BTW_PARENT_FILE_FLAG)),
    undefined,
  );

/** Whether this session is a BTW side session, whether or not it can see its parent. */
export const isBtwChild = (pi: ExtensionAPI): boolean =>
  invokeHostCallback(() => pi.getFlag(REX_BTW_CHILD_FLAG) === true, false);

/**
 * A BTW child receives its parent's session ID and file as launch flags. Before every run the
 * reference is rechecked, so the note disappears if the parent file goes away.
 */
export const registerParentReference = (
  pi: ExtensionAPI,
  { fileExists = isRegularFile }: { readonly fileExists?: (path: string) => boolean } = {},
): void => {
  pi.registerFlag(REX_BTW_CHILD_FLAG, {
    description: "Internal pi-rex-btw marker for a BTW side session.",
    type: "boolean",
  });
  pi.registerFlag(REX_BTW_PARENT_FLAG, {
    description: "Internal pi-rex-btw marker carrying the parent Pi session ID of a BTW pane.",
    type: "string",
  });
  pi.registerFlag(REX_BTW_PARENT_FILE_FLAG, {
    description: "Internal pi-rex-btw marker carrying the parent Pi session file of a BTW pane.",
    type: "string",
  });

  pi.on("before_agent_start", (event) => {
    delete event.systemPromptOptions.sections[SECTION];
    const parent = launchedParent(pi);
    if (parent !== undefined && fileExists(parent.path))
      event.systemPromptOptions.sections[SECTION] = parentReferenceInstruction(parent);
    return undefined;
  });
};
