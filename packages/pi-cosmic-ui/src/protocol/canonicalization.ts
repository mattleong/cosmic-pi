import type { CosmicFooterContribution } from "./protocol.ts";

const canonicalContributions = new WeakSet<CosmicFooterContribution>();

const freezeCanonical = <Contribution extends CosmicFooterContribution>(
  contribution: Contribution,
): Contribution => {
  Object.freeze(contribution);
  canonicalContributions.add(contribution);
  return contribution;
};

const callWithReceiver = <Receiver, Args extends unknown[], Result>(
  callback: (...args: Args) => Result,
  receiver: Receiver,
  args: Args,
): Result => Function.prototype.apply.call(callback, receiver, args);

export interface CosmicFooterCallbackReceiver {
  readonly value: object;
}

export const detachCosmicFooterContributionFromReceiver = (
  contribution: CosmicFooterContribution,
  callbackReceiver: CosmicFooterCallbackReceiver,
): CosmicFooterContribution => {
  if (canonicalContributions.has(contribution)) return contribution;
  const receiver = callbackReceiver.value;
  if (contribution.kind !== "surface") return freezeCanonical({ ...contribution });
  const detached = { ...contribution };
  const render = detached.render;
  detached.render = (options) => callWithReceiver(render, receiver, [options]);
  const attach = detached.attach;
  if (attach !== undefined) detached.attach = (host) => callWithReceiver(attach, receiver, [host]);
  const detach = detached.detach;
  if (detach !== undefined) detached.detach = () => callWithReceiver(detach, receiver, []);
  const invalidate = detached.invalidate;
  if (invalidate !== undefined)
    detached.invalidate = () => callWithReceiver(invalidate, receiver, []);
  const dispose = detached.dispose;
  if (dispose !== undefined) detached.dispose = () => callWithReceiver(dispose, receiver, []);
  return freezeCanonical(detached);
};

/**
 * Returns one detached, frozen contribution. Already-normalized values retain their identity.
 * Surface wrappers keep callbacks bound to the object that supplied them.
 */
export const detachCosmicFooterContribution = (
  contribution: CosmicFooterContribution,
): CosmicFooterContribution =>
  detachCosmicFooterContributionFromReceiver(contribution, { value: contribution });
