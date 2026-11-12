import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import * as Predicate from "effect/Predicate";
import * as Rec from "effect/Record";
import { countLabel, formatCost, formatCount } from "pi-cosmic-core/display";
import { failureMessage } from "pi-cosmic-core/message-text";
import { sanitizeDiagnosticContent, sanitizeDiagnosticError } from "pi-cosmic-core/security";
import type {
  CompactChild,
  CompactDetail,
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
import { nativeCodemodeCallSubject, nativeMcpCall } from "./native-codemode-subject";
import { nativeMcpResourceAction } from "./native-mcp-identity";
import { visibleDiagnosticLine } from "./native-safe-content";
import { nativeTruncationIssues, parseNativeTruncatedOutput } from "./native-truncation";
import {
  createNativeDiscoveryProjector,
  nativeDiscoveryLabel,
  type NativeDiscoveryIntent,
  type NativeDiscoveryProjector,
} from "./native-codemode-discovery";
import { hostContainer } from "../shared/untrusted-value";
import { normalizeShellCommandWhitespace } from "./shell-command";
import { errnoMessage } from "./system-diagnostics";
import { shellFailure } from "./builtin-failure-shell";

const nativeModelCalls: ReadonlySet<string> = new Set(["models.classify", "models.generateImages"]);
const SCRIPT_ERROR = "Script error:\n";
const SCRIPT_STOPPED = /^\s*Script aborted(?:: stopped)?\s*$/u;

function issue(code: string, text: string): CompactIssue {
  const detail = sanitizeDiagnosticContent(text);
  const message =
    argumentFailureIssue(text)?.message ??
    errnoMessage(detail) ??
    failureMessage(detail, "The nested call failed");
  const projected: CompactIssue = { code, severity: "error", message };
  return detail === message ? projected : { ...projected, detail };
}

// Builtin argument fields that a child heading already shows in full.
const HEADING_FIELDS = new Map<string, ReadonlySet<string>>([
  ["bash", new Set(["command"])],
  ["read", new Set(["path", "file_path", "offset", "limit"])],
  ["grep", new Set(["pattern", "path"])],
  ["find", new Set(["pattern", "path"])],
  ["ls", new Set(["path"])],
]);

/** Whether the child's heading already states every argument, so a preview would repeat it. */
function headingShowsArguments(name: string, preview: NativeArgumentPreview | undefined): boolean {
  const fields = HEADING_FIELDS.get(name);
  // Only scalar fields are projected, so the text must be exactly those fields.
  if (
    !fields ||
    !preview?.complete ||
    Fn.pipe(preview.text, Str.includes("[REDACTED]")) ||
    JSON.stringify(preview.values) !== preview.text
  )
    return false;
  return Arr.every(Rec.toEntries(preview.values), ([key, value]) => {
    if (!fields.has(key)) return false;
    if (!Predicate.isString(value)) return Predicate.isNumber(value);
    return value.length <= 200 && normalizeShellCommandWhitespace(value) === value;
  });
}

function childIssues(call: NativeCodemodeCall): CompactIssue[] {
  if (call.status !== "error") return [];
  const text = call.error ?? "The nested call failed";
  const shell = call.name === "bash" ? shellExitMessage(text) : undefined;
  if (shell === undefined) return [issue("native-child-error", text)];
  const detail = sanitizeDiagnosticContent(text);
  return [{ code: "native-child-error", severity: "error", message: shell, detail }];
}

/**
 * A nested shell command's exit or timeout, in the words a `bash` row uses (`Exit 2`), rather than
 * the first line of its output, such as `(no output)`.
 */
function shellExitMessage(text: string): string | undefined {
  const lines = Str.split(Str.trimEnd(text), /\r?\n/u);
  const [first] = shellFailure(text, lines, true).issues;
  return first?.code === "shell-exit" || first?.code === "shell-timeout"
    ? first.message
    : undefined;
}

/**
 * Facts the child's heading can't show: its registered name when the heading abbreviates or
 * rewrites it, and arguments the heading doesn't state. Empty arguments say nothing.
 */
function childDetails(
  call: NativeCodemodeCall,
  preview: NativeArgumentPreview | undefined,
  heading: string,
): CompactDetail[] {
  const details: CompactDetail[] = [];
  if (heading !== call.name && !nativeMcpCall(call.name) && !nativeMcpResourceAction(call.name))
    details.push({ label: "Tool", text: sanitizeDiagnosticContent(call.name) });
  if (call.args && !headingShowsArguments(call.name, preview)) {
    const text =
      preview?.text ??
      (nativeModelCalls.has(call.name) ? safeNativeArgumentText(call.args) : "unavailable");
    if (!EMPTY_ARGUMENTS.has(Str.trim(text)))
      details.push({ label: "Arguments", text, verbatim: true });
  }
  return details;
}

const EMPTY_ARGUMENTS: ReadonlySet<string> = new Set(["{}", "[]", ""]);

function childStatus(call: NativeCodemodeCall, phase: CompactPhase): CompactChild["status"] {
  if (call.status === "ok") return "returned";
  return phase === "settled" && call.status === "running" ? "uncertain" : call.status;
}

function child(call: NativeCodemodeCall, phase: CompactPhase, cwd: string): CompactChild {
  const preview = nativeArgumentPreview(call.args);
  const target = nativeCodemodeCallSubject(call.name, preview, cwd);
  const label = sanitizeDiagnosticError(target.label ?? call.name, { maximumLength: 100 });
  const details = childDetails(call, preview, label);
  const entry: CompactChild = {
    ...target,
    label,
    showTiming: true,
    showShortTiming: true,
    subject: visibleDiagnosticLine(target.subject ?? "", 200),
    status: childStatus(call, phase),
    issues: childIssues(call),
    ...(details.length > 0 && { details }),
  };
  if (call.status === "ok") entry.returnedCheckmark = true;
  if (call.durationMs !== undefined) entry.durationMs = call.durationMs;
  if (call.cost !== undefined) entry.counters = [formatCost(call.cost)];
  return entry;
}

type NativeChildren = NonNullable<CompactSummary["children"]>;
const childrenByEvidence = new WeakMap<NativeCallEvidence, Map<string, NativeChildren>>();

export function nativeCodemodeChildren(
  evidence: NativeCallEvidence,
  phase: CompactPhase,
  cwd: string,
): NativeChildren {
  let projected = childrenByEvidence.get(evidence);
  if (!projected) {
    projected = new Map();
    childrenByEvidence.set(evidence, projected);
  }
  const key = `${phase}\0${cwd}`;
  const cached = projected.get(key);
  if (cached) return cached;
  const calls = evidence.kind === "available" ? evidence.calls : [];
  const children = {
    entries: Arr.map(calls, (call) => child(call, phase, cwd)),
    total: calls.length,
  };
  projected.set(key, children);
  return children;
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

/**
 * How many calls the program made, with how many failed, as one combined counter whose shorter
 * alternative keeps the failures: a settled row hides its call tree, so the heading counts it.
 */
function callCounters(
  evidence: NativeCallEvidence,
  calls: readonly NativeCodemodeCall[],
  complete: boolean,
  intent: NativeDiscoveryIntent | undefined,
): string[] {
  if (evidence.kind === "unavailable" || (complete && calls.length === 0 && intent?.discoveryOnly))
    return [];
  const total = complete
    ? countLabel(calls.length, "call")
    : `${countLabel(calls.length, "call")} listed`;
  const failed = Arr.filter(calls, (call) => call.status === "error").length;
  if (failed === 0) return [total];
  const failures = `${formatCount(failed)} failed`;
  return [`${total} · ${failures}`, failures];
}

/**
 * What expanding a settled program reveals beyond its row: its calls, else its output (its error
 * when it failed), else its program.
 */
function settledExpandLabel(summary: CompactSummary, result: AgentToolResult<unknown>): string {
  if ((summary.children?.total ?? 0) > 0) return "calls";
  const output = Arr.some(
    result.content.slice(1),
    (part) => part.type === "image" || Str.isNonEmpty(Str.trim(part.text)),
  );
  if (!output) return "program";
  return summary.outcome === "error" ? "error" : "output";
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
  // A stop someone asked for is not a failure; the raw trailer stays in the expanded output.
  if (SCRIPT_STOPPED.test(text))
    return {
      ...summary,
      outcome: "cancelled",
      issues: [
        { severity: "info", code: "native-script-stopped", message: "Script was stopped" },
        ...summary.issues,
      ],
    };
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
      // Until it settles, expansion reveals the program the collapsed row hides.
      expandLabel: "program",
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
    const settled =
      header === "failed"
        ? scriptFailure(
            summary,
            result,
            Boolean(evidence.fullOutputPath) || truncatedEnvelope !== undefined,
          )
        : completedOutcome(summary, calls, complete, context.isError || result.isError === true);
    return { ...settled, expandLabel: settledExpandLabel(settled, result) };
  };
