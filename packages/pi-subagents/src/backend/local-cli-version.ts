import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { clipText } from "pi-cosmic-core/display";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { SubagentRuntime } from "../domain/routing.ts";

type LocalCliRuntime = Extract<SubagentRuntime, "claude">;

export const LOCAL_CLI_LABELS = {
  claude: "Claude Code",
} as const satisfies Record<LocalCliRuntime, string>;

/**
 * The oldest releases that accept every flag, setting, and protocol shape the adapter sends.
 * Claude Code 2.1.224 added the `crossSessionInbound` setting the harness uses to refuse
 * cross-session input (`--forward-subagent-text` arrived in 2.1.211).
 */
export const LOCAL_CLI_MINIMUM_VERSIONS = {
  claude: "2.1.224",
} as const satisfies Record<LocalCliRuntime, string>;

export type LocalCliVersion =
  | { readonly status: "supported" | "unsupported"; readonly version: string }
  | { readonly status: "unrecognized"; readonly output: string }
  | { readonly status: "unavailable" };

const MAX_SHOWN_OUTPUT_CHARS = 80;

// Release formats vary (semver plus suffixes, calendar versions), so only the first dotted
// triple is read and anything else is left unjudged.
const parseCliVersion = (output: string): string | undefined => /\d+\.\d+\.\d+/u.exec(output)?.[0];

const compareVersions = (left: string, right: string): number => {
  const leftParts = Arr.map(Str.split(left, "."), Number);
  const rightParts = Arr.map(Str.split(right, "."), Number);
  for (const [index, part] of leftParts.entries()) {
    const difference = part - (rightParts[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
};

export const classifyCliVersion = (runtime: LocalCliRuntime, output: string): LocalCliVersion => {
  const version = parseCliVersion(output);
  if (version === undefined)
    return {
      status: "unrecognized",
      output: clipText(sanitizeTerminalLine(output), MAX_SHOWN_OUTPUT_CHARS),
    };
  return {
    status:
      compareVersions(version, LOCAL_CLI_MINIMUM_VERSIONS[runtime]) >= 0
        ? "supported"
        : "unsupported",
    version,
  };
};
