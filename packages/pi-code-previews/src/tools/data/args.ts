import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import { getObjectValue } from "../../shared/helpers";
import { escapeControlChars } from "../../shared/terminal-text";

export function fallbackArguments<ArgsInput>(args: ArgsInput): string[] {
  return invokeHostCallback(() => {
    if (args === undefined || args === null) return [];
    if (Predicate.isObject(args) && Object.keys(args).length === 0) return [];
    const json = JSON.stringify(args, null, 2);
    return json === undefined ? [] : escapeControlChars(json).split("\n");
  }, []);
}

export function getPathArg<ArgsInput>(args: ArgsInput): string {
  const path = getObjectValue(args, "path") ?? getObjectValue(args, "file_path");
  return Predicate.isString(path) ? path : "";
}

export function getReadStartLine<ArgsInput>(args: ArgsInput): number {
  const offset = getObjectValue(args, "offset");
  return Predicate.isNumber(offset) && Number.isFinite(offset) && offset > 0
    ? Math.floor(offset)
    : 1;
}

export function getReadLineRange<ArgsInput>(args: ArgsInput): string {
  const start = getReadStartLine(args);
  const limit = getObjectValue(args, "limit");
  if (!Number.isSafeInteger(start)) return "";
  if (
    Predicate.isNumber(limit) &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit - 1 <= Number.MAX_SAFE_INTEGER - start
  )
    return `:${start}-${start + (limit - 1)}`;
  return Predicate.isNumber(getObjectValue(args, "offset")) ? `:${start}` : "";
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
    return Predicate.isString(oldText) && Predicate.isString(newText) && oldText !== newText
      ? [{ oldText, newText }]
      : [];
  });
}
