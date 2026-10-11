export const ACTIVITY_LIMITS = Object.freeze({
  items: 512,
  phases: 32,
  actions: 16,
  id: 256,
  title: 512,
  route: 512,
  profile: 80,
  phaseTitle: 160,
  text: 4096,
  detail: 16384,
  count: 1_000_000,
  starting: 16384,
} as const);
