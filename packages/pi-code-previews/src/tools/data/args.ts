import { isNumberValue, isStringValue } from "pi-cosmic-core";
import { getObjectValue } from "../../shared/helpers";

export function getPathArg<ArgsInput>(args: ArgsInput): string {
  const path = getObjectValue(args, "path") ?? getObjectValue(args, "file_path");
  return isStringValue(path) ? path : "";
}

export function getReadStartLine<ArgsInput>(args: ArgsInput): number {
  const offset = getObjectValue(args, "offset");
  return isNumberValue(offset) && Number.isFinite(offset) && offset > 0 ? Math.floor(offset) : 1;
}

export interface EditPreviewOperation {
  oldText: string;
  newText: string;
}

export function getEditPreviewOperations<ArgsInput>(args: ArgsInput): EditPreviewOperation[] {
  const edits = getObjectValue(args, "edits");
  return (Array.isArray(edits) ? edits : [args]).flatMap((edit) => {
    const oldText = getObjectValue(edit, "oldText") ?? getObjectValue(edit, "old_text");
    const newText = getObjectValue(edit, "newText") ?? getObjectValue(edit, "new_text");
    return isStringValue(oldText) && isStringValue(newText) && oldText !== newText
      ? [{ oldText, newText }]
      : [];
  });
}
