import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import {
  countLabel,
  failureMessage,
  formatCost,
  sanitizeDiagnosticContent,
  sanitizeDiagnosticError,
} from "pi-cosmic-core";
import type {
  CompactChild,
  CompactPhase,
  CompactSummary,
  CompactSummaryProvider,
} from "./compact-summary";
import type { RendererState } from "./renderers/shared/types";
import {
  nativeCodemodeEvidence,
  type NativeCallEvidence,
  type NativeCodemodeCall,
} from "./native-codemode-evidence";
import type { CompactIssue } from "./compact-issues";
import { argumentFailureIssue } from "./argument-failure";
import type { AgentToolResult } from "@earendil-works/pi-coding-agent";
import { selectCompactChildren } from "../preview/compact-children";
import {
  nativeArgumentPreview,
  safeNativeArgumentText,
  type NativeArgumentPreview,
} from "./native-codemode-args";
import { nativeCodemodeCallSubject } from "./native-codemode-subject";
import { visibleDiagnosticLine } from "./native-safe-content";
import { nativeTruncationIssues, parseNativeTruncatedOutput } from "./native-truncation";
import {
  createNativeDiscoveryProjector,
  nativeDiscoveryLabel,
  type NativeDiscoveryIntent,
  type NativeDiscoveryProjector,
} from "./native-codemode-discovery";
import { hostContainer } from "../shared/untrusted-value";

const nativeModelCalls: ReadonlySet<string> = new Set(["models.classify", "models.generateImages"]);
const SCRIPT_ERROR = "Script error:\n";

function issue(code: string, text: string): CompactIssue {
  const detail = sanitizeDiagnosticContent(text);
  const message =
    argumentFailureIssue(text)?.message ?? failureMessage(detail, "The nested call failed");
  const projected: CompactIssue = { code, severity: "error", message };
  return detail === message ? projected : { ...projected, detail };
}

function childIssues(
  call: NativeCodemodeCall,
  preview: NativeArgumentPreview | undefined,
  label: string | undefined,
): CompactIssue[] {
  const issues: CompactIssue[] = [];
  if (label || Fn.pipe(call.name, Str.startsWith("mcp__")))
    issues.push({
      code: "native-call-name",
      severity: "info",
      message: "Registered tool",
      detail: sanitizeDiagnosticContent(call.name),
    });
  if (call.status === "error")
    issues.push(issue("native-child-error", call.error ?? "The nested call failed"));
  if (call.args)
    issues.push({
      code: "native-call-args",
      severity: "info",
      message: "Arguments preview",
      detail:
        preview?.text ??
        (nativeModelCalls.has(call.name)
          ? safeNativeArgumentText(call.args)
          : "Argument preview is unavailable"),
    });
  return issues;
}

function childStatus(call: NativeCodemodeCall, phase: CompactPhase): CompactChild["status"] {
  if (call.status === "ok") return "returned";
  return phase === "settled" && call.status === "running" ? "uncertain" : call.status;
}

function child(call: NativeCodemodeCall, phase: CompactPhase, cwd: string): CompactChild {
  const preview = nativeArgumentPreview(call.args);
  const target = nativeCodemodeCallSubject(call.name, preview, cwd);
  const entry: CompactChild = {
    ...target,
    label: sanitizeDiagnosticError(target.label ?? call.name, { maximumLength: 100 }),
    showTiming: true,
    showShortTiming: true,
    subject: visibleDiagnosticLine(target.subject ?? "", 200),
    status: childStatus(call, phase),
    issues: childIssues(call, preview, target.label),
  };
  if (call.status === "ok") entry.returnedCheckmark = true;
  if (call.durationMs !== undefined) entry.durationMs = call.durationMs;
  if (call.cost !== undefined) entry.counters = [formatCost(call.cost)];
  return entry;
}

export function nativeCodemodeChildren(
  evidence: NativeCallEvidence,
  phase: CompactPhase,
  cwd: string,
): NonNullable<CompactSummary["children"]> {
  const calls = evidence.kind === "available" ? evidence.calls : [];
  return { entries: Arr.map(calls, (call) => child(call, phase, cwd)), total: calls.length };
}

export function nativeCodemodeHeader(
  result: Pick<AgentToolResult<unknown>, "content">,
): "completed" | "failed" | undefined {
  const first = result.content[0];
  if (first?.type !== "text") return undefined;
  const header =
    /^(Script completed|Script failed)\nWall time \d+(?:\.\d+)? seconds\nOutput:\n$/.exec(
      first.text,
    );
  return header ? (header[1] === "Script failed" ? "failed" : "completed") : undefined;
}

type NativeSummary = CompactSummary & Required<Pick<CompactSummary, "children" | "issues">>;
type TruncatedEnvelope = ReturnType<typeof parseNativeTruncatedOutput>;

function evidenceIssues(
  evidence: NativeCallEvidence,
  complete: boolean,
  truncatedEnvelope: TruncatedEnvelope,
): CompactIssue[] {
  const truncation = nativeTruncationIssues(truncatedEnvelope, evidence.fullOutputPath, {
    code: "native",
    subject: "Script output",
  });
  if (complete) return truncation;
  const message =
    evidence.kind === "available" ? "Call details are incomplete" : "Call details are unavailable";
  return [{ code: "native-call-evidence-incomplete", severity: "warning", message }, ...truncation];
}

function callCounters(
  evidence: NativeCallEvidence,
  calls: readonly NativeCodemodeCall[],
  complete: boolean,
  intent: NativeDiscoveryIntent | undefined,
): string[] {
  if (evidence.kind === "unavailable" || (complete && calls.length === 0 && intent?.discoveryOnly))
    return [];
  if (!complete) return [`${countLabel(calls.length, "call")} listed`];
  const toolCalls = intent && Arr.every(calls, (call) => !nativeModelCalls.has(call.name));
  return [countLabel(calls.length, toolCalls ? "tool call" : "call")];
}

// Pi appends its error trailer after all script output and may join it with the preceding text,
// so only the last trailer at a line start is Pi's; earlier ones are guest-printed text.
function scriptErrorText(content: AgentToolResult<unknown>["content"]): string {
  for (let index = content.length - 1; index >= 0; index -= 1) {
    const part = content[index];
    if (part?.type !== "text") continue;
    const lineStart = Fn.pipe(part.text, Str.lastIndexOf(`\n${SCRIPT_ERROR}`));
    if (Option.isSome(lineStart))
      return Fn.pipe(part.text, Str.slice(lineStart.value + 1 + SCRIPT_ERROR.length));
    if (Fn.pipe(part.text, Str.startsWith(SCRIPT_ERROR)))
      return Fn.pipe(part.text, Str.slice(SCRIPT_ERROR.length));
  }
  return "";
}

function scriptFailure(
  summary: NativeSummary,
  result: Pick<AgentToolResult<unknown>, "content">,
  diagnosticHidden: boolean,
): CompactSummary {
  const text = diagnosticHidden ? "" : scriptErrorText(result.content);
  const failure = issue("native-script-error", text || "The script failed");
  const explained = Arr.some(
    selectCompactChildren(summary.children).entries,
    (entry) =>
      entry.status === "error" &&
      Arr.some(
        entry.issues ?? [],
        (cause) => cause.code === "native-child-error" && cause.message === failure.message,
      ),
  );
  return {
    ...summary,
    outcome: "error",
    issues: explained ? summary.issues : [failure, ...summary.issues],
  };
}

function completedOutcome(
  summary: NativeSummary,
  calls: readonly NativeCodemodeCall[],
  complete: boolean,
  unconfirmed: boolean,
): CompactSummary {
  const uncertain = (code: string, message: string): CompactSummary => ({
    ...summary,
    outcome: "uncertain",
    issues: [{ code, severity: "warning", message }, ...summary.issues],
  });
  if (unconfirmed)
    return uncertain("native-outcome-uncertain", "Script completion could not be confirmed");
  if (!complete) return { ...summary, outcome: "uncertain" };
  if (Arr.some(calls, (call) => call.status === "running" || call.status === "cancelled"))
    return uncertain("native-call-outcome-uncertain", "Some call outcomes are unconfirmed");
  return {
    ...summary,
    outcome: Arr.some(calls, (call) => call.status === "error") ? "warning" : "success",
  };
}

export const nativeCodemodeSummary =
  (
    cwd: string,
    discovery: NativeDiscoveryProjector = createNativeDiscoveryProjector(),
  ): CompactSummaryProvider<unknown, unknown, RendererState> =>
  ({ phase, args, result, context }) => {
    const intent = discovery(hostContainer(args));
    const label = nativeDiscoveryLabel(intent);
    const heading = {
      subject: "",
      ...(label && { action: label }),
      showTiming: true as const,
      showShortTiming: true as const,
    };
    if (!result) return phase === "settled" ? undefined : heading;
    const evidence = nativeCodemodeEvidence(hostContainer(result.details));
    const calls = evidence.kind === "available" ? evidence.calls : [];
    const complete = evidence.kind === "available" && evidence.complete;
    const header = nativeCodemodeHeader(result);
    const output = result.content[1];
    const truncatedEnvelope =
      header && output?.type === "text" ? parseNativeTruncatedOutput(output.text) : undefined;
    const summary: NativeSummary = {
      ...heading,
      counters: callCounters(evidence, calls, complete, intent),
      children: nativeCodemodeChildren(evidence, phase, cwd),
      issues: evidenceIssues(evidence, complete, truncatedEnvelope),
    };
    if (phase !== "settled") return summary;
    if (!header) return undefined;
    if (header === "failed")
      return scriptFailure(
        summary,
        result,
        Boolean(evidence.fullOutputPath) || truncatedEnvelope !== undefined,
      );
    return completedOutcome(summary, calls, complete, context.isError || result.isError === true);
  };
