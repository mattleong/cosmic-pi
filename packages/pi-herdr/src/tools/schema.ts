import { StringEnum } from "@earendil-works/pi-ai";
import { Type, type Static } from "typebox";

const RunIds = Type.Array(Type.String({ minLength: 1, maxLength: 128 }), {
  minItems: 1,
  maxItems: 12,
});

export const HerdrStartParameters = Type.Object(
  {
    agents: Type.Array(
      Type.Object(
        {
          task: Type.String({ minLength: 1, maxLength: 32_768 }),
          name: Type.Optional(Type.String({ minLength: 1, maxLength: 60 })),
        },
        { additionalProperties: false },
      ),
      { minItems: 1, maxItems: 12 },
    ),
  },
  { additionalProperties: false },
);

export const HerdrListParameters = Type.Object({}, { additionalProperties: false });

export const HerdrStatusParameters = Type.Object(
  { runIds: RunIds },
  { additionalProperties: false },
);

export const HerdrAwaitParameters = Type.Object(
  {
    runIds: RunIds,
    until: StringEnum(["all_finished", "any_finished"] as const),
  },
  { additionalProperties: false },
);

export const HerdrReadParameters = Type.Object(
  {
    runId: Type.String({ minLength: 1, maxLength: 128 }),
    source: Type.Optional(
      StringEnum(["visible", "recent", "recent-unwrapped", "detection"] as const),
    ),
    lines: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })),
  },
  { additionalProperties: false },
);

export const HerdrSendParameters = Type.Object(
  {
    runIds: RunIds,
    message: Type.String({ minLength: 1, maxLength: 16_384 }),
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
