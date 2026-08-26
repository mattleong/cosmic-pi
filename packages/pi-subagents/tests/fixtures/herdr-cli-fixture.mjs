#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(process.env.HERDR_CONFIG_PATH, "utf8"));
await appendFile(
  config.log,
  `${JSON.stringify({
    args: process.argv.slice(2),
    socket: process.env.HERDR_SOCKET_PATH ?? null,
    pane: process.env.HERDR_PANE_ID ?? null,
    piDirectory: process.env.PI_CODING_AGENT_DIR ?? null,
    claudeDirectory: process.env.CLAUDE_CONFIG_DIR ?? null,
    codexHome: process.env.CODEX_HOME ?? null,
    secret: process.env.SECRET ?? null,
  })}\n`,
);
const args = process.argv.slice(2);
const protocol =
  config.mode === "legacy-protocol" ? 19 : config.mode === "future-protocol" ? 21 : 20;
if (config.mode === "sleep") {
  await new Promise((resolve) => setTimeout(resolve, 5_000));
  process.exit(0);
}
if (args[0] === "--version") {
  console.log("fixture 1.0.0");
  process.exit(0);
}
if (args[0] === "auth") {
  console.log(JSON.stringify({ loggedIn: true }));
  process.exit(0);
}
if (args[0] === "api" && args[1] === "schema") {
  console.log(JSON.stringify({ protocol, schema_version: 1 }));
  process.exit(0);
}
if (args[0] === "integration") {
  console.log(
    "pi: current (v8) (/private/pi)\nclaude: current (v7) (/private/claude)\ncodex: current (v7) (/private/codex)",
  );
  process.exit(0);
}
if (config.mode === "oversized" || config.mode === "oversized-stderr") {
  const stream = config.mode === "oversized" ? process.stdout : process.stderr;
  for (let index = 0; index < 5 * 1024; index += 1) {
    if (!stream.write("x".repeat(1024)))
      await new Promise((resolve) => stream.once("drain", resolve));
  }
  process.exit(0);
}
if (config.mode === "malformed") {
  console.log("{not-json");
  process.exit(0);
}
if (args[0] === "agent" && args[1] === "start" && config.mode === "invalid-agent-name") {
  console.error(
    JSON.stringify({
      id: "cli:agent:start",
      error: {
        code: "invalid_agent_name",
        message:
          "agent name must start with a lowercase letter and contain only lowercase letters, digits, '-' or '_' (1-32 characters)",
      },
    }),
  );
  process.exit(1);
}
if (args[0] === "agent" && args[1] === "prompt" && config.mode === "agent-blocked") {
  console.error(
    JSON.stringify({
      id: "cli:agent:prompt",
      error: {
        code: "agent_blocked",
        message: "agent is waiting for approval or a user answer",
      },
    }),
  );
  process.exit(1);
}
if (args[0] === "agent" && args[1] === "start" && config.mode === "agent-start-timeout") {
  console.error(
    JSON.stringify({
      id: "cli:agent:start",
      error: { code: "timeout", message: "timed out waiting for agent readiness" },
    }),
  );
  process.exit(1);
}
if (args[0] === "agent" && args[1] === "start" && config.mode === "agent-pane-busy") {
  console.error(
    JSON.stringify({
      id: "cli:agent:start",
      error: {
        code: "agent_pane_busy",
        message: "agent target pane is not an available shell",
      },
    }),
  );
  process.exit(1);
}
if (args[0] === "agent" && args[1] === "start" && config.mode === "agent-pane-unavailable") {
  console.error(
    JSON.stringify({
      id: "cli:agent:start",
      error: {
        code: "agent_pane_unavailable",
        message: "agent target pane has no live terminal",
      },
    }),
  );
  process.exit(1);
}
if (args[0] === "api" && args[1] === "snapshot" && config.mode === "split-unicode") {
  const source = Buffer.from(
    JSON.stringify({
      id: "cli:api:snapshot",
      result: {
        type: "session_snapshot",
        snapshot: {
          version: "0.8.2",
          protocol,
          focused_workspace_id: null,
          focused_tab_id: null,
          focused_pane_id: null,
          workspaces: [
            {
              workspace_id: "w-unicode",
              label: "owned-😀",
              focused: false,
              active_tab_id: "w-unicode:t1",
            },
          ],
          tabs: [],
          panes: [],
          layouts: [],
          agents: [],
        },
      },
    }),
  );
  const emoji = Buffer.from("😀");
  const split = source.indexOf(emoji) + 1;
  process.stdout.write(source.subarray(0, split));
  await new Promise((resolve) => setTimeout(resolve, 25));
  process.stdout.write(source.subarray(split));
  process.exit(0);
}
const pane = {
  pane_id: process.env.HERDR_PANE_ID ?? "user:p0",
  terminal_id: "term-caller",
  workspace_id: "user",
  tab_id: "user:t",
  cwd: "/project",
  foreground_cwd: "/project",
  label: null,
  focused: false,
  agent_status: "unknown",
  revision: 1,
  scroll: null,
};
if (args[0] === "pane" && args[1] === "current") {
  console.log(
    JSON.stringify({
      id: "cli:pane:current",
      result: {
        type: "pane_current",
        pane: config.mode === "current-pane-mismatch" ? { ...pane, pane_id: "foreign:p" } : pane,
      },
    }),
  );
  process.exit(0);
}
if (args[0] === "workspace" && args[1] === "create") {
  console.log(
    JSON.stringify({
      id: "cli:workspace:create",
      result: {
        type: "workspace_created",
        workspace: {
          workspace_id: "w-owned",
          label: args[args.indexOf("--label") + 1],
          focused: false,
          active_tab_id: "w-owned:t1",
          number: 1,
          pane_count: 1,
          tab_count: 1,
          agent_status: "unknown",
        },
        tab: {
          tab_id: "w-owned:t1",
          workspace_id: "w-owned",
          label: "1",
          pane_count: 1,
          focused: false,
          number: 1,
          agent_status: "unknown",
        },
        root_pane: pane,
      },
    }),
  );
  process.exit(0);
}
if (args[0] === "pane" && args[1] === "run") process.exit(0);
if (args[0] === "pane" && args[1] === "wait-output" && config.mode === "wait-output-timeout") {
  console.error(
    JSON.stringify({
      id: "cli:pane:wait-output",
      error: { code: "timeout", message: "timed out waiting for output match" },
    }),
  );
  process.exit(1);
}
if (args[0] === "pane" && args[1] === "process-info") {
  const paneId = args[args.indexOf("--pane") + 1];
  console.log(
    JSON.stringify({
      id: "cli:pane:process_info",
      result: {
        type: "pane_process_info",
        process_info: {
          pane_id: paneId,
          shell_pid: 4242,
          foreground_process_group_id: 4242,
          foreground_processes: [{ pid: 4242, name: "zsh", argv0: "-zsh", cwd: "/project" }],
        },
      },
    }),
  );
  process.exit(0);
}
if (args[0] === "api" && args[1] === "snapshot") {
  console.log(
    JSON.stringify({
      id: "cli:api:snapshot",
      result: {
        type: "session_snapshot",
        snapshot: {
          version: "0.8.2",
          protocol: config.mode === "live-protocol-mismatch" ? 19 : protocol,
          focused_workspace_id: "user",
          focused_tab_id: "user:t",
          focused_pane_id: pane.pane_id,
          workspaces: [
            {
              workspace_id: "user",
              label: "user",
              focused: true,
              active_tab_id: "user:t",
            },
          ],
          tabs: [
            {
              tab_id: "user:t",
              workspace_id: "user",
              label: "user",
              pane_count: 1,
              focused: true,
            },
          ],
          panes: [pane],
          layouts: [],
          agents: [],
        },
      },
    }),
  );
  process.exit(0);
}
console.log(JSON.stringify({ result: {} }));
