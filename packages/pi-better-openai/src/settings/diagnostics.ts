import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import * as Arr from "effect/Array";
import { currentModelKey, fastDiagnosticLines, type FastSnapshot } from "../fast/controller.ts";
import { usageDiagnosticLines } from "../usage/debug.ts";
import type { OpenAIProjection } from "../usage/projection.ts";

export interface DiagnosticFacts {
  readonly ctx: ExtensionContext;
  readonly configPath: string;
  readonly fast: FastSnapshot;
  readonly usage: OpenAIProjection;
  readonly footerUsageVisible: boolean;
  /** Why OpenAI compaction can't run in this Pi, when it can't. */
  readonly compactionUnavailable: string | undefined;
}

const section = (title: string, lines: ReadonlyArray<string>): string[] =>
  lines.length === 0 ? [] : [title, ...Arr.map(lines, (line) => `  ${line}`)];

/**
 * The facts no setting row shows, as `Name: value` lines under section titles. They follow the
 * rows in `/openai settings status` and fill Diagnostics' Debug info.
 */
export const diagnosticLines = (facts: DiagnosticFacts): ReadonlyArray<string> => [
  `Current model: ${currentModelKey(facts.ctx)}`,
  `Config: ${facts.configPath}`,
  ...section("Fast mode", fastDiagnosticLines(facts.ctx, facts.fast)),
  ...section("Usage", [
    `Footer: ${facts.footerUsageVisible ? "auto" : "off"} (/cosmic-ui settings)`,
    ...usageDiagnosticLines(facts.usage),
  ]),
  ...section(
    "Compaction",
    facts.compactionUnavailable === undefined
      ? []
      : [`Unavailable: ${facts.compactionUnavailable}`],
  ),
];
