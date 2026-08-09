const ASSIGNMENT_PREFIX = "Begin supervisor assignment epoch ";
const ASSIGNMENT_PATTERN = /^Begin supervisor assignment epoch ([1-9][0-9]{0,14})\.(?:\r?\n|$)/u;

export const herdrAssignmentEpochLine = (epoch: number): string =>
  `${ASSIGNMENT_PREFIX}${epoch.toString()}.`;

/** Extract only the fixed leading supervisor epoch marker; assignment body text cannot spoof it. */
export const herdrAssignmentEpoch = (text: string): number | undefined => {
  const match = ASSIGNMENT_PATTERN.exec(text);
  if (!match?.[1]) return undefined;
  const epoch = Number(match[1]);
  return Number.isSafeInteger(epoch) && epoch > 0 ? epoch : undefined;
};
