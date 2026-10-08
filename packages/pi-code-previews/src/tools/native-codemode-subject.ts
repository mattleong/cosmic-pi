import * as Predicate from "effect/Predicate";
import type { CompactChild } from "./compact-summary";
import { describeBuiltinCompactSubject } from "./builtin-subject";
import { getReadLineRange } from "./data/args";
import type { NativeArgumentPreview } from "./native-codemode-args";
import { nativeMcpResourceAction, nativeMcpResourceSubject } from "./native-mcp-identity";
import { isCorePreviewName } from "./preview-admission";
import { formatDisplayPath } from "pi-cosmic-core";

/** Argument/name-only targets; never inspect results, foreign definitions, or provider state. */
export function nativeCodemodeCallSubject(
  name: string,
  preview: NativeArgumentPreview | undefined,
  cwd: string,
): Pick<CompactChild, "subject" | "action"> & { readonly label?: string } {
  // These are registered aliases, not recovered remote identifiers or proof of native ownership.
  // Extra delimiters, ambiguous underscore boundaries, and potentially truncated separators
  // retain the original name. A full-length hash suffix may have replaced the real separator.
  const nativeName =
    name.length <= 64 && !(name.length === 64 && /_[0-9a-f]{8}$/.test(name))
      ? /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)$/.exec(name)
      : null;
  if (nativeName)
    return { label: "mcp", action: "call", subject: `${nativeName[1]} / ${nativeName[2]}` };
  const resourceAction = nativeMcpResourceAction(name);
  if (!preview)
    return resourceAction ? { label: "mcp", action: resourceAction, subject: "" } : { subject: "" };
  const text = (key: string): string => {
    const value = preview.values[key];
    return Predicate.isString(value) && value
      ? `${value}${preview.partialFields.has(key) ? "…" : ""}`
      : "";
  };
  if (resourceAction)
    return {
      label: "mcp",
      action: resourceAction,
      subject: nativeMcpResourceSubject(name, text("server"), text("uri")),
    };
  if (isCorePreviewName(name)) {
    if (preview.complete)
      return { subject: describeBuiltinCompactSubject(name, preview.values, cwd) };
    if (name === "bash") return { subject: text("command") };
    const rawPath = text("path") || text("file_path");
    const path = rawPath ? formatDisplayPath(rawPath, cwd) : "";
    if (name === "find" || name === "grep") {
      const pattern = text("pattern");
      return { subject: pattern && path ? `${pattern} in ${path}` : pattern || path };
    }
    const offset = preview.values.offset;
    const ranged = name === "read" && Number.isSafeInteger(offset) && Number(offset) > 0;
    // No '.', '*', or start line is inferred from fields missing beyond the cut.
    return { subject: path && ranged ? path + getReadLineRange(preview.values) : path };
  }
  if (name === "background_task") {
    const action = preview.partialFields.has("action") ? "" : text("action");
    let subject = "";
    if (action === "start") subject = text("name") || text("command");
    else if (action === "wait") {
      if (text("until") === "exit") subject = "for exit";
      else if (text("until") === "output" && text("contains"))
        subject = `for "${text("contains")}"`;
    } else if (action === "list" && ["active", "completed"].includes(text("state")))
      subject = text("state");
    return action ? { subject, action: action.replaceAll("_", " ") } : { subject };
  }
  return { subject: "" };
}
