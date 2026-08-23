// Narrow platform path adapter: only this boundary decides whether a Claude writer cwd is an
// absolute path before the pure backend policy grammar builds its scoped Edit rule.
import * as Predicate from "effect/Predicate";

import { nodePath } from "./node-builtins.ts";
import { claudeWriterCwdRulePolicy, type ClaudeWriterCwdPolicy } from "../backend/claude-policy.ts";

/** Build one cwd/rule pair only when both sandbox and comma-delimited tool grammar can represent it. */
export const claudeWriterCwdPolicy = (cwd: string | undefined): ClaudeWriterCwdPolicy | undefined =>
  Predicate.isString(cwd) && nodePath.isAbsolute(cwd) ? claudeWriterCwdRulePolicy(cwd) : undefined;
