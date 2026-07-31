#!/usr/bin/env node
import readline from "node:readline";

const args = process.argv.slice(2);
if (args[0] === "auth" && args[1] === "status") {
  process.stdout.write(`${JSON.stringify({ loggedIn: process.env.FIXTURE_UNAUTH !== "1" })}\n`);
  process.exit(process.env.FIXTURE_UNAUTH === "1" ? 1 : 0);
}
if (args[0] === "--version") {
  process.stdout.write("codex-cli fixture\n");
  process.exit(0);
}
if (args[0] === "login" && args[1] === "status") {
  if (process.env.FIXTURE_UNAUTH === "1") {
    process.stderr.write("Not logged in\n");
    process.exit(1);
  }
  process.stdout.write("Logged in using fixture\n");
  process.exit(0);
}

const write = (value) => process.stdout.write(`${JSON.stringify(value)}\n`);
const lines = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });

if (args.includes("--print")) {
  const model = args[args.indexOf("--model") + 1] ?? "fixture-claude";
  const cwd = process.cwd();
  const supervisorTools = [
    "supervisor_progress",
    "supervisor_warning",
    "supervisor_question",
    "supervisor_submit_report",
  ];
  write({
    type: "system",
    subtype: "init",
    cwd,
    session_id: "claude-fixture-session",
    model,
    tools: [
      "Glob",
      "Grep",
      "Read",
      ...supervisorTools.map((tool) => `mcp__pi_subagents_supervisor__${tool}`),
    ],
    mcp_servers: [{ name: "pi_subagents_supervisor", status: "connected" }],
  });
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    if (frame.type === "control_request") {
      const success = (response) =>
        write({
          type: "control_response",
          response: {
            subtype: "success",
            request_id: frame.request_id,
            ...(response === undefined ? {} : { response }),
          },
        });
      if (frame.request?.subtype === "initialize") {
        success(
          model === "bad-init"
            ? {}
            : {
                models:
                  frame.request_id === "pi-subagents-model-catalog"
                    ? [
                        {
                          value: "default",
                          resolvedModel: "claude-opus-fixture",
                          displayName: "Default Claude",
                          description: "Fixture default model",
                          supportedEffortLevels: ["low", "medium", "high"],
                        },
                        {
                          value: "sonnet",
                          resolvedModel: "claude-sonnet-fixture",
                          displayName: "Claude Sonnet",
                          description: "Fixture efficient model",
                          supportedEffortLevels: ["low", "high"],
                        },
                      ]
                    : [{ value: model, resolvedModel: model }],
              },
        );
        return;
      }
      if (frame.request?.subtype === "mcp_status") {
        success({
          mcpServers: [
            {
              name: "pi_subagents_supervisor",
              status: model === "missing-helper" ? "failed" : "connected",
              tools: model === "missing-helper" ? [] : supervisorTools.map((name) => ({ name })),
            },
          ],
        });
        return;
      }
      if (frame.request?.subtype === "interrupt") {
        const response = () => success();
        const marker = () =>
          write({
            type: "user",
            isReplay: true,
            session_id: "claude-fixture-session",
            message: { role: "user", content: "[Request interrupted by user]" },
          });
        const result = () =>
          write({
            type: "result",
            subtype: "error_during_execution",
            stop_reason:
              model === "interrupt-genuine-error" ? "provider_error" : "aborted_streaming",
            is_error: true,
            errors:
              model === "interrupt-genuine-error"
                ? ["genuine fixture failure"]
                : ["Request aborted."],
            session_id: "claude-fixture-session",
          });
        const terminal = () => {
          if (model === "interrupt-result-first") {
            result();
            marker();
          } else {
            marker();
            result();
          }
        };
        if (model === "interrupt-terminal-first") {
          terminal();
          response();
        } else {
          response();
          terminal();
        }
        return;
      }
      success();
      return;
    }
    if (frame.type !== "user") return;
    const text = Array.isArray(frame.message?.content)
      ? frame.message.content.map((part) => part.text ?? "").join("\n")
      : String(frame.message?.content ?? "");
    write({
      type: "user",
      isReplay: true,
      session_id: "claude-fixture-session",
      message: frame.message,
    });
    if (frame.shouldQuery === false) {
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        stop_reason: null,
        session_id: "claude-fixture-session",
      });
      return;
    }
    if (model === "malformed") {
      process.stdout.write("{malformed\n");
      return;
    }
    if (model === "oversized") {
      process.stdout.write(`${"x".repeat(4 * 1024 * 1024 + 1)}\n`);
      return;
    }
    write({
      type: "assistant",
      session_id: "claude-fixture-session",
      message: {
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Claude saw: ${text}; envLeak=${process.env.TEST_SECRET ?? "none"}`,
          },
        ],
        usage: { input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 },
      },
    });
    // Interrupt fixtures model a still-running native turn: only the correlated interrupt emits
    // their terminal result. Other models complete normally and exercise missing-report handling.
    if (model !== "claude-fixture" && !model.startsWith("interrupt"))
      write({ type: "result", subtype: "success", is_error: false, result: "raw final ignored" });
    if (model === "exit-no-report") process.exit(0);
  });
} else if (args[0] === "app-server") {
  let model = "fixture-codex";
  lines.on("line", (line) => {
    const frame = JSON.parse(line);
    if (!frame.id) return;
    switch (frame.method) {
      case "initialize":
        write({
          id: frame.id,
          result: {
            codexHome: process.env.CODEX_HOME,
            platformFamily: "unix",
            platformOs: "fixture",
            userAgent: "codex-fixture",
          },
        });
        break;
      case "model/list":
        write({
          id: frame.id,
          result: {
            data: [
              {
                id: "gpt-fixture-default",
                model: "gpt-fixture-default",
                displayName: "GPT Fixture Default",
                description: "Fixture Codex default model",
                isDefault: true,
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Low" },
                  { reasoningEffort: "high", description: "High" },
                ],
              },
              {
                id: "gpt-fixture-fast",
                model: "gpt-fixture-fast",
                displayName: "GPT Fixture Fast",
                description: "Fixture Codex fast model",
                isDefault: false,
                supportedReasoningEfforts: [{ reasoningEffort: "minimal", description: "Minimal" }],
              },
            ],
            nextCursor: null,
          },
        });
        break;
      case "thread/start":
        model = frame.params.model;
        write({
          id: frame.id,
          result: {
            approvalPolicy: "never",
            approvalsReviewer: "user",
            cwd: frame.params.cwd,
            model,
            modelProvider: "openai",
            sandbox: { type: frame.params.sandbox === "read-only" ? "readOnly" : "workspaceWrite" },
            thread: { id: "thread-fixture", sessionId: "session-fixture" },
          },
        });
        break;
      case "turn/start": {
        const turn = "turn-fixture";
        write({ id: frame.id, result: { turn: { id: turn, status: "inProgress", items: [] } } });
        write({
          method: "turn/started",
          params: {
            threadId: "thread-fixture",
            turn: { id: turn, status: "inProgress", items: [] },
          },
        });
        write({
          method: "item/completed",
          params: {
            threadId: "thread-fixture",
            turnId: turn,
            completedAtMs: Date.now(),
            item: { id: "message-fixture", type: "agentMessage", text: "Codex fixture answer" },
          },
        });
        write({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-fixture",
            turnId: turn,
            tokenUsage: {
              last: {
                inputTokens: 2,
                cachedInputTokens: 1,
                outputTokens: 3,
                reasoningOutputTokens: 1,
                totalTokens: 5,
                cacheWriteInputTokens: 0,
              },
              total: {
                inputTokens: 2,
                cachedInputTokens: 1,
                outputTokens: 3,
                reasoningOutputTokens: 1,
                totalTokens: 5,
                cacheWriteInputTokens: 0,
              },
            },
          },
        });
        if (model === "exit-no-report") process.exit(0);
        if (model === "completed-with-report" || model === "completed-without-report")
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-fixture",
              turn: { id: turn, status: "completed", items: [] },
            },
          });
        break;
      }
      case "turn/steer":
        write({ id: frame.id, result: { turnId: "turn-fixture" } });
        break;
      case "turn/interrupt": {
        const response = () => write({ id: frame.id, result: {} });
        const completed = () =>
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-fixture",
              turn: { id: "turn-fixture", status: "interrupted", items: [] },
            },
          });
        if (model === "interrupt-notification-first") {
          completed();
          response();
        } else {
          response();
          completed();
        }
        break;
      }
      default:
        write({ id: frame.id, error: { code: -32601, message: "unsupported fixture method" } });
    }
  });
} else {
  process.stderr.write(`unknown fixture argv: ${args.join(" ")}\n`);
  process.exit(2);
}
