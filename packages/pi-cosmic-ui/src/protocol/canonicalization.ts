import type { CosmicFooterContribution } from "./protocol.ts";

const canonicalContributions = new WeakSet<CosmicFooterContribution>();

/** Returns one detached, frozen contribution. Already-normalized values retain their identity. */
export const detachCosmicFooterContribution = (
  contribution: CosmicFooterContribution,
): CosmicFooterContribution => {
  if (canonicalContributions.has(contribution)) return contribution;
  const detached = Object.freeze({ ...contribution });
  canonicalContributions.add(detached);
  return detached;
};
