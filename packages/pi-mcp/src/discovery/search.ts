import { annotationTitle, type McpSearchMetadata } from "./summary.ts";

/** Locale-independent ordering also keeps equal-rank pages stable across hosts. */
export const compareDiscoveryText = (left: string, right: string): number =>
  left < right ? -1 : left > right ? 1 : 0;

const words = (text: string): ReadonlyArray<string> =>
  text
    .replace(/(\p{Lu})(\p{Lu}\p{Ll})/gu, "$1 $2")
    .replace(/([\p{Ll}\p{N}])(\p{Lu})/gu, "$1 $2")
    .toLowerCase()
    .match(/[\p{L}\p{N}\p{M}]+/gu) ?? [];

export const prepareDiscoverySearch = (query: string) => ({
  text: query.trim().toLowerCase(),
  words: [...new Set(words(query))],
});

/**
 * Search full metadata, not summaries. All query words must match, independent of order.
 * A word may match part of a catalog word, preserving substring discovery. Name words rank
 * above title words, then description words; mixed-field matches use the lowest required
 * tier. Cached resource/template identities participate as names so URIs remain searchable.
 */
export const discoverySearchRank = (
  query: ReturnType<typeof prepareDiscoverySearch>,
  metadata: McpSearchMetadata,
  identity = metadata.name,
): number | undefined => {
  if (!query.text) return 0;
  const names = identity === metadata.name ? metadata.name : `${metadata.name}\n${identity}`;
  if (metadata.name.toLowerCase() === query.text || identity.toLowerCase() === query.text) return 0;
  const matches = (text: string): boolean => {
    if (text.toLowerCase().includes(query.text)) return true;
    if (query.words.length === 0) return false;
    // Query words contain no separators, so a match cannot cross the spaces between
    // catalog words. Native substring search avoids scanning every token in JavaScript
    // for each term in a long query.
    const tokenText = words(text).join(" ");
    return query.words.every((needle) => tokenText.includes(needle));
  };
  if (matches(names)) return 1;
  const titled = `${names}\n${metadata.title ?? ""}\n${annotationTitle(metadata) ?? ""}`;
  if (matches(titled)) return 2;
  if (matches(`${titled}\n${metadata.description ?? ""}`)) return 3;
  return undefined;
};

export interface McpRankedCandidate {
  readonly rank: number;
  readonly server: string;
  readonly metadata: McpSearchMetadata;
  readonly id: string;
}
export const compareDiscoveryCandidates = (
  left: McpRankedCandidate,
  right: McpRankedCandidate,
): number =>
  left.rank - right.rank ||
  compareDiscoveryText(left.server, right.server) ||
  compareDiscoveryText(left.metadata.name, right.metadata.name) ||
  compareDiscoveryText(left.id, right.id);
