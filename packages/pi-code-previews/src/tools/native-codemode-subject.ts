import * as Predicate from "effect/Predicate";
import type { CompactChild } from "./compact-summary";
import { describeBuiltinCompactSubject, type BuiltinCompactTool } from "./builtin-subject";
import { getReadLineRange } from "./data/args";
import type { NativeArgumentPreview } from "./native-codemode-args";
import { nativeMcpResourceAction, nativeMcpResourceSubject } from "./native-mcp-identity";
import { isCorePreviewName } from "./preview-admission";
import { formatDisplayPath } from "pi-cosmic-core";

type CallSubject = Pick<CompactChild, "subject" | "action"> & { readonly label?: string };
type FieldText = (key: string) => string;

const mcpToolName = /^mcp__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)__([A-Za-z0-9-]+(?:_[A-Za-z0-9-]+)*)$/;

function nativeMcpCall(name: string): CallSubject | undefined {
  if (name.length > 64 || (name.length === 64 && /_[0-9a-f]{8}$/.test(name))) return undefined;
  const match = mcpToolName.exec(name);
  const server = match?.[1];
  const tool = match?.[2];
  return server !== undefined && tool !== undefined
    ? { label: "mcp", action: "call", subject: `${server} / ${tool}` }
    : undefined;
}

function fieldText(preview: NativeArgumentPreview): FieldText {
  return (key) => {
    const value = preview.values[key];
    return Predicate.isString(value) && value
      ? `${value}${preview.partialFields.has(key) ? "…" : ""}`
      : "";
  };
}

function searchSubject(text: FieldText, path: string): string {
  const pattern = text("pattern");
  return pattern && path ? `${pattern} in ${path}` : pattern || path;
}

function coreSubject(
  name: BuiltinCompactTool,
  preview: NativeArgumentPreview,
  text: FieldText,
  cwd: string,
): string {
  if (preview.complete) return describeBuiltinCompactSubject(name, preview.values, cwd);
  if (name === "bash") return text("command");
  const rawPath = text("path") || text("file_path");
  const path = rawPath ? formatDisplayPath(rawPath, cwd) : "";
  if (name === "find" || name === "grep") return searchSubject(text, path);
  const offset = preview.values.offset;
  const ranged = name === "read" && Number.isSafeInteger(offset) && Number(offset) > 0;
  return path && ranged ? path + getReadLineRange(preview.values) : path;
}

function waitSubject(text: FieldText): string {
  const until = text("until");
  if (until === "exit") return "for exit";
  return until === "output" && text("contains") ? `for "${text("contains")}"` : "";
}

function backgroundTaskSubject(action: string, text: FieldText): string {
  if (action === "start") return text("name") || text("command");
  if (action === "wait") return waitSubject(text);
  return action === "list" && ["active", "completed"].includes(text("state")) ? text("state") : "";
}

function backgroundTaskCall(preview: NativeArgumentPreview, text: FieldText): CallSubject {
  const action = preview.partialFields.has("action") ? "" : text("action");
  const subject = backgroundTaskSubject(action, text);
  return action ? { subject, action: action.replaceAll("_", " ") } : { subject };
}

export function nativeCodemodeCallSubject(
  name: string,
  preview: NativeArgumentPreview | undefined,
  cwd: string,
): CallSubject {
  const mcpCall = nativeMcpCall(name);
  if (mcpCall) return mcpCall;
  const resourceAction = nativeMcpResourceAction(name);
  if (!preview)
    return resourceAction ? { label: "mcp", action: resourceAction, subject: "" } : { subject: "" };
  const text = fieldText(preview);
  if (resourceAction)
    return {
      label: "mcp",
      action: resourceAction,
      subject: nativeMcpResourceSubject(name, text("server"), text("uri")),
    };
  if (isCorePreviewName(name)) return { subject: coreSubject(name, preview, text, cwd) };
  if (name === "background_task") return backgroundTaskCall(preview, text);
  return { subject: "" };
}
