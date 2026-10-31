import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
import { nodeFs } from "pi-cosmic-core/platform/node-builtins";
import {
  parentReferenceInstruction,
  parseParentReference,
  REX_BTW_PARENT_FILE_FLAG,
  REX_BTW_PARENT_FLAG,
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

/**
 * A BTW child receives its parent's session ID and file as launch flags. Before every run the
 * reference is rechecked, so the note disappears if the parent file goes away.
 */
export const registerParentReference = (
  pi: ExtensionAPI,
  { fileExists = isRegularFile }: { readonly fileExists?: (path: string) => boolean } = {},
): void => {
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
    const parent = invokeHostCallback(
      () =>
        parseParentReference(pi.getFlag(REX_BTW_PARENT_FLAG), pi.getFlag(REX_BTW_PARENT_FILE_FLAG)),
      undefined,
    );
    if (parent !== undefined && fileExists(parent.path))
      event.systemPromptOptions.sections[SECTION] = parentReferenceInstruction(parent);
    return undefined;
  });
};
