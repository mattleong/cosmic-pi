interface SettingsDispatchDescriptor {
  readonly id: string;
  readonly values?: ReadonlyArray<string> | undefined;
  readonly openValues?: boolean | undefined;
}

type SettingsCommandDispatch =
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
