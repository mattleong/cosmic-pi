import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import type { SubagentUsage } from "../run/model.ts";

const Count = Schema.Number.check(
  Schema.isFinite(),
  Schema.isInt(),
  Schema.isGreaterThanOrEqualTo(0),
  Schema.isLessThanOrEqualTo(Number.MAX_SAFE_INTEGER),
);
const Cost = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const Stats = Schema.Struct({
  tokens: Schema.Struct({
    input: Count,
    output: Count,
    cacheRead: Count,
    cacheWrite: Count,
    total: Count,
  }),
  cost: Cost,
});

/** A process-lifetime high-water mark, seeded before sending any child work. */
export const makeLocalPiUsage = () => {
  let previous: SubagentUsage | undefined;
  const account = <ValueInput>(value: ValueInput): SubagentUsage | undefined => {
    const decoded = decodeUnknownOrUndefined(Stats, value);
    if (!decoded) return undefined;
    const { tokens, cost } = decoded;
    const next = { ...tokens, totalTokens: tokens.total, cost };
    if (!previous) {
      previous = next;
      return undefined;
    }
    const delta = {
      input: next.input - previous.input,
      output: next.output - previous.output,
      cacheRead: next.cacheRead - previous.cacheRead,
      cacheWrite: next.cacheWrite - previous.cacheWrite,
      totalTokens: next.totalTokens - previous.totalTokens,
      cost: cost - (previous.cost ?? 0),
    };
    const components = Object.values(delta);
    // Any regressing component leaves the high-water mark unchanged.
    if (components.some((component) => component < 0)) return undefined;
    previous = next;
    return components.some((component) => component > 0) ? delta : undefined;
  };
  return { account, hasBaseline: () => previous !== undefined };
};
