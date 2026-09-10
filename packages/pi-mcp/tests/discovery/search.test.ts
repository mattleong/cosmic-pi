import { expect, it } from "vitest";
import {
  compareDiscoveryCandidates,
  discoverySearchRank,
  prepareDiscoverySearch,
} from "../../src/discovery/search.ts";
import { summarizeTool } from "../../src/discovery/summary.ts";

it("ranks exact names, name tokens, titles and full descriptions in that order", () => {
  const search = prepareDiscoverySearch("READ file");
  const candidates = [
    { server: "a", name: "description", description: "Useful summary.\n\nRead a file." },
    { server: "a", name: "title", title: "Read file" },
    { server: "a", name: "read_file" },
    { server: "b", name: "READ file" },
  ].map((metadata) => ({
    metadata,
    server: metadata.server,
    id: metadata.name,
    rank: discoverySearchRank(search, metadata)!,
  }));
  expect(candidates.map((candidate) => candidate.rank)).toEqual([3, 2, 1, 0]);
  expect(candidates.sort(compareDiscoveryCandidates).map((candidate) => candidate.id)).toEqual([
    "READ file",
    "read_file",
    "title",
    "description",
  ]);
});

it.each(["readFile", "read_file", "read-file", "readHTTPFile", "FileReader"])(
  "matches multiword queries against camelCase, acronyms and separators: %s",
  (name) => {
    expect(discoverySearchRank(prepareDiscoverySearch("file read"), { name })).toBe(1);
  },
);

it("matches all query words across metadata fields, not just an adjacent phrase", () => {
  const metadata = { name: "read", title: "Remote files", description: "Retrieve archived items" };
  expect(discoverySearchRank(prepareDiscoverySearch("remote read"), metadata)).toBe(2);
  expect(discoverySearchRank(prepareDiscoverySearch("archived remote read"), metadata)).toBe(3);
  expect(discoverySearchRank(prepareDiscoverySearch("remote delete"), metadata)).toBeUndefined();
});

it("searches beyond title/description summaries and recognizes both title sources", () => {
  const metadata = {
    name: "run",
    title: "t".repeat(150) + " titleNeedle",
    description: "d".repeat(550) + " lengthNeedle\n\nparagraphNeedle",
    annotations: { title: "annotationNeedle" },
  };
  const excerpt = JSON.stringify(summarizeTool("a", metadata));
  for (const query of ["titleNeedle", "lengthNeedle", "paragraphNeedle", "annotationNeedle"]) {
    expect(excerpt).not.toContain(query);
    expect(discoverySearchRank(prepareDiscoverySearch(query), metadata)).toBeDefined();
  }
});

it("retains substring and URI matching without requiring words for punctuation-only queries", () => {
  expect(discoverySearchRank(prepareDiscoverySearch("lph"), { name: "alpha" })).toBe(1);
  expect(
    discoverySearchRank(
      prepareDiscoverySearch("mcp://host/archive"),
      { name: "resource" },
      "mcp://host/archive",
    ),
  ).toBe(0);
  expect(
    discoverySearchRank(prepareDiscoverySearch("://"), { name: "resource" }, "mcp://host/archive"),
  ).toBe(1);
  expect(discoverySearchRank(prepareDiscoverySearch("///"), { name: "resource" })).toBeUndefined();
  expect(discoverySearchRank(prepareDiscoverySearch(" \t "), { name: "anything" })).toBe(0);
});

it("handles long repeated or reordered queries without requiring duplicate catalog words", () => {
  const terms = Array.from({ length: 100 }, (_, index) => `needle${index}`);
  const metadata = {
    name: "record",
    description: `${"ordinary ".repeat(6_000)} ${terms.join(" ")}`,
  };
  expect(discoverySearchRank(prepareDiscoverySearch("needle99 ".repeat(100)), metadata)).toBe(3);
  expect(
    discoverySearchRank(prepareDiscoverySearch([...terms].reverse().join(" ")), metadata),
  ).toBe(3);
  expect(discoverySearchRank(prepareDiscoverySearch("needle99 missing"), metadata)).toBeUndefined();
  expect(
    discoverySearchRank(prepareDiscoverySearch("readfile other"), { name: "read_file_other" }),
  ).toBeUndefined();
});

it("breaks ranking ties by exact server, name and identity independently of source order", () => {
  const candidates = [
    { server: "b", metadata: { name: "a" }, id: "uri-a", rank: 1 },
    { server: "a", metadata: { name: "b" }, id: "uri-a", rank: 1 },
    { server: "a", metadata: { name: "a" }, id: "uri-z", rank: 1 },
    { server: "a", metadata: { name: "a" }, id: "uri-a", rank: 1 },
  ];
  const sorted = [...candidates].sort(compareDiscoveryCandidates);
  expect(sorted).toEqual([...candidates].reverse());
  expect([...candidates].reverse().sort(compareDiscoveryCandidates)).toEqual(sorted);
});
