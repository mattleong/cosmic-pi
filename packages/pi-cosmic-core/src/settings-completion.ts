/** Pure slash-command argument completion shared by extension settings surfaces. */

export interface SettingsCompletionDescriptor {
  readonly id: string;
  readonly description: string;
  readonly values?: ReadonlyArray<string> | undefined;
}

export interface SettingsCompletionChoice {
  readonly value: string;
  readonly label: string;
  readonly description: string;
}

/**
 * Completes `/…-settings` arguments against option descriptors plus caller-supplied extra
 * verbs (help/diagnostics), preserving descriptor order, case-insensitive prefix matching,
 * and the host contract of `null` (never an empty array) when nothing matches.
 */
export const completeSettingsArguments = (
  prefix: string,
  descriptors: ReadonlyArray<SettingsCompletionDescriptor>,
  extras: ReadonlyArray<SettingsCompletionChoice> = [],
): SettingsCompletionChoice[] | null => {
  const normalized = prefix.replace(/^\s+/, "");
  const [head = "", ...rest] = normalized.split(/\s+/);
  if (rest.length === 0 && !/\s$/.test(normalized)) {
    const query = head.toLowerCase();
    const choices = [
      ...descriptors.map((descriptor) => ({
        value: descriptor.id,
        label: descriptor.id,
        description: descriptor.description,
      })),
      ...extras,
    ];
    const matches = choices.filter((choice) => choice.value.toLowerCase().startsWith(query));
    return matches.length > 0 ? matches : null;
  }
  const descriptor = descriptors.find((entry) => entry.id === head);
  if (!descriptor) return null;
  const valuePrefix = (rest[0] ?? "").toLowerCase();
  const matches = (descriptor.values ?? [])
    .filter((value) => value.toLowerCase().startsWith(valuePrefix))
    .map((value) => ({
      value: `${head} ${value}`,
      label: `${head} ${value}`,
      description: descriptor.description,
    }));
  return matches.length > 0 ? matches : null;
};
