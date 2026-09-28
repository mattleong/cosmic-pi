/** `tools.$codemode.search`: the always-registered discovery tool and its index. */
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import { inputProperties } from "./tool-schema.js";
import type { Definition } from "./tool.js";
import {
  compareText,
  type DescribedTool,
  describeDefinition,
  type HostTools,
  reservedNamespace,
  visibleDefinitions,
  ancestorDescriptions,
} from "./tool-tree.js";

const defaultSearchLimit = 10;

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

const NonNegativeInt = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Longest search query; discovery terms are short, and scoring is synchronous. */
const maxSearchQueryLength = 512;

/** Distinct terms scored per search, bounding work at terms x tools. */
const maxSearchTerms = 32;

const SearchInput = Schema.Struct({
  query: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(maxSearchQueryLength))),
  namespace: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(PositiveInt),
  offset: Schema.optionalKey(NonNegativeInt),
});

const SearchItem = Schema.Struct({
  path: Schema.String,
  description: Schema.String,
  signature: Schema.String,
});

const SearchOutput = Schema.Struct({
  items: Schema.Array(SearchItem),
  remaining: NonNegativeInt,
  next: Schema.NullOr(Schema.Struct({ offset: NonNegativeInt })),
});

export type SearchEntry = {
  readonly description: DescribedTool;
  /** Top-level namespace (first path segment); the search `namespace` option also matches deeper path prefixes. */
  readonly namespace: string;
  /** Lowercased path + description + input property names/descriptions, for substring matching. */
  readonly searchText: string;
};

/**
 * Split a query into lowercased search terms. camelCase boundaries are split
 * (`resolveLibrary` -> `resolve library`) and every non-alphanumeric character is a
 * separator, so `resolve-library-id`, `resolveLibraryId`, and `resolve library id` all
 * tokenize alike. Empties and the `*` wildcard are dropped.
 */
const tokenize = (query: string): Array<string> =>
  query
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((term) => term.length > 0 && term !== "*");

/**
 * A term plus its naive singular variants (trailing "s"/"es" stripped), so a plural
 * query term ("issues") still matches indexed text that only carries the singular
 * ("issue"). Matching is one-directional substring containment, so the variants are
 * needed only on the query side; scoring weights are unchanged - each field check
 * passes when ANY form matches.
 */
const termForms = (term: string): Array<string> => {
  const forms = [term];
  if (term.endsWith("es") && term.length > 3) forms.push(term.slice(0, -2));
  if (term.endsWith("s") && term.length > 2) forms.push(term.slice(0, -1));
  return forms;
};

export const makeSearchTool = (searchIndex: ReadonlyArray<SearchEntry>): Definition => ({
  _tag: "CodeModeTool",
  description: "Search available Code Mode tools",
  input: SearchInput,
  output: SearchOutput,
  run: (input) =>
    Effect.sync(() => {
      // SAFETY: The value is constructed by the typed owner on this path and satisfies the asserted domain contract.
      const request = input as typeof SearchInput.Type;
      const query = request.query ?? "";
      const offset = request.offset ?? 0;
      const namespace = request.namespace;
      const scoped =
        namespace === undefined
          ? searchIndex
          : searchIndex.filter(
              (entry) =>
                entry.namespace === namespace || entry.description.path.startsWith(`${namespace}.`),
            );
      // A query that names one tool path exactly (canonical path or rendered JavaScript
      // expression) is a lookup, not a search: return that tool alone.
      const trimmed = query.trim();
      const pathQuery = trimmed.startsWith("tools.") ? trimmed.slice("tools.".length) : trimmed;
      const exact =
        pathQuery === ""
          ? undefined
          : (scoped.find((entry) => entry.description.callablePath === trimmed) ??
            scoped.find((entry) => entry.description.path === pathQuery));
      const terms = [...new Set(tokenize(query))].slice(0, maxSearchTerms).map(termForms);
      // Additive field-weighted scoring, summed across terms: exact path or path segment
      // (20) > path substring (8) > description substring (4) > any searchable text,
      // including input parameter names and descriptions (2).
      const ranked =
        exact !== undefined
          ? [exact]
          : scoped
              .map((entry) => {
                const path = entry.description.path.toLowerCase();
                const description = entry.description.description.toLowerCase();
                const score = terms.reduce(
                  (total, forms) =>
                    total +
                    (forms.some((form) => path === form || path.endsWith(`.${form}`)) ? 20 : 0) +
                    (forms.some((form) => path.includes(form)) ? 8 : 0) +
                    (forms.some((form) => description.includes(form)) ? 4 : 0) +
                    (forms.some((form) => entry.searchText.includes(form)) ? 2 : 0),
                  0,
                );
                return { entry, score };
              })
              .filter(({ score }) => terms.length === 0 || score > 0)
              .sort(
                (left, right) =>
                  right.score - left.score ||
                  compareText(
                    left.entry.description.callablePath,
                    right.entry.description.callablePath,
                  ),
              )
              .map(({ entry }) => entry);
      const items = ranked
        .slice(offset, offset + (request.limit ?? defaultSearchLimit))
        .map(({ description }) => ({
          path: description.callablePath,
          description: description.description,
          signature: description.signature,
        }));
      const remaining = Math.max(0, ranked.length - offset - items.length);
      return {
        items,
        remaining,
        next: remaining > 0 ? { offset: offset + items.length } : null,
      };
    }),
});

export const searchDescription = describeDefinition(
  [reservedNamespace, "search"],
  makeSearchTool([]),
);

export const toSearchEntry = <R>(
  path: ReadonlyArray<string>,
  definition: Definition<R>,
  description: DescribedTool,
  namespaceDescriptions: ReadonlyArray<string> = [],
): SearchEntry => ({
  description,
  namespace: path[0]!,
  searchText: [
    path.join("."),
    definition.description,
    ...namespaceDescriptions,
    ...inputProperties(definition).flatMap(({ name, description: property }) =>
      property === undefined ? [name] : [name, property],
    ),
  ]
    .join("\n")
    .toLowerCase(),
});

/** The runtime search index over every described tool. Search is always registered. */
export const searchIndex = <R>(tools: HostTools<R>): ReadonlyArray<SearchEntry> =>
  visibleDefinitions(tools).map(({ path, definition, description }) =>
    toSearchEntry(path, definition, description, ancestorDescriptions(tools, path)),
  );
