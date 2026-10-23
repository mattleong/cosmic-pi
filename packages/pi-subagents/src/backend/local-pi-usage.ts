import { decodeUnknownOrUndefined } from "pi-cosmic-core";
import * as Schema from "effect/Schema";
import * as Arr from "effect/Array";
import * as Rec from "effect/Record";
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
  contextUsage: Schema.optional(
    Schema.Struct({ percent: Schema.NullOr(Schema.Number.check(Schema.isFinite())) }),
  ),
});

const decodeStats = decodeUnknownOrUndefined(Stats);

export const localPiUsage = () => {
  let previous: SubagentUsage | undefined;
  const account = (value: Schema.Json | undefined): SubagentUsage | undefined => {
    const decoded = decodeStats(value);
    if (!decoded) return undefined;
    const { tokens, cost } = decoded;
    const percent = decoded.contextUsage?.percent;
    const contextPercent =
      percent === null || percent === undefined ? undefined : Math.min(100, Math.max(0, percent));
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
    const components = Rec.values(delta);
    if (Arr.some(components, (component) => component < 0)) return undefined;
    previous = next;
    return Arr.some(components, (component) => component > 0)
      ? { ...delta, ...(contextPercent !== undefined && { contextPercent }) }
      : undefined;
  };
  return { account, hasBaseline: () => previous !== undefined };
};
