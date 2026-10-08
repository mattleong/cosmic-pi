export interface ProjectionOwnership {
  readonly key: symbol;
  readonly generation: number;
}

let nextProjectionGeneration = 0;

/** Monotonic process-local ownership for synchronous session projections. */
export function acquireProjectionOwnership(label: string): ProjectionOwnership {
  nextProjectionGeneration += 1;
  return { key: Symbol(label), generation: nextProjectionGeneration };
}

/**
 * A process-local projection only its newest session may fill. A newly acquired owner takes over
 * immediately with empty fields; retired or stale owners can neither write nor clear it.
 */
export function ownedProjectionSlot<Fields extends object>() {
  let owner: ProjectionOwnership | undefined;
  let newestGeneration = 0;
  let fields: Partial<Fields> = {};
  return {
    read: (): Partial<Fields> => fields,
    write(claimant: ProjectionOwnership, update: Partial<Fields>): void {
      if (owner?.key !== claimant.key) {
        if (claimant.generation <= newestGeneration) return;
        newestGeneration = claimant.generation;
        owner = claimant;
        fields = {};
      }
      fields = { ...fields, ...update };
    },
    clear(claimant: ProjectionOwnership): void {
      if (owner?.key !== claimant.key) return;
      owner = undefined;
      fields = {};
    },
  };
}
