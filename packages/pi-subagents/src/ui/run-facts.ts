import * as Arr from "effect/Array";
import * as Str from "effect/String";
import { sanitizeTerminalLine } from "pi-cosmic-core/security";
import type { WriterWorkspaceMode } from "../config/schema.ts";
import type { SubagentWorkspaceOutcome } from "../run/model.ts";
import { workspaceOutcomeLabel } from "../tools/format.ts";
import { isTextFragment } from "../tools/text-fragments.ts";
import { formatRunRouteLine } from "./run-presentation.ts";

/**
 * The technical facts every surface lists for one agent in its expanded `Details`: one line of
 * short facts after the agent's name, such as `auth-review: agent-1 · reviewer → openai/gpt-5.5:high`,
 * then longer evidence such as a saved report file nested beneath it.
 */
export const agentFactLines = (
  name: string,
  facts: ReadonlyArray<string | false | undefined>,
  nested: ReadonlyArray<string | false | undefined> = [],
): ReadonlyArray<string> => {
  const summary = Arr.join(Arr.map(Arr.filter(facts, isTextFragment), sanitizeTerminalLine), " · ");
  const label = sanitizeTerminalLine(name);
  return [
    summary ? `${label}: ${summary}` : label,
    ...Arr.map(Arr.filter(nested, isTextFragment), (fact) => `  ${sanitizeTerminalLine(fact)}`),
  ];
};

/**
 * Saved display facts as {@link agentFactLines} lays them out: the first holds the short facts,
 * and each later one nests beneath it.
 */
export const savedAgentFactLines = (
  name: string,
  facts: ReadonlyArray<string>,
): ReadonlyArray<string> => agentFactLines(name, facts.slice(0, 1), facts.slice(1));

interface RunRoleInput {
  readonly agent?: string | undefined;
  readonly profile?: string | undefined;
}

/** A run's role: its profile, or its custom agent with the profile it resolved to. */
export const runRoleLabel = (run: RunRoleInput): string => {
  const profile = run.profile === undefined || run.profile === "" ? "generalist" : run.profile;
  return run.agent ? `${run.agent} (${profile})` : profile;
};

/** The route a run took, such as `reviewer → openai/gpt-5.5:high`. */
export const runRouteFact = (
  run: RunRoleInput & Omit<Parameters<typeof formatRunRouteLine>[0], "profile">,
): string => formatRunRouteLine({ ...run, profile: runRoleLabel(run) });

/** Where a writer writes: the shared checkout, or its worktree and that worktree's outcome. */
export const writerFact = (run: {
  readonly writeIntent?: string | undefined;
  readonly workspaceId?: string | undefined;
  readonly workspaceOutcome?: SubagentWorkspaceOutcome | undefined;
}): string | undefined => {
  if (run.workspaceId !== undefined) {
    const outcome = run.workspaceOutcome ? ` · ${workspaceOutcomeLabel(run.workspaceOutcome)}` : "";
    return `worktree ${sanitizeTerminalLine(run.workspaceId)}${outcome}`;
  }
  return run.writeIntent === "writer" ? "shared checkout writer" : undefined;
};

/** A writer workspace mode as people read it. */
export const WRITER_WORKSPACE_LABELS = {
  worktree: "Worktree",
  "shared-checkout": "Shared checkout",
} as const satisfies Record<WriterWorkspaceMode, string>;

/** The mode a typed or chosen value names: its ID, such as `shared-checkout`, or its label. */
export const writerWorkspaceModeOf = (value: string): WriterWorkspaceMode | undefined => {
  const wanted = Str.toLowerCase(Str.trim(value));
  if (wanted === "worktree") return "worktree";
  return wanted === "shared-checkout" ||
    wanted === Str.toLowerCase(WRITER_WORKSPACE_LABELS["shared-checkout"])
    ? "shared-checkout"
    : undefined;
};
