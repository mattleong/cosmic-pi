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
