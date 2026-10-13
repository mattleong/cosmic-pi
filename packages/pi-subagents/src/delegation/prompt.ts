import type { DelegationMode } from "../config/schema.ts";

/** Structured system-prompt section that carries non-default delegation guidance. */
export const DELEGATION_PROMPT_SECTION = "subagent_delegation";

/**
 * The root session's `subagent_start` guideline that decides when to delegate. Each mode
 * supplies its own replacement so the prompt never pairs orchestration with the default
 * batch-size advice.
 */
export const NORMAL_START_GUIDELINE =
  "Before substantial work, check for independent workstreams. When two or more exist, use subagent_start early to launch one to three read-only subagents in one batch; skip subagent_start only for trivial or tightly serial tasks.";

/** Nested children already hold a bounded slice, so their delegation rule is restrained. */
export const NESTED_START_GUIDELINE =
  "Your parent assigned you a bounded task. Start subagents only for clearly independent slices that are worth briefing; most assignments need none.";

export interface DelegationPrompt {
  readonly startGuideline: string;
  readonly section?: string | undefined;
}

const DELEGATION_PROMPTS = {
  normal: { startGuideline: NORMAL_START_GUIDELINE },
  encouraged: {
    startGuideline:
      "Before any task beyond a quick lookup or a small edit, find the slices that can run independently and launch them together with subagent_start. Work directly only when the task is tightly serial, needs the user, or is faster to do than to brief.",
    section:
      "The user wants more delegation in this session. Hand exploration, research, planning, review, and well-scoped implementation to subagents, and keep the main thread for decisions, integration, and conversation with the user.",
  },
  orchestration: {
    startGuideline:
      "Delegate by default: break each request into self-contained assignments and launch them with subagent_start, in parallel where they are independent.",
    section: [
      "You are the orchestrator for this session. Delegate nearly all substantive work, including exploration, research, planning, implementation, and review, to subagents. Keep your own context for decomposition, coordination, verification, and conversation with the user.",
      "- Read only enough to write precise, self-contained tasks; let subagents explore in depth.",
      "- Use worker for implementation and reviewer to check substantial results before you report them.",
      "- Act directly only for trivial steps, such as a one-line fix or a quick check, or when briefing would cost more than doing.",
      "- Verify subagent output yourself, by reading diffs and running tests, before calling work done.",
    ].join("\n"),
  },
} as const satisfies Record<DelegationMode, DelegationPrompt>;

export const delegationPrompt = (mode: DelegationMode): DelegationPrompt =>
  DELEGATION_PROMPTS[mode];
