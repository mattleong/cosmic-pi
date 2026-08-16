#!/usr/bin/env node
import { appendFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
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
  if (
    process.env.HOME?.includes("pi-subagents-custom-codex-home-") &&
    (!process.env.CODEX_HOME || process.env.CODEX_HOME.includes("source-codex-home"))
  ) {
    process.stderr.write("Private copied Codex auth home was not used\n");
    process.exit(1);
  }
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
  let assistantCounter = 0;
  if (process.env.HOME?.includes("hanging-catalog"))
    writeFileSync(join(process.env.HOME, "fixture.pid"), String(process.pid));
  if (process.env.HOME?.includes("deduplicated-catalog"))
    appendFileSync(join(process.env.HOME, "catalog-processes.log"), `${process.pid}\n`);
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
      "Bash",
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
          response: (() => {
            const objectPart2323_0 = { subtype: "success", request_id: frame.request_id };
            const objectPart2323_1 =
              response === undefined ? objectPart2323_0 : { ...objectPart2323_0, response };
            return objectPart2323_1;
          })(),
        });
      if (frame.request?.subtype === "initialize") {
        if (
          frame.request_id === "pi-subagents-model-catalog" &&
          process.env.HOME?.includes("hanging-catalog")
        )
          return;
        if (
          frame.request_id === "pi-subagents-model-catalog" &&
          process.env.HOME?.includes("rejected-claude-catalog")
        ) {
          write({
            type: "control_response",
            response: {
              subtype: "error",
              request_id: frame.request_id,
              error: "Fixture catalog rejected",
            },
          });
          return;
        }
        const initialized = () =>
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
                            displayName: process.env.HOME?.includes("unsafe-catalog")
                              ? "\u001b[31mUnsafe"
                              : "Default Claude",
                            description: "Fixture default model",
                            supportedEffortLevels: ["off", "low", "medium", "high"],
                          },
                          {
                            value: "sonnet",
                            resolvedModel: "claude-sonnet-fixture",
                            displayName: "Claude Sonnet",
                            description: "Fixture\nefficient\tmodel",
                            supportedEffortLevels: ["low", "high"],
                          },
                        ]
                      : [{ value: model, resolvedModel: model }],
                },
          );
        const catalogDelay = process.env.HOME?.includes("deduplicated-catalog") ? 150 : 0;
        if (frame.request_id === "pi-subagents-model-catalog" && catalogDelay > 0)
          setTimeout(initialized, catalogDelay);
        else initialized();
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
          write(
            (() => {
              const objectPart5161_0 = {
                type: "user",
                isReplay: true,
                session_id: "claude-fixture-session",
              };
              const objectPart5161_1 =
                model === "interrupt-foreign-marker"
                  ? { ...objectPart5161_0, uuid: "00000000-0000-4000-8000-00000000fade" }
                  : objectPart5161_0;
              const objectPart5161_2 = {
                ...objectPart5161_1,
                message: { role: "user", content: "[Request interrupted by user]" },
              };
              return objectPart5161_2;
            })(),
          );
        const result = () =>
          write(
            (() => {
              const objectPart5546_0 = {
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
              };
              const objectPart5546_1 =
                model === "interrupt-foreign-result"
                  ? {
                      ...objectPart5546_0,
                      user_message_uuid: "00000000-0000-4000-8000-00000000dead",
                    }
                  : objectPart5546_0;
              return objectPart5546_1;
            })(),
          );
        const terminal = () => {
          if (model === "interrupt-result-first") {
            result();
            marker();
          } else {
            marker();
            result();
          }
        };
        if (model === "interrupt-late-terminal") {
          // The correlated marker/result settlement arrives only after the
          // parent's public interrupt timeout has already expired.
          response();
          setTimeout(terminal, 11_000);
          return;
        }
        if (model === "interrupt-terminal-no-response") {
          terminal();
        } else if (model === "interrupt-terminal-first") {
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
    write(
      (() => {
        const objectPart7177_0 = {
          type: "user",
          isReplay: true,
          session_id: "claude-fixture-session",
        };
        const objectPart7177_1 = frame.uuid
          ? { ...objectPart7177_0, uuid: frame.uuid }
          : objectPart7177_0;
        const objectPart7177_2 = { ...objectPart7177_1, message: frame.message };
        return objectPart7177_2;
      })(),
    );
    if (model === "duplicate-replay" && frame.uuid)
      write({
        type: "user",
        isReplay: true,
        session_id: "claude-fixture-session",
        uuid: frame.uuid,
        message: frame.message,
      });
    if (model === "foreign-replay" && frame.shouldQuery !== false)
      write({
        type: "user",
        isReplay: true,
        session_id: "claude-fixture-session",
        uuid: "00000000-0000-4000-8000-00000000f0f0",
        message: { role: "user", content: "foreign injected input" },
      });
    if (frame.shouldQuery === false) {
      write(
        (() => {
          const objectPart7938_0 = {
            type: "result",
            subtype: "success",
            is_error: false,
            result: "",
            stop_reason: null,
            session_id: "claude-fixture-session",
          };
          const objectPart7938_1 = frame.uuid
            ? { ...objectPart7938_0, user_message_uuid: frame.uuid }
            : objectPart7938_0;
          return objectPart7938_1;
        })(),
      );
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
    assistantCounter += 1;
    const assistantMessage = (usage) => ({
      type: "assistant",
      session_id: "claude-fixture-session",
      message: {
        id: `msg-fixture-${assistantCounter}`,
        role: "assistant",
        content: [
          {
            type: "text",
            text: `Claude saw: ${text}; envLeak=${process.env.TEST_SECRET ?? "none"}`,
          },
        ],
        usage,
      },
    });
    write(assistantMessage({ input_tokens: 3, output_tokens: 4, cache_read_input_tokens: 1 }));
    // The current CLI repeats cumulative usage for the same assistant message id.
    if (model === "repeated-usage")
      write(assistantMessage({ input_tokens: 3, output_tokens: 6, cache_read_input_tokens: 1 }));
    if (model === "task-notification") {
      const notificationUuid = "00000000-0000-4000-8000-00000000a501";
      write({
        type: "user",
        uuid: notificationUuid,
        isSynthetic: true,
        origin: { kind: "task-notification" },
        session_id: "claude-fixture-session",
        message: { role: "user", content: "A background task completed." },
      });
      write({
        type: "result",
        subtype: "success",
        is_error: false,
        result: "",
        session_id: "claude-fixture-session",
        origin: { kind: "task-notification" },
      });
    }
    // Interrupt fixtures model a still-running native turn: only the correlated interrupt emits
    // their terminal result. Other models complete normally and exercise missing-report handling.
    if (model !== "claude-fixture" && !model.startsWith("interrupt")) {
      const emitResult = () =>
        write(
          (() => {
            const objectPart10086_0 = {
              type: "result",
              subtype: "success",
              is_error: false,
              result: "raw final ignored",
              session_id: "claude-fixture-session",
            };
            const objectPart10086_1 = frame.uuid
              ? { ...objectPart10086_0, user_message_uuid: frame.uuid }
              : objectPart10086_0;
            const objectPart10086_2 = {
              ...objectPart10086_1,
              usage: { input_tokens: 5, output_tokens: 4, cache_read_input_tokens: 1 },
              total_cost_usd: 0.001,
            };
            return objectPart10086_2;
          })(),
        );
      // Exceeds the former two-second grace to characterize real post-tool finalization.
      if (model === "buffered-report-cost") setTimeout(emitResult, 3_000);
      else emitResult();
    }
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
        if (process.env.HOME?.includes("rejected-catalog")) {
          write({ id: frame.id, error: { code: -32_000, message: "Fixture catalog rejected" } });
          break;
        }
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
                serviceTiers: [
                  { id: "priority", name: "Fast", description: "Fixture priority tier" },
                ],
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
            serviceTier:
              model === "service-tier-mismatch" ? "flex" : (frame.params.serviceTier ?? null),
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
        if (model === "informational-items") {
          for (const item of [
            { id: "reasoning-1", type: "reasoning", text: "thinking" },
            { id: "future-1", type: "futureInformationalItem" },
            { id: "command-1", type: "commandExecution", command: "ls", status: "completed" },
          ]) {
            write({
              method: "item/started",
              params: { threadId: "thread-fixture", turnId: turn, item },
            });
            write({
              method: "item/completed",
              params: { threadId: "thread-fixture", turnId: turn, item },
            });
          }
        }
        if (model === "forbidden-completed-item")
          write({
            method: "item/completed",
            params: {
              threadId: "thread-fixture",
              turnId: turn,
              item: { id: "collab-1", type: "collabAgentToolCall" },
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
        if (model === "interrupted-without-request")
          write({
            method: "turn/completed",
            params: {
              threadId: "thread-fixture",
              turn: { id: turn, status: "interrupted", items: [] },
            },
          });
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
        if (model === "interrupt-late-completion") {
          response();
          setTimeout(completed, 11_000);
          break;
        }
        if (model === "interrupt-completion-no-response") {
          completed();
        } else if (model === "interrupt-notification-first") {
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
