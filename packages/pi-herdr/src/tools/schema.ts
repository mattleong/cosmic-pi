import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";
import { HERDR_AGENT_KINDS } from "../herd/model.ts";

const NONBLANK_PATTERN = String.raw`\s*\S[\s\S]*`;
const MODEL_PATTERN = String.raw`^(?!-)[^\u0000-\u001f\u007f]+$`;

const RunIds = Type.Array(
  Type.String({
    minLength: 1,
    maxLength: 128,
    pattern: NONBLANK_PATTERN,
    description: "Managed run ID returned by herdr_agent_start or herdr_agent_list.",
  }),
  {
    minItems: 1,
    maxItems: 12,
    description: "One to twelve managed Herdr run IDs.",
  },
);

export const HerdrStartParameters = Type.Object(
  {
    agents: Type.Array(
      Type.Object(
        {
          kind: StringEnum(HERDR_AGENT_KINDS, {
            description: "Required managed agent runtime: Claude Code, Pi, or Codex CLI.",
          }),
          model: Type.String({
            minLength: 1,
            maxLength: 200,
            pattern: MODEL_PATTERN,
            description:
              "Required native model name for the selected runtime, such as sonnet, openai-codex/gpt-5.6-sol, or gpt-5.6-terra.",
          }),
          task: Type.String({
            minLength: 1,
            maxLength: 32_768,
            pattern: NONBLANK_PATTERN,
            description:
              "Self-contained read-only task with relevant paths, constraints, evidence to inspect, and a concrete deliverable.",
          }),
          name: Type.Optional(
            Type.String({
              minLength: 1,
              maxLength: 60,
              pattern: NONBLANK_PATTERN,
              description: "Optional short display name for the managed agent.",
            }),
          ),
        },
        { additionalProperties: false },
      ),
      {
        minItems: 1,
        maxItems: 12,
        description: "One to twelve independent read-only Claude Code, Pi, or Codex agents.",
      },
    ),
  },
  { additionalProperties: false },
);

export const HerdrListParameters = Type.Object(
  {
    limit: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 100,
        description: "Maximum rows to show per page. Defaults to 25.",
      }),
    ),
    offset: Type.Optional(
      Type.Integer({
        minimum: 0,
        maximum: 999,
        description:
          "Zero-based row offset for older retained runs. Defaults to 0; active and attention runs sort first.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const HerdrStatusParameters = Type.Object(
  { runIds: RunIds },
  { additionalProperties: false },
);

export const HerdrAwaitParameters = Type.Object(
  {
    runIds: RunIds,
    until: StringEnum(["all_finished", "any_finished"] as const, {
      description:
        "Return when every selected run is finished or when any selected run is finished. A blocked run returns early for attention.",
    }),
  },
  { additionalProperties: false },
);

export const HerdrReadParameters = Type.Object(
  {
    runId: Type.String({
      minLength: 1,
      maxLength: 128,
      pattern: NONBLANK_PATTERN,
      description: "Managed run ID to inspect.",
    }),
    source: Type.Optional(
      StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const, {
        description:
          "Herdr terminal source. Defaults to recent-unwrapped; detection is useful for agent-kind diagnostics.",
      }),
    ),
    lines: Type.Optional(
      Type.Integer({
        minimum: 1,
        maximum: 500,
        description: "Maximum terminal lines to read. Defaults to 120.",
      }),
    ),
  },
  { additionalProperties: false },
);

export const HerdrSendParameters = Type.Object(
  {
    runIds: RunIds,
    message: Type.String({
      minLength: 1,
      maxLength: 16_384,
      pattern: NONBLANK_PATTERN,
      description: "Additional guidance for active runs that have not submitted a final report.",
    }),
  },
  { additionalProperties: false },
);

export const HerdrStopParameters = Type.Object({ runIds: RunIds }, { additionalProperties: false });

export type HerdrStartInput = Static<typeof HerdrStartParameters>;
export type HerdrListInput = Static<typeof HerdrListParameters>;
export type HerdrStatusInput = Static<typeof HerdrStatusParameters>;
export type HerdrAwaitInput = Static<typeof HerdrAwaitParameters>;
export type HerdrReadInput = Static<typeof HerdrReadParameters>;
export type HerdrSendInput = Static<typeof HerdrSendParameters>;
export type HerdrStopInput = Static<typeof HerdrStopParameters>;
