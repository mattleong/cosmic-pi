/**
 * Every bound the v1 Activity protocol enforces. Schemas validate against these, and producers
 * clip to them before publishing so a long title or a crowded workflow is never rejected.
 */
export const ACTIVITY_LIMITS = Object.freeze({
  /** Items in one provider snapshot. */
  items: 512,
  /** Display phases on one workflow item. */
  phases: 32,
  /** Actions one item offers. */
  actions: 16,
  /** Item, action and parent ids, and revisions. */
  id: 256,
  /** Item titles. */
  title: 512,
  /** Item routes. */
  route: 512,
  /** Agent profile names. */
  profile: 80,
  /** Phase titles, and the phase an item names. */
  phaseTitle: 160,
  /** Summaries, phase details, action labels and confirmations. */
  text: 4096,
  /** Item detail. */
  detail: 16384,
  /** Producer counts: phase work, planned agents and unphased planned agents. */
  count: 1_000_000,
  /** Active launch requests a provider reports. */
  starting: 16384,
} as const);
