import { clipText, sanitizeTerminalLine } from "pi-cosmic-core";
import type { SubagentRuntime } from "../domain/routing.ts";

type LocalCliRuntime = Extract<SubagentRuntime, "claude" | "codex">;

export const LOCAL_CLI_LABELS = {
  claude: "Claude Code",
  codex: "Codex",
} as const satisfies Record<LocalCliRuntime, string>;

/**
 * The oldest releases that accept every flag, setting, and protocol shape the adapters send.
 * Claude Code 2.1.224 added the `crossSessionInbound` setting the harness uses to refuse
 * cross-session input (`--forward-subagent-text` arrived in 2.1.211). Codex 0.145.0 is the
 * app-server v2 subset the adapter was generated from; `--strict-config` rejects older releases
 * that do not know every feature key in the private configuration.
 */
export const LOCAL_CLI_MINIMUM_VERSIONS = {
  claude: "2.1.224",
  codex: "0.145.0",
} as const satisfies Record<LocalCliRuntime, string>;

export type LocalCliVersion =
  | { readonly status: "supported" | "unsupported"; readonly version: string }
  | { readonly status: "unrecognized"; readonly output: string }
  | { readonly status: "unavailable" };

const MAX_SHOWN_OUTPUT_CHARS = 80;

// Release formats vary (semver plus suffixes, calendar versions), so only the first dotted
// triple is read and anything else is left unjudged.
export const parseCliVersion = (output: string): string | undefined =>
  /\d+\.\d+\.\d+/u.exec(output)?.[0];

const compareVersions = (left: string, right: string): number => {
  const leftParts = left.split(".").map(Number);
  const rightParts = right.split(".").map(Number);
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
