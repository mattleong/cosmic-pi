import * as Predicate from "effect/Predicate";
import type { CompactChild } from "./compact-summary";
import { describeBuiltinCompactSubject, type BuiltinCompactTool } from "./builtin-subject";
import type { NativeArgumentPreview } from "./native-codemode-args";
import { nativeMcpResourceAction, nativeMcpResourceSubject } from "./native-mcp-subject";
import { formatDisplayPath } from "pi-cosmic-core";

const builtinNames: ReadonlySet<string> = new Set([
  "bash",
  "read",
  "write",
  "edit",
  "grep",
  "find",
  "ls",
]);
const mcpActions = new Map([
  ["tools.call", "call"],
  ["tools.describe", "describe"],
  ["tools.search", "search tools"],
  ["tools.list", "list tools"],
  ["resources.read", "read resource"],
  ["resources.list", "list resources"],
  ["resources.templates", "list templates"],
  ["resources.subscribe", "subscribe"],
  ["resources.unsubscribe", "unsubscribe"],
  ["prompts.get", "get prompt"],
  ["prompts.list", "list prompts"],
  ["result.read", "read"],
  ["status", "status"],
  ["connect", "connect"],
  ["disconnect", "disconnect"],
  ["refresh", "refresh"],
  ["server.instructions", "instructions"],
  ["completion.complete", "complete"],
  ["events.read", "read events"],
  ["resources.subscriptions", "subscriptions"],
]);

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
  const action = preview.partialFields.has("action") ? "" : text("action");
  if (builtinNames.has(name)) {
    if (preview.complete) {
      // SAFETY: The name allowlist is exactly the shared projector's builtin union.
      return {
        subject: describeBuiltinCompactSubject(name as BuiltinCompactTool, preview.values, cwd),
      };
    }
    if (name === "bash") return { subject: text("command") };
    const rawPath = text("path") || text("file_path");
    const path = rawPath ? formatDisplayPath(rawPath, cwd) : "";
    if (name === "find" || name === "grep") {
      const pattern = text("pattern");
      return { subject: pattern && path ? `${pattern} in ${path}` : pattern || path };
    }
    if (name === "read" && path) {
      const offset = preview.values.offset;
      const limit = preview.values.limit;
      if (Predicate.isNumber(offset) && Number.isSafeInteger(offset) && offset > 0) {
        if (
          Predicate.isNumber(limit) &&
          Number.isSafeInteger(limit) &&
          limit > 0 &&
          limit - 1 <= Number.MAX_SAFE_INTEGER - offset
        )
          return { subject: `${path}:${offset}-${offset + limit - 1}` };
        return { subject: `${path}:${offset}` };
      }
    }
    // No '.', '*', or start line is inferred from fields missing beyond the cut.
    return { subject: path };
  }
  if (name === "background_task") {
    let subject = "";
    if (action === "start") subject = text("name") || text("command");
    else if (action === "wait") {
      if (text("until") === "exit") subject = "for exit";
      else if (text("until") === "output" && text("contains"))
        subject = `for "${text("contains")}"`;
    } else if (action === "list" && ["active", "completed"].includes(text("state")))
      subject = text("state");
    const projected: Pick<CompactChild, "subject" | "action"> = { subject };
    if (action) projected.action = action.replaceAll("_", " ");
    return projected;
  }
  if (name === "mcp") {
    const server = text("server");
    const target = text("tool") || text("prompt") || text("uri");
    const query = action === "tools.search" ? text("query") : "";
    const subject =
      action === "result.read"
        ? "saved output"
        : [server, target, query && `"${query}"`].filter(Boolean).join(" / ");
    const projected: Pick<CompactChild, "subject" | "action"> = { subject };
    const actionLabel = mcpActions.get(action);
    if (actionLabel !== undefined) projected.action = actionLabel;
    return projected;
  }
  return { subject: "" };
}
