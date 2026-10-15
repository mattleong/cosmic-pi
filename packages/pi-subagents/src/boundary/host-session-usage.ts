import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { invokeHostCallback } from "pi-cosmic-core";
import { emptyUsage, type SubagentUsage } from "../run/model.ts";
import { addUsage } from "../run/state.ts";

/** Custom session entries are kept out of the model's context and the default /tree view. */
export const SUBAGENT_USAGE_ENTRY_TYPE = "pi-subagents-usage";

const Count = Schema.Number.check(Schema.isFinite(), Schema.isGreaterThanOrEqualTo(0));
const UsageEntry = Schema.Struct({
  version: Schema.Literal(1),
  input: Count,
  output: Count,
  cacheRead: Count,
  cacheWrite: Count,
  totalTokens: Count,
  cost: Schema.optionalKey(Count),
});
const decodeUsageEntry = Schema.decodeUnknownOption(UsageEntry);

/**
 * Sums every usage entry in the session file, on every /tree branch: navigating back does not
 * refund what subagents already spent. A forked session keeps the entries on its forked path.
 */
export const restoreSessionUsage = (ctx: ExtensionContext): SubagentUsage =>
  invokeHostCallback(() => {
    let total = emptyUsage();
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type !== "custom" || entry.customType !== SUBAGENT_USAGE_ENTRY_TYPE) continue;
      const decoded = decodeUsageEntry(entry.data);
      if (Option.isNone(decoded)) continue;
      const { version: _version, ...usage } = decoded.value;
      total = addUsage(total, usage);
    }
    return total;
  }, emptyUsage());

/**
 * Appends settled usage to the session it was spent in. A replaced or reloaded extension context
 * throws, and a write for another session is dropped rather than misattributed.
 */
export const sessionUsageRecorder = (
  pi: ExtensionAPI,
  ctx: ExtensionContext,
): ((usage: SubagentUsage) => void) => {
  const sessionId = invokeHostCallback(() => ctx.sessionManager.getSessionId(), undefined);
  return (usage) =>
    invokeHostCallback(() => {
      if (sessionId === undefined || ctx.sessionManager.getSessionId() !== sessionId) return;
      pi.appendEntry(SUBAGENT_USAGE_ENTRY_TYPE, {
        version: 1,
        input: usage.input,
        output: usage.output,
        cacheRead: usage.cacheRead,
        cacheWrite: usage.cacheWrite,
        totalTokens: usage.totalTokens,
        ...(usage.cost !== undefined && { cost: usage.cost }),
      });
    }, undefined);
};
