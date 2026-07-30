// This file is loaded as the sole pi-herdr-owned extension inside delegated Pi agents.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/asyncFunction:off
// @effect-diagnostics effect/newPromise:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/globalTimers:off
import { spawn } from "node:child_process";
import { isAbsolute, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { StringEnum } from "@earendil-works/pi-ai";
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadCodePreviewSettings, withCodePreviewShell } from "pi-code-previews";
import { Type } from "typebox";

const MAX_REPORT_BYTES = 48_000;
const MAX_HELPER_OUTPUT_BYTES = 64 * 1024;
const REPORT_TOOL_NAME = "herdr_report_submit";
const RUN_ID_PATTERN = /^herdr-[a-z0-9-]{1,80}$/;
const helperPath = fileURLToPath(new URL("./report-helper.mjs", import.meta.url));

interface HelperResponse {
  readonly result?: {
    readonly content?: ReadonlyArray<{ readonly type?: unknown; readonly text?: unknown }>;
    readonly isError?: boolean;
  };
  readonly error?: { readonly message?: unknown };
}

export const callReportHelper = (
  runId: string,
  reportDirectory: string,
  input: { readonly status: "completed" | "blocked" | "failed"; readonly report: string },
  signal?: AbortSignal,
): Promise<string> =>
  new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [helperPath], {
      env: { HERDR_RUN_ID: runId, HERDR_REPORT_DIR: reportDirectory },
      stdio: ["pipe", "pipe", "ignore"],
      windowsHide: true,
    });
    let output = "";
    let settled = false;
    const finish = (error?: Error, value?: string) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      if (error) reject(error);
      else resolve(value ?? "Report accepted.");
    };
    const abort = () => {
      child.kill();
      finish(new Error("Report submission was cancelled."));
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new Error("Report submission timed out."));
    }, 10_000);
    signal?.addEventListener("abort", abort, { once: true });
    child.once("error", () => finish(new Error("Unable to start the private report helper.")));
    child.stdout?.on("data", (chunk: Buffer) => {
      if (Buffer.byteLength(output, "utf8") + chunk.byteLength > MAX_HELPER_OUTPUT_BYTES) {
        child.kill();
        finish(new Error("Private report helper output exceeded its bounded limit."));
        return;
      }
      output += chunk.toString("utf8");
    });
    child.once("close", (code) => {
      if (settled) return;
      if (code !== 0) {
        finish(new Error("Private report helper failed."));
        return;
      }
      try {
        const line = output.split("\n").find((candidate) => candidate.trim());
        const response = JSON.parse(line ?? "") as HelperResponse;
        const text = response.result?.content?.find((part) => part.type === "text")?.text;
        if (response.result?.isError || response.error)
          finish(
            new Error(
              typeof text === "string"
                ? text
                : typeof response.error?.message === "string"
                  ? response.error.message
                  : "Private report helper rejected the report.",
            ),
          );
        else finish(undefined, typeof text === "string" ? text : "Report durably accepted.");
      } catch {
        finish(new Error("Private report helper returned an invalid response."));
      }
    });
    child.stdin?.end(
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: "pi-report",
        method: "tools/call",
        params: { name: "submit_report", arguments: input },
      })}\n`,
    );
  });

export default function registerHerdrChildReporter(pi: ExtensionAPI): void {
  pi.registerFlag("herdr-report-run-id", {
    description: "Private pi-herdr report run ID",
    type: "string",
  });
  pi.registerFlag("herdr-report-directory", {
    description: "Private pi-herdr report directory",
    type: "string",
  });

  let registered = false;
  pi.on("session_start", async (_event, ctx) => {
    if (registered) return;
    const runId = pi.getFlag("herdr-report-run-id");
    const reportDirectory = pi.getFlag("herdr-report-directory");
    if (
      typeof runId !== "string" ||
      !RUN_ID_PATTERN.test(runId) ||
      typeof reportDirectory !== "string" ||
      !isAbsolute(reportDirectory) ||
      basename(reportDirectory) !== runId
    ) {
      if (ctx.hasUI) ctx.ui.notify("Invalid private pi-herdr report channel.", "error");
      return;
    }
    await loadCodePreviewSettings(ctx.cwd, ctx.isProjectTrusted()).catch(() => undefined);
    const tool = defineTool({
      name: REPORT_TOOL_NAME,
      label: "Submit Herdr Report",
      description:
        "Durably submit the complete final report for this delegated read-only task. Call exactly once when completed, blocked, or failed.",
      promptSnippet: "Submit the final managed report for this delegated task",
      promptGuidelines: [
        "Call herdr_report_submit exactly once before the final response with the complete self-contained report and its completed, blocked, or failed status.",
      ],
      parameters: Type.Object(
        {
          status: StringEnum(["completed", "blocked", "failed"] as const),
          report: Type.String({ minLength: 1, maxLength: MAX_REPORT_BYTES }),
        },
        { additionalProperties: false },
      ),
      async execute(_id, input, signal) {
        const receipt = await callReportHelper(runId, reportDirectory, input, signal);
        return {
          content: [{ type: "text" as const, text: receipt }],
          details: { runId, status: input.status },
          terminate: true,
        };
      },
    });
    pi.registerTool(withCodePreviewShell(tool));
    pi.setActiveTools([...new Set([...pi.getActiveTools(), REPORT_TOOL_NAME])]);
    registered = true;
  });
}
