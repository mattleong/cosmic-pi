/** Pure slash-command argument dispatch shared by extension settings surfaces. */

export interface SettingsDispatchDescriptor {
  readonly id: string;
  readonly values?: ReadonlyArray<string> | undefined;
}

/**
 * The closed result set of a `/…-settings <args>` invocation. Hosts own every side effect:
 * opening pickers, printing help/diagnostics, applying values, and wording error messages.
 */
export type SettingsCommandDispatch =
  | { readonly _tag: "OpenInteractive" }
  | { readonly _tag: "Help" }
  | { readonly _tag: "Diagnostics" }
  | { readonly _tag: "Apply"; readonly id: string; readonly value: string }
  | { readonly _tag: "Invalid"; readonly reason: "missing-value"; readonly id: string }
  | { readonly _tag: "Invalid"; readonly reason: "unknown-setting"; readonly id: string }
  | {
      readonly _tag: "Invalid";
      readonly reason: "invalid-value";
      readonly id: string;
      readonly value: string;
      readonly allowedValues: ReadonlyArray<string>;
    };

/**
 * Dispatches settings-command arguments against option descriptors. Verbs are exact:
 * empty input opens the interactive surface, `help`/`diagnostics` are the only reserved
 * words (no hidden aliases), and finite descriptor values must match exactly.
 */
export const dispatchSettingsCommand = (
  args: string,
  descriptors: ReadonlyArray<SettingsDispatchDescriptor>,
): SettingsCommandDispatch => {
  const trimmed = args.trim();
  if (!trimmed) return { _tag: "OpenInteractive" };
  if (trimmed === "help") return { _tag: "Help" };
  if (trimmed === "diagnostics") return { _tag: "Diagnostics" };
  const [id = "", ...parts] = trimmed.split(/\s+/);
  const value = parts.join(" ").trim();
  if (!value) return { _tag: "Invalid", reason: "missing-value", id };
  const descriptor = descriptors.find((candidate) => candidate.id === id);
  if (!descriptor) return { _tag: "Invalid", reason: "unknown-setting", id };
  if (descriptor.values && !descriptor.values.includes(value)) {
    return {
      _tag: "Invalid",
      reason: "invalid-value",
      id,
      value,
      allowedValues: descriptor.values,
    };
  }
  return { _tag: "Apply", id, value };
};
