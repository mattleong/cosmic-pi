/** Pure slash-command argument dispatch shared by extension settings surfaces. */

export interface SettingsDispatchDescriptor {
  readonly id: string;
  readonly values?: ReadonlyArray<string> | undefined;
  /**
   * Accepts values beyond `values`, which are then suggestions, such as any in-range integer.
   * The provider validates the value when it applies it.
   */
  readonly openValues?: boolean | undefined;
}

/**
 * The closed result set of a `/…-settings <args>` invocation. Callers own every side effect:
 * opening pickers, printing help or status, applying values, and wording error messages.
 * Every extension's settings command shares one caller, Cosmic UI's settings command shell.
 */
export type SettingsCommandDispatch =
  | { readonly _tag: "OpenInteractive" }
  | { readonly _tag: "Help" }
  | { readonly _tag: "Status" }
  | {
      readonly _tag: "Apply";
      readonly id: string;
      readonly value: string;
      readonly scope?: string | undefined;
    }
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
 * Dispatches settings-command arguments against option descriptors. Verbs are exact: empty
 * input opens the interactive surface, `help` and `status` are the only reserved words (no
 * hidden aliases), an optional leading scope token selects one of `scopes`, and finite
 * descriptor values must match exactly unless the descriptor accepts open values.
 */
export const dispatchSettingsCommand = (
  args: string,
  descriptors: ReadonlyArray<SettingsDispatchDescriptor>,
  scopes: ReadonlyArray<string> = [],
): SettingsCommandDispatch => {
  const trimmed = args.trim();
  if (!trimmed) return { _tag: "OpenInteractive" };
  if (trimmed === "help") return { _tag: "Help" };
  if (trimmed === "status") return { _tag: "Status" };
  const tokens = trimmed.split(/\s+/);
  const scope = scopes.includes(tokens[0] ?? "") ? tokens.shift() : undefined;
  const [id = "", ...parts] = tokens;
  const value = parts.join(" ").trim();
  if (!value) return { _tag: "Invalid", reason: "missing-value", id };
  const descriptor = descriptors.find((candidate) => candidate.id === id);
  if (!descriptor) return { _tag: "Invalid", reason: "unknown-setting", id };
  if (descriptor.values && !descriptor.openValues && !descriptor.values.includes(value)) {
    return {
      _tag: "Invalid",
      reason: "invalid-value",
      id,
      value,
      allowedValues: descriptor.values,
    };
  }
  return { _tag: "Apply", id, value, ...(scope !== undefined && { scope }) };
};
