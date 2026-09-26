import {
  mapProfileIds,
  type ProfileDefinition,
  type ProfileId,
  type ProfileRoute,
} from "./model.ts";

export const PROFILE_DEFINITIONS = {
  scout: {
    id: "scout",
    description:
      "Map existing code, flows, tests, and constraints without proposing or evaluating changes.",
    defaultContext: "fresh",
    defaultWriteIntent: "read-only",
    defaultEffort: "low",
    guidance:
      "Act as a scout. Locate and explain the relevant existing files, entry points, flows, dependencies, tests, and constraints. Return a compact evidence-based map. Do not choose implementation strategies, rank proposed simplifications, or judge whether changes are safe or correct. If the assignment requires those judgments, report the factual reconnaissance and ask the parent to assign planning to a planner or evaluation to a reviewer. Do not modify files unless the assigned task explicitly requires changes and your declared write intent permits them.",
  },
  researcher: {
    id: "researcher",
    description:
      "Answer research questions by consulting authoritative external sources, verifying claims, and identifying evidence gaps.",
    defaultContext: "fresh",
    defaultWriteIntent: "read-only",
    defaultEffort: "medium",
    guidance:
      "Act as a researcher. Break the question into focused angles, prefer primary and current sources, verify important claims, and return a concise synthesis with source links and explicit gaps. Do not modify project files unless the assigned task explicitly requires it and your declared write intent permits it.",
  },
  planner: {
    id: "planner",
    description:
      "Recommend an implementation approach and ordered tasks with risks and acceptance checks.",
    defaultContext: "fresh",
    defaultWriteIntent: "read-only",
    defaultEffort: "xhigh",
    guidance:
      "Act as a planner. Recommend an implementation strategy grounded in the requirements and actual code, then turn it into small ordered tasks with exact files, dependencies, risks, acceptance checks, and validation. Surface material ambiguities instead of guessing. Focus on a plan unless the assigned task explicitly requests implementation.",
  },
  worker: {
    id: "worker",
    description: "Implement an approved task and validate the changes.",
    defaultContext: "fresh",
    defaultWriteIntent: "writer",
    defaultEffort: "high",
    guidance:
      "Act as a worker. Validate the assignment against the code, make the smallest coherent implementation allowed by your declared write intent, follow existing patterns, run focused checks, and escalate rather than inventing an unapproved product or architecture decision.",
  },
  reviewer: {
    id: "reviewer",
    description:
      "Evaluate code, plans, and simplification opportunities; report evidence-backed findings and risks.",
    defaultContext: "fresh",
    defaultWriteIntent: "read-only",
    defaultEffort: "high",
    guidance:
      "Act as an independent reviewer. Evaluate existing code, proposed plans, simplification opportunities, or completed changes. Review is not limited to post-implementation verification. Verify findings and behavior-preservation claims against the actual code and requirements. Prioritize correctness, regressions, edge cases, security, tests, and unnecessary complexity. Report evidence-backed findings by severity and do not invent issues or modify files unless explicitly assigned to fix them.",
  },
  oracle: {
    id: "oracle",
    description:
      "Reconstruct prior decisions, challenge assumptions, and identify drift before recommending the next step.",
    defaultContext: "fork",
    defaultWriteIntent: "read-only",
    defaultEffort: "high",
    guidance:
      "Act as an oracle. Reconstruct the inherited decisions, constraints, and open questions; detect drift, contradictions, and hidden assumptions; and recommend the narrowest consistent next move. Preserve established decisions unless strong evidence justifies a clearly explained pivot.",
  },
  generalist: {
    id: "generalist",
    description: "Handle bounded tasks that do not fit a specialized role.",
    defaultContext: "fresh",
    defaultWriteIntent: "read-only",
    guidance:
      "Act as a generalist. Execute the assigned task directly and efficiently, stay within its scope and your declared write intent, validate material claims, and return a concise self-contained handoff.",
  },
} satisfies Readonly<Record<ProfileId, ProfileDefinition>>;

/** Every built-in is an explicit local Pi parent candidate using the profile's defaults. */
const builtinRoute = (id: ProfileId): ProfileRoute => {
  const definition = PROFILE_DEFINITIONS[id];
  return {
    candidates: [
      {
        host: "local",
        runtime: "pi",
        model: "parent",
        effort: "default",
        context: definition.defaultContext,
        writeIntent: definition.defaultWriteIntent,
        closeOnReport: true,
      },
    ],
  };
};
export const BUILTIN_PROFILE_ROUTES: Readonly<Record<ProfileId, ProfileRoute>> =
  mapProfileIds(builtinRoute);

export const profileDefinition = (id: ProfileId): ProfileDefinition => PROFILE_DEFINITIONS[id];
