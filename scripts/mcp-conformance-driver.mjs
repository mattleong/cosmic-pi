// Called only by verify-mcp-conformance.mjs through the pinned upstream CLI.
import assert from "node:assert/strict";
import { mkdir, realpath, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";
import { createJiti } from "jiti/static";

async function main() {
  const scenario = process.env.MCP_CONFORMANCE_SCENARIO;
  assert.ok(["initialize", "tools_call"].includes(scenario), "Unsupported scenario.");
  assert.equal(process.argv.length, 3, "Expected one upstream server URL.");
  const target = process.argv[2];
  // Check the original authority too: URL normalization can hide alternate IP spellings.
  assert.match(target, /^http:\/\/(localhost|127\.0\.0\.1):[1-9][0-9]*(?:\/[^?#]*)?$/);
  const url = new URL(target);
  assert.ok(url.port && Number(url.port) <= 65535, "Expected an explicit loopback port.");
  assert.equal(url.username + url.password + url.search + url.hash, "");

  const temporary = await realpath(process.env.PI_MCP_CONFORMANCE_ROOT);
  assert.ok(basename(temporary).startsWith("cosmic-mcp-conformance-"));
  const scratch = join(temporary, scenario);
  assert.equal(await realpath(scratch), scratch, "Scratch directory must not be a symlink.");
  const workspace = join(scratch, "workspace");
  const receipt = join(scratch, "receipt.json");
  assert.equal(process.env.PI_MCP_CONFORMANCE_WORKDIR, workspace);
  assert.equal(process.env.PI_MCP_CONFORMANCE_RECEIPT, receipt);
  const token = process.env.PI_MCP_CONFORMANCE_TOKEN;
  assert.match(token, /^[0-9a-f-]{36}$/);

  // Exclusive acquisition prevents cleanup of an existing directory supplied by a caller.
  await mkdir(workspace);
  const agent = join(workspace, "agent");
  const project = join(workspace, "project");
  await mkdir(join(agent, "extensions"), { recursive: true });
  await mkdir(project);
  process.env.PI_CODING_AGENT_DIR = agent;
  process.chdir(project);
  await writeFile(
    join(agent, "extensions/pi-mcp.json"),
    JSON.stringify({
      // The pinned initialize and tools_call scenarios grade only the 2025 protocol era.
      // They do not implement modern discovery; this runner measures explicit legacy use.
      mcpServers: {
        conformance: { type: "http", protocol: "legacy", url: target, auth: { type: "none" } },
      },
    }),
    { flag: "wx", mode: 0o600 },
  );

  // Import the real composition root only after isolating Pi's agent directory.
  const root = resolve(import.meta.dirname, "..");
  const jiti = createJiti(join(root, "packages/pi-mcp/index.ts"), {
    moduleCache: true,
    fsCache: false,
  });
  const Effect = await jiti.import("effect/Effect");
  const { makeMcpLayer } = await jiti.import(join(root, "packages/pi-mcp/src/layer.ts"));
  const { McpExecution } = await jiti.import(join(root, "packages/pi-mcp/src/tools/service.ts"));
  const layer = makeMcpLayer({ cwd: project, projectTrusted: true, isTrusted: () => true });
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* McpExecution;
        const request = (input) =>
          execution.execute(input, { maxOutputBytes: 32 * 1024, images: false });
        const accepted = (result) => {
          assert.equal(result.reply.outcome, "completed", JSON.stringify(result.reply));
          assert.equal(result.reply.isError, false, JSON.stringify(result.reply));
        };
        const result = yield* request(
          scenario === "initialize"
            ? { action: "tools.list", server: "conformance" }
            : {
                action: "tools.call",
                server: "conformance",
                tool: "add_numbers",
                arguments: { a: 5, b: 3 },
              },
        );
        accepted(result);
        const disconnected = yield* request({ action: "disconnect", server: "conformance" });
        accepted(disconnected);
        assert.equal(disconnected.reply.data.result.cleanup, "confirmed");
      }).pipe(Effect.provide(layer)),
    ),
  );
  // A wire-level pass is insufficient. Publish only after every application finalizer settles.
  process.chdir(root);
  await rm(workspace, { recursive: true });
  await writeFile(receipt, JSON.stringify({ scenario, token, cleanup: "confirmed" }), {
    flag: "wx",
    mode: 0o600,
  });
}

main().catch((error) => {
  console.error(String(error).slice(0, 4096));
  process.exitCode = 1;
});
