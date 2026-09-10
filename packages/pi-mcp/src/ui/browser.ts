import { sanitizeTerminalLine, stripTerminalControls } from "pi-cosmic-core";
import type {
  McpCachedDetail,
  McpCachedEntry,
  McpCachedFamily,
  McpCachedPage,
  McpCachedCatalog,
} from "../discovery/model.ts";

export const cachedFamilies: ReadonlyArray<McpCachedFamily> = [
  "tools",
  "resources",
  "templates",
  "prompts",
];
export const browserIdentity = (entry: McpCachedEntry) =>
  `${entry.ref.server.length}:${entry.ref.server}${entry.ref.family}:${entry.ref.id}`;
export const browserLabel = (entry: McpCachedEntry) =>
  `${sanitizeTerminalLine(entry.ref.server)} / ${sanitizeTerminalLine(entry.name)}`;
export const browserEmpty = (page: McpCachedPage | undefined, server?: string) =>
  !page
    ? "Cached metadata unavailable or loading locally."
    : page.catalogs.length === 0
      ? "No enabled trusted servers in this scope."
      : `${page.catalogs.map((catalog) => `${sanitizeTerminalLine(catalog.server)}: ${catalog.state}, ${catalog.count} cached`).join("\n")}\n${server ? "a opens server actions, including Discover metadata." : "s selects a server; then a offers Discover metadata."} Discovery is explicit and may connect.`;
export const browserCatalogStatus = (catalog: McpCachedCatalog): string => {
  if (catalog.state === "refreshing")
    return "Refreshing metadata; showing the last complete revision.";
  if (catalog.state === "refresh-failed")
    return "Refresh failed; showing the last complete revision.";
  if (catalog.state === "unsupported" && catalog.reason === "rpc-method-not-found")
    return "This catalog is unavailable; the server rejected its listing method.";
  return `Catalog: ${catalog.state}, ${catalog.count} cached`;
};
export const browserDetail = (
  entry: McpCachedEntry | undefined,
  detail: McpCachedDetail | undefined,
): ReadonlyArray<string> => {
  if (!entry) return ["Select cached metadata. Browsing never invokes it."];
  return [
    sanitizeTerminalLine(entry.ref.server),
    `Exact identifier: ${sanitizeTerminalLine(entry.ref.id)}`,
    `Family: ${entry.ref.family} / revision ${entry.ref.revision}`,
    "",
    stripTerminalControls(detail?.description ?? entry.description),
    ...(detail
      ? [detail.metadata, ...(detail.truncated ? ["Metadata details truncated."] : [])]
      : ["Enter opens bounded metadata details."]),
    "",
    "Untrusted server metadata. No links, icons, or schema references are fetched.",
  ];
};
