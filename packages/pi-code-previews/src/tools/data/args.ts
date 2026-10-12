import * as Predicate from "effect/Predicate";
import { invokeHostCallback } from "pi-cosmic-core";
import {
  hostObject,
  ownField,
  type HostObject,
  type HostValue,
} from "../../shared/untrusted-value";
import { escapeControlChars } from "../../shared/terminal-text";

export function fallbackArguments(args: HostValue | undefined): string[] {
  return invokeHostCallback(() => {
    if (args === undefined || args === null) return [];
    if (Predicate.isObject(args) && Object.keys(args).length === 0) return [];
    const json = JSON.stringify(args, null, 2);
    return json === undefined ? [] : escapeControlChars(json).split("\n");
  }, []);
}

export function getPathArg(args: HostObject | undefined): string {
  const path = ownField(args, "path") ?? ownField(args, "file_path");
  return Predicate.isString(path) ? path : "";
}

export function getReadStartLine(args: HostObject | undefined): number {
  const offset = ownField(args, "offset");
  return Predicate.isNumber(offset) && Number.isFinite(offset) && offset > 0
    ? Math.floor(offset)
    : 1;
}

export function getReadLineRange(args: HostObject | undefined): string {
  const start = getReadStartLine(args);
  const limit = ownField(args, "limit");
  if (!Number.isSafeInteger(start)) return "";
  if (
    Predicate.isNumber(limit) &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit - 1 <= Number.MAX_SAFE_INTEGER - start
  )
    return `:${start}-${start + (limit - 1)}`;
  return Predicate.isNumber(ownField(args, "offset")) ? `:${start}` : "";
}

export interface EditPreviewOperation {
  oldText: string;
  newText: string;
}

export function editOperationInputs(args: HostObject | undefined): Array<HostObject | undefined> {
  const edits = ownField(args, "edits");
  return Array.isArray(edits) ? edits.map((edit) => hostObject(edit)) : [args];
}

export function getEditPreviewOperations(args: HostObject | undefined): EditPreviewOperation[] {
  return editOperationInputs(args).flatMap((edit) => {
    const oldText = ownField(edit, "oldText") ?? ownField(edit, "old_text");
    const newText = ownField(edit, "newText") ?? ownField(edit, "new_text");
    return Predicate.isString(oldText) && Predicate.isString(newText) && oldText !== newText
      ? [{ oldText, newText }]
      : [];
  });
}
