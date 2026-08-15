// Narrow platform path adapter: only this boundary decides whether a Claude writer cwd is an
// absolute path before the pure backend policy grammar builds its scoped Edit rule.
// @effect-diagnostics effect/nodeBuiltinImport:off
import { isAbsolute } from "node:path";
import { claudeWriterCwdRulePolicy, type ClaudeWriterCwdPolicy } from "../backend/claude-policy.ts";

/** Build one cwd/rule pair only when both sandbox and comma-delimited tool grammar can represent it. */
export const claudeWriterCwdPolicy = (cwd: string | undefined): ClaudeWriterCwdPolicy | undefined =>
  typeof cwd === "string" && isAbsolute(cwd) ? claudeWriterCwdRulePolicy(cwd) : undefined;
