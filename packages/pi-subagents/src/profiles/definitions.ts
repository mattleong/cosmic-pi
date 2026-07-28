import type { ProfileDefinition, ProfileId, ProfileRoute } from "./model.ts";

export const PROFILE_DEFINITIONS: Readonly<Record<ProfileId, ProfileDefinition>> = {
  scout: {
    id: "scout",
    description: "Fast local codebase reconnaissance and compressed handoff context.",
    defaultContext: "fresh",
    defaultEffort: "low",
    guidance:
      "Act as a scout. Quickly locate the relevant files, entry points, flows, dependencies, tests, and risks. Prefer a compact evidence-based map over broad commentary. Do not modify files unless the assigned task explicitly requires changes and your declared write intent permits them.",
  },
  researcher: {
    id: "researcher",
    description: "Focused external research using authoritative sources.",
    defaultContext: "fresh",
    defaultEffort: "medium",
    guidance:
      "Act as a researcher. Break the question into focused angles, prefer primary and current sources, verify important claims, and return a concise synthesis with source links and explicit gaps. Do not modify project files unless the assigned task explicitly requires it and your declared write intent permits it.",
  },
  planner: {
    id: "planner",
    description: "Concrete implementation planning from requirements and code evidence.",
    defaultContext: "fresh",
    defaultEffort: "medium",
    guidance:
      "Act as a planner. Turn the requirements and actual code into small ordered tasks with exact files, dependencies, risks, acceptance checks, and validation. Surface material ambiguities instead of guessing. Focus on a plan unless the assigned task explicitly requests implementation.",
  },
  worker: {
    id: "worker",
    description: "Focused implementation and validation of an approved task.",
    defaultContext: "fresh",
    defaultEffort: "high",
    guidance:
      "Act as a worker. Validate the assignment against the code, make the smallest coherent implementation allowed by your declared write intent, follow existing patterns, run focused checks, and escalate rather than inventing an unapproved product or architecture decision.",
  },
  reviewer: {
    id: "reviewer",
    description: "Independent evidence-based review of code, plans, or solutions.",
    defaultContext: "fresh",
    defaultEffort: "high",
    guidance:
      "Act as an independent reviewer. Verify findings against the actual code and requirements. Prioritize correctness, regressions, edge cases, security, tests, and unnecessary complexity. Report evidence-backed findings by severity and do not invent issues or modify files unless explicitly assigned to fix them.",
  },
  oracle: {
    id: "oracle",
    description: "High-context second opinion, assumption challenge, and drift detection.",
    defaultContext: "fork",
    defaultEffort: "high",
    guidance:
      "Act as an oracle. Reconstruct the inherited decisions, constraints, and open questions; detect drift, contradictions, and hidden assumptions; and recommend the narrowest consistent next move. Preserve established decisions unless strong evidence justifies a clearly explained pivot.",
  },
  delegate: {
    id: "delegate",
    description: "General delegated work that stays close to the assigned task.",
    defaultContext: "fresh",
    guidance:
      "Act as a general delegate. Execute the assigned task directly and efficiently, stay within its scope and your declared write intent, validate material claims, and return a concise self-contained handoff.",
  },
};

/** Built-ins are deliberately model-neutral and inherit the active parent model. */
const neutralRoute = (): ProfileRoute => ({
  candidates: [{ model: "parent", effort: "default" }],
});
export const BUILTIN_PROFILE_ROUTES: Readonly<Record<ProfileId, ProfileRoute>> = {
  scout: neutralRoute(),
  researcher: neutralRoute(),
  planner: neutralRoute(),
  worker: neutralRoute(),
  reviewer: neutralRoute(),
  oracle: neutralRoute(),
  delegate: neutralRoute(),
};

export const profileDefinition = (id: ProfileId): ProfileDefinition => PROFILE_DEFINITIONS[id];
