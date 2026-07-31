#!/usr/bin/env node
import { appendFile, readFile } from "node:fs/promises";

const config = JSON.parse(await readFile(process.env.HERDR_CONFIG_PATH, "utf8"));
await appendFile(
  config.log,
  `${JSON.stringify({ args: process.argv.slice(2), socket: process.env.HERDR_SOCKET_PATH ?? null })}\n`,
);
const args = process.argv.slice(2);
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
  console.log(JSON.stringify({ protocol: 17, schema_version: 1 }));
  process.exit(0);
}
if (args[0] === "integration") {
  console.log(
    "pi: current (v6) (/private/pi)\nclaude: current (v7) (/private/claude)\ncodex: current (v6) (/private/codex)",
  );
  process.exit(0);
}
if (config.mode === "oversized") {
  for (let index = 0; index < 5 * 1024; index += 1) {
    if (!process.stdout.write("x".repeat(1024)))
      await new Promise((resolve) => process.stdout.once("drain", resolve));
  }
  process.exit(0);
}
if (config.mode === "malformed") {
  console.log("{not-json");
  process.exit(0);
}
const pane = {
  pane_id: "w-owned:p1",
  terminal_id: "term-owned",
  workspace_id: "w-owned",
  tab_id: "w-owned:t1",
  cwd: "/project",
  foreground_cwd: "/project",
  label: null,
  focused: false,
  agent_status: "unknown",
};
if (args[0] === "workspace" && args[1] === "create") {
  console.log(
    JSON.stringify({
      result: {
        workspace: {
          workspace_id: "w-owned",
          label: args[args.indexOf("--label") + 1],
          focused: false,
          active_tab_id: "w-owned:t1",
        },
        tab: {
          tab_id: "w-owned:t1",
          workspace_id: "w-owned",
          label: "1",
          pane_count: 1,
          focused: false,
        },
        root_pane: pane,
      },
    }),
  );
  process.exit(0);
}
if (args[0] === "api" && args[1] === "snapshot") {
  console.log(
    JSON.stringify({
      result: {
        snapshot: {
          version: "0.7.5",
          protocol: 17,
          focused_workspace_id: null,
          focused_tab_id: null,
          focused_pane_id: null,
          workspaces: [],
          tabs: [],
          panes: [],
          agents: [],
        },
      },
    }),
  );
  process.exit(0);
}
console.log(JSON.stringify({ result: {} }));
