import * as Data from "effect/Data";

interface SettingsDispatchDescriptor {
  readonly id: string;
  readonly values?: ReadonlyArray<string> | undefined;
  readonly openValues?: boolean | undefined;
}

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
export const SettingsCommandDispatch = Data.taggedEnum<SettingsCommandDispatch>();

export const dispatchSettingsCommand = (
  args: string,
  descriptors: ReadonlyArray<SettingsDispatchDescriptor>,
  scopes: ReadonlyArray<string> = [],
): SettingsCommandDispatch => {
  const trimmed = args.trim();
  if (!trimmed) return SettingsCommandDispatch.OpenInteractive();
  if (trimmed === "help") return SettingsCommandDispatch.Help();
  if (trimmed === "status") return SettingsCommandDispatch.Status();
  const tokens = trimmed.split(/\s+/);
  const scope = scopes.includes(tokens[0] ?? "") ? tokens.shift() : undefined;
  const [id = "", ...parts] = tokens;
  const value = parts.join(" ").trim();
  if (!value) return SettingsCommandDispatch.Invalid({ reason: "missing-value", id });
  const descriptor = descriptors.find((candidate) => candidate.id === id);
  if (!descriptor) return SettingsCommandDispatch.Invalid({ reason: "unknown-setting", id });
  if (descriptor.values && !descriptor.openValues && !descriptor.values.includes(value)) {
    return SettingsCommandDispatch.Invalid({
      reason: "invalid-value",
      id,
      value,
      allowedValues: descriptor.values,
    });
  }
  return SettingsCommandDispatch.Apply({ id, value, ...(scope !== undefined && { scope }) });
};
