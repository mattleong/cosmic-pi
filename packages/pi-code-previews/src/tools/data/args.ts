import * as Predicate from "effect/Predicate";
import * as Arr from "effect/Array";
import * as Str from "effect/String";
import * as Rec from "effect/Record";
import { invokeHostCallback } from "pi-cosmic-core/host-session";
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
    if (Predicate.isObject(args) && Rec.keys(args).length === 0) return [];
    const json = JSON.stringify(args, null, 2);
    return json === undefined ? [] : Str.split(escapeControlChars(json), "\n");
  }, []);
}

export function getPathArg(args: HostObject | undefined): string {
  const path = ownField(args, "path") ?? ownField(args, "file_path");
  return Predicate.isString(path) ? path : "";
}

/**
 * Pi's validation coerces numeric strings before a tool runs, but renderers receive the raw
 * arguments, so numeric fields accept finite numbers and trimmed numeric strings alike.
 */
export function numericArg(args: HostObject | undefined, name: string): number | undefined {
  const value = ownField(args, name);
  const number = Predicate.isString(value) && Str.trim(value) !== "" ? Number(value) : value;
  return Predicate.isNumber(number) && Number.isFinite(number) ? number : undefined;
}

export function hasReadLimit(args: HostObject | undefined): boolean {
  return numericArg(args, "limit") !== undefined;
}

export function getReadStartLine(args: HostObject | undefined): number {
  const offset = numericArg(args, "offset");
  return offset !== undefined && offset > 0 ? Math.floor(offset) : 1;
}

export function getReadLineRange(args: HostObject | undefined): string {
  const start = getReadStartLine(args);
  const limit = numericArg(args, "limit");
  if (!Number.isSafeInteger(start)) return "";
  if (
    limit !== undefined &&
    Number.isSafeInteger(limit) &&
    limit > 0 &&
    limit - 1 <= Number.MAX_SAFE_INTEGER - start
  )
    return `:${start}-${start + (limit - 1)}`;
  return numericArg(args, "offset") === undefined ? "" : `:${start}`;
}

export interface EditPreviewOperation {
  oldText: string;
  newText: string;
}

export function editOperationInputs(args: HostObject | undefined): Array<HostObject | undefined> {
  const edits = ownField(args, "edits");
  return Arr.isArray(edits) ? Arr.map(edits, (edit) => hostObject(edit)) : [args];
}

export function getEditPreviewOperations(args: HostObject | undefined): EditPreviewOperation[] {
  return Arr.flatMap(editOperationInputs(args), (edit) => {
    const oldText = ownField(edit, "oldText") ?? ownField(edit, "old_text");
    const newText = ownField(edit, "newText") ?? ownField(edit, "new_text");
    return Predicate.isString(oldText) && Predicate.isString(newText) && oldText !== newText
      ? [{ oldText, newText }]
      : [];
  });
}
