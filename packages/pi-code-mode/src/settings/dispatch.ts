/** Pure argument dispatch for `/code-mode-settings`. Hosts own every side effect. */
import type { CodeModeSettingScope } from "../config/options.ts";

export type CodeModeSettingsDispatch =
  | { readonly _tag: "OpenInteractive" }
  | { readonly _tag: "Help" }
  | { readonly _tag: "Status" }
  | {
      readonly _tag: "Apply";
      readonly scope: CodeModeSettingScope;
      readonly id: string;
      readonly value: string;
    }
  | { readonly _tag: "Clear"; readonly scope: CodeModeSettingScope; readonly id: string }
  | { readonly _tag: "Invalid" };

/**
 * Grammar: empty opens the interactive surface; `help` and `status` (alias `diagnostics`) are
 * reserved; an optional leading `global`/`project` token selects the scope (default `global`);
 * the literal value `inherit` clears the field in the selected scope.
 */
export const dispatchCodeModeSettings = (args: string): CodeModeSettingsDispatch => {
  const trimmed = args.trim();
  if (!trimmed) return { _tag: "OpenInteractive" };
  if (trimmed === "help") return { _tag: "Help" };
  if (trimmed === "status" || trimmed === "diagnostics") return { _tag: "Status" };
  const tokens = trimmed.split(/\s+/);
  let scope: CodeModeSettingScope = "global";
  if (tokens[0] === "global" || tokens[0] === "project") {
    scope = tokens[0];
    tokens.shift();
  }
  const [id = "", ...parts] = tokens;
  if (!id) return { _tag: "Invalid" };
  const value = parts.join(" ").trim();
  if (!value) return { _tag: "Invalid" };
  if (value === "inherit") return { _tag: "Clear", scope, id };
  return { _tag: "Apply", scope, id, value };
};
