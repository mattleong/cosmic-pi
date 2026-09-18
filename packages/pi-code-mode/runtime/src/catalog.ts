/** Discovery metadata only. Snapshots never grant execution authority or mutate tools. */
export type CatalogEntry = {
  readonly path: string;
  readonly signature: string;
  readonly description: string;
};

export type CatalogSnapshot = {
  readonly complete: boolean;
  /** Canonical branch expressions; topology changes require replacement. */
  readonly namespacePaths: ReadonlyArray<string>;
  readonly namespaces: ReadonlyArray<{ readonly name: string; readonly total: number }>;
  /** Only entries selected by the discovery budget, not the entire searchable catalog. */
  readonly entries: ReadonlyArray<CatalogEntry>;
  readonly instructions: string;
};

export type CatalogUpdate =
  | { readonly kind: "unchanged" }
  | { readonly kind: "replace"; readonly snapshot: CatalogSnapshot }
  | {
      readonly kind: "delta";
      readonly added: ReadonlyArray<CatalogEntry>;
      readonly changed: ReadonlyArray<CatalogEntry>;
      readonly removed: ReadonlyArray<string>;
      readonly namespaces: CatalogSnapshot["namespaces"];
    };

/** Compare bounded discovery projections. A missing baseline always requires full instructions.
 * Consumers must retain the current snapshot, not reconstruct it from provider-visible schemas.
 * Deltas cannot replace the complete tool definitions required by an LLM provider.
 */
export const catalogUpdate = (
  current: CatalogSnapshot,
  previous?: CatalogSnapshot,
): CatalogUpdate => {
  if (previous === undefined) return { kind: "replace", snapshot: current };
  if (JSON.stringify(previous) === JSON.stringify(current)) return { kind: "unchanged" };
  const namespaceNames = (snapshot: CatalogSnapshot) => snapshot.namespaces.map(({ name }) => name);
  if (
    current.complete !== previous.complete ||
    JSON.stringify(current.namespacePaths) !== JSON.stringify(previous.namespacePaths) ||
    JSON.stringify(namespaceNames(current)) !== JSON.stringify(namespaceNames(previous))
  )
    return { kind: "replace", snapshot: current };

  const before = new Map(previous.entries.map((entry) => [entry.path, entry]));
  const after = new Set(current.entries.map((entry) => entry.path));
  const added = current.entries.filter((entry) => !before.has(entry.path));
  const changed = current.entries.filter((entry) => {
    const old = before.get(entry.path);
    return (
      old !== undefined &&
      (old.signature !== entry.signature || old.description !== entry.description)
    );
  });
  const removed = previous.entries
    .filter((entry) => !after.has(entry.path))
    .map(({ path }) => path);
  // Policy/instruction changes cannot be conveyed by signature-only deltas.
  const policy = (snapshot: CatalogSnapshot) =>
    snapshot.instructions.split("\n## Available tools", 1)[0];
  if (policy(current) !== policy(previous)) return { kind: "replace", snapshot: current };
  const delta: CatalogUpdate = {
    kind: "delta",
    added,
    changed,
    removed,
    namespaces: current.namespaces,
  };
  // Large updates are cheaper and less ambiguous as a fresh bounded catalog.
  return JSON.stringify(delta).length < JSON.stringify(current).length
    ? delta
    : { kind: "replace", snapshot: current };
};
