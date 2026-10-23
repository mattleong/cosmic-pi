import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
import * as Schema from "effect/Schema";
import { completeSettingsArguments } from "pi-cosmic-core/settings-completion";
import {
  DELEGATION_MODES,
  MAX_DIRECT_CHILDREN,
  MAX_SUBAGENT_DEPTH,
  MIN_DIRECT_CHILDREN,
  MIN_ACTIVE_RUNS,
  MAX_ACTIVE_RUNS,
  MIN_SUBAGENT_DEPTH,
  WRITER_WORKSPACE_MODES,
  type SubagentNestingOverrides,
} from "../config/schema.ts";

export type NestingField = keyof SubagentNestingOverrides;

export const WORKSPACE = "writerWorkspace";
export const DELEGATION = "delegation";
export const INHERIT = "inherit";

export const DELEGATION_DESCRIPTION =
  "How much the main agent delegates to subagents. normal leaves its prompt unchanged, encouraged prefers subagents, and orchestration delegates nearly all substantive work.";

interface NestingFieldInfo {
  readonly label: string;
  readonly description: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly presets: readonly string[];
}

export const NESTING_FIELDS = {
  maxDirectChildren: {
    label: "max children",
    description: "How many subagents one subagent may start at a time.",
    minimum: MIN_DIRECT_CHILDREN,
    maximum: MAX_DIRECT_CHILDREN,
    presets: ["4", "8", "12", "16", "32"],
  },
  maxDepth: {
    label: "max depth",
    description: "How many levels of subagents may start further subagents.",
    minimum: MIN_SUBAGENT_DEPTH,
    maximum: MAX_SUBAGENT_DEPTH,
    presets: ["0", "1", "2", "3", "5", "8"],
  },
  maxActiveRuns: {
    label: "max active",
    description: "How many subagents may run at once across the whole tree.",
    minimum: MIN_ACTIVE_RUNS,
    maximum: MAX_ACTIVE_RUNS,
    presets: ["4", "8", "16", "32", "64"],
  },
} as const satisfies Record<NestingField, NestingFieldInfo>;

export const NESTING_FIELD_IDS = Rec.keys(NESTING_FIELDS);

export const isNestingField = Schema.is(Schema.Literals(NESTING_FIELD_IDS));

export const SCOPES = [
  { name: "session", description: "Change delegation and nesting limits for this session only" },
  {
    name: "global",
    description: "Change delegation and nesting limits for new sessions everywhere",
  },
  { name: "project", description: "Change delegation and nesting limits for this trusted project" },
] as const;

export const WORKSPACE_DESCRIPTION =
  "Default for writers that don't set isolation. Saved for new sessions.";

export const SUBAGENT_SETTING_DESCRIPTORS = [
  {
    id: WORKSPACE,
    description: WORKSPACE_DESCRIPTION,
    values: [...WRITER_WORKSPACE_MODES],
    currentValue: () => "",
  },
  {
    id: DELEGATION,
    description: DELEGATION_DESCRIPTION,
    values: [...DELEGATION_MODES, INHERIT],
    currentValue: () => "",
  },
  ...Arr.map(NESTING_FIELD_IDS, (field) => ({
    id: field,
    description: NESTING_FIELDS[field].description,
    values: [...NESTING_FIELDS[field].presets, INHERIT],
    openValues: true,
    currentValue: () => "",
  })),
];

export const SUBAGENT_SETTINGS_COMMAND = {
  name: "settings",
  description: "Configure delegation, the writer workspace, and nesting limits",
  complete: (prefix: string) =>
    completeSettingsArguments(
      prefix,
      SUBAGENT_SETTING_DESCRIPTORS,
      [
        { value: "status", label: "status", description: "Show effective values" },
        { value: "help", label: "help", description: "Show setting ids and usage" },
      ],
      Arr.map(SCOPES, (scope) => ({
        value: scope.name,
        label: scope.name,
        description: scope.description,
      })),
    ),
};
