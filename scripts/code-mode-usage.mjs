// Summarizes how agents used code_mode in local Pi sessions: program volume, nested calls,
// failures by kind, direct Node access that Code Mode refused, and concurrency patterns.
// Reads session JSONL files only; prints aggregates, never program source or tool output.
//
//   node scripts/code-mode-usage.mjs [--since YYYY-MM-DD] [--sessions DIR] [--json]
import { createReadStream } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
};
const sessionsDirectory = argument("--sessions") ?? join(homedir(), ".pi/agent/sessions");
const since = argument("--since") ?? new Date(Date.now() - 7 * 86_400_000).toISOString();
const asJson = process.argv.includes("--json");

const objectTag = Object.prototype.toString;
const isString = (value) => objectTag.call(value) === "[object String]";
const isRecord = (value) => objectTag.call(value) === "[object Object]";

const sessionFiles = async (directory) => {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sessionFiles(path)));
    else if (entry.name.endsWith(".jsonl")) files.push(path);
  }
  return files;
};

/** Code without string literals or comments, so patterns inside grep arguments don't count. */
const codeOnly = (source) =>
  source
    .replace(/`(?:\\.|[^`\\])*`/gs, "``")
    .replace(/"(?:\\.|[^"\\\n])*"/g, '""')
    .replace(/'(?:\\.|[^'\\\n])*'/g, "''")
    .replace(/\/\/[^\n]*/g, "");

// Most patterns ignore string contents; the import specifier itself is a string.
const PATTERNS = {
  "Promise.all": { pattern: /Promise\.all\(/ },
  "Promise.allSettled": { pattern: /Promise\.allSettled\b/ },
  "Promise.race or any": { pattern: /Promise\.(?:race|any)\b/ },
  "await in a loop": { pattern: /\b(?:for|while)\s*\([^)]*\)\s*\{[^}]*\bawait\b/s },
  "node: import": { pattern: /\bimport\(\s*["'`]node:/, raw: true },
};

const REFUSALS = [
  ["read", /Programs can't read /],
  ["write", /Programs can't write /],
  ["import", /Programs can't import /],
  ["process", /Programs can't start processes/],
  ["other", /Programs can't use this Node\.js API/],
];

const textOf = (message) =>
  (Array.isArray(message.content) ? message.content : [])
    .map((block) => (isRecord(block) && isString(block.text) ? block.text : ""))
    .join("");

const programs = [];
for (const file of await sessionFiles(sessionsDirectory)) {
  const calls = new Map();
  const lines = createInterface({ input: createReadStream(file), crlfDelay: Infinity });
  for await (const line of lines) {
    if (!line.includes("code_mode")) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const message = isRecord(entry) && isRecord(entry.message) ? entry.message : undefined;
    if (message === undefined || !isString(entry.timestamp) || entry.timestamp < since) continue;
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!isRecord(block) || block.type !== "toolCall" || block.name !== "code_mode") continue;
        const input = isRecord(block.arguments) ? block.arguments : {};
        calls.set(block.id, {
          file,
          timestamp: entry.timestamp,
          code: isString(input.code) ? input.code : undefined,
          action: isString(input.action) ? input.action : undefined,
        });
      }
    } else if (message.role === "toolResult" && message.toolName === "code_mode") {
      const call = calls.get(message.toolCallId);
      if (call === undefined) continue;
      const details = isRecord(message.details) ? message.details : {};
      const counts = isRecord(details.counts) ? details.counts : {};
      programs.push({
        ...call,
        isError: message.isError === true,
        text: textOf(message),
        nestedCalls: Number.isInteger(counts.total) ? counts.total : 0,
      });
    }
  }
}

const executions = programs.filter((program) => program.code !== undefined);
const failures = executions.filter((program) => program.isError);
const kinds = new Map();
for (const { text } of failures) {
  const kind = /^\s*\[(\w+)\]/.exec(text)?.[1] ?? "other";
  kinds.set(kind, (kinds.get(kind) ?? 0) + 1);
}
const refusals = new Map(REFUSALS.map(([name]) => [name, 0]));
let refusedPrograms = 0;
let recoveredNext = 0;
const bySession = Map.groupBy(executions, (program) => program.file);
for (const sessionPrograms of bySession.values()) {
  sessionPrograms.forEach((program, index) => {
    const refusal = REFUSALS.find(([, pattern]) => pattern.test(program.text));
    if (refusal === undefined) return;
    refusedPrograms += 1;
    refusals.set(refusal[0], refusals.get(refusal[0]) + 1);
    if (sessionPrograms[index + 1]?.isError === false) recoveredNext += 1;
  });
}
const patterns = Object.fromEntries(
  Object.entries(PATTERNS).map(([name, { pattern, raw }]) => [
    name,
    executions.filter(({ code }) => pattern.test(raw ? code : codeOnly(code))).length,
  ]),
);
const nestedCalls = executions.reduce((total, program) => total + program.nestedCalls, 0);
const timestamps = programs.map(({ timestamp }) => timestamp).sort();

const report = {
  since,
  range: timestamps.length === 0 ? null : [timestamps[0], timestamps.at(-1)],
  sessions: bySession.size,
  executions: executions.length,
  statusCalls: programs.filter(({ action }) => action === "status").length,
  resultReads: programs.filter(({ action }) => action === "result.read").length,
  nestedCalls,
  failures: failures.length,
  failureKinds: Object.fromEntries([...kinds].sort(([, a], [, b]) => b - a)),
  refusedPrograms,
  refusals: Object.fromEntries(refusals),
  refusalsFollowedBySuccess: recoveredNext,
  patterns,
};

if (asJson) {
  console.log(JSON.stringify(report, null, 2));
} else {
  const percent = (part, whole) => (whole === 0 ? "0%" : `${Math.round((100 * part) / whole)}%`);
  const rows = (record) =>
    Object.entries(record).map(([name, count]) => `  ${name.padEnd(22)} ${count}`);
  console.log(
    [
      `Code Mode usage since ${since.slice(0, 10)}${report.range === null ? "" : ` (${report.range[0].slice(0, 10)} to ${report.range[1].slice(0, 10)})`}`,
      `Programs: ${executions.length} in ${bySession.size} sessions, plus ${report.statusCalls} status and ${report.resultReads} result.read calls`,
      `Nested calls: ${nestedCalls} (${executions.length === 0 ? 0 : (nestedCalls / executions.length).toFixed(1)} per program)`,
      `Failed programs: ${failures.length} (${percent(failures.length, executions.length)})`,
      ...rows(report.failureKinds),
      `Direct Node access refused: ${refusedPrograms} programs; the next program succeeded ${recoveredNext} times`,
      ...rows(report.refusals),
      "Patterns (programs using each):",
      ...rows(patterns),
    ].join("\n"),
  );
}
