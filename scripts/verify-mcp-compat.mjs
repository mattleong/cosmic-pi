// Explicit network/download smoke, deliberately excluded from the unit test suite.
// All server packages, browser binaries, npm configuration, and fixtures are disposable.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { dirname, join, resolve, delimiter } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { createJiti } from "jiti/static";

const root = resolve(import.meta.dirname, "..");
const pins = {
  "@modelcontextprotocol/server-filesystem": "2026.8.31",
  "@playwright/mcp": "0.0.80",
};
const outputBytes = 50 * 1024;
const abort = new AbortController();
const interrupt = () => abort.abort(new Error("Compatibility smoke interrupted."));
const deadline = setTimeout(
  () => abort.abort(new Error("Compatibility smoke exceeded 15 minutes.")),
  900_000,
);
process.once("SIGINT", interrupt);
process.once("SIGTERM", interrupt);
const children = new Set();
let temporary;
let http;
let environment;

const killGroup = (pid, signal) => {
  if (pid === undefined) return;
  try {
    process.kill(-pid, signal);
  } catch (error) {
    if (error.code !== "ESRCH") throw error;
  }
};

async function command(
  executable,
  args,
  { cwd = temporary, timeout = 120_000, signal = abort.signal, exitCodes = [0] } = {},
) {
  signal?.throwIfAborted();
  const child = spawn(executable, args, {
    cwd,
    env: environment,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });
  children.add(child);
  let output = "";
  let failed;
  let escalation;
  const stop = (error) => {
    failed ??= error;
    killGroup(child.pid, "SIGTERM");
    escalation ??= setTimeout(() => {
      killGroup(child.pid, "SIGKILL");
      child.stdout.destroy();
      child.stderr.destroy();
    }, 2_000);
  };
  const capture = (chunk) => {
    output = (output + chunk.toString()).slice(-64 * 1024);
  };
  child.stdout.on("data", capture);
  child.stderr.on("data", capture);
  const onAbort = () => stop(signal.reason);
  signal?.addEventListener("abort", onAbort, { once: true });
  if (signal?.aborted) onAbort();
  const timer = setTimeout(() => stop(new Error(`Command timed out: ${executable}`)), timeout);
  try {
    const code = await new Promise((done, reject) => {
      child.once("error", reject);
      child.once("close", (code) => done(code));
    });
    if (failed || !exitCodes.includes(code))
      throw new Error(
        `${failed?.message ?? `Command exited ${code}`}: ${args.join(" ")}\n${output}`,
      );
    return output;
  } finally {
    clearTimeout(timer);
    clearTimeout(escalation);
    signal?.removeEventListener("abort", onAbort);
    killGroup(child.pid, "SIGKILL");
    children.delete(child);
  }
}

async function npmExecutable() {
  for (const directory of (process.env.PATH ?? "").split(delimiter)) {
    if (!directory) continue;
    const candidate = join(directory, "npm");
    try {
      await access(candidate);
      return await realpath(candidate);
    } catch {
      /* Try the next executable directory. */
    }
  }
  throw new Error("npm is required to install the pinned servers into the disposable consumer.");
}

async function installedPackage(name, expected) {
  const manifestPath = join(temporary, "consumer", "node_modules", name, "package.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.version, expected, `${name} version`);
  assert.equal(Object.keys(manifest.bin).length, 1, "Pinned server must expose one executable.");
  const entry = Object.values(manifest.bin)[0];
  const executable = resolve(dirname(manifestPath), entry);
  assert.ok(
    executable.startsWith(`${dirname(manifestPath)}/`),
    "Server entry must remain inside its installed package.",
  );
  return { manifestPath, manifest, executable };
}

async function fixturePage() {
  http = createServer((request, response) => {
    if (request.url !== "/fixture") {
      response.writeHead(404);
      response.end();
      return;
    }
    response.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Content-Security-Policy": "default-src 'none'",
      "Cache-Control": "no-store",
    });
    response.end(
      "<!doctype html><html><head><title>pi-mcp local compatibility</title></head><body><h1>Owned loopback fixture</h1><p id=proof>filesystem and browser smoke</p></body></html>",
    );
  });
  await new Promise((done, reject) => {
    http.once("error", reject);
    http.listen(0, "127.0.0.1", done);
  });
  return `http://127.0.0.1:${http.address().port}/fixture`;
}

async function verifyGateway(filesystem, playwright, fixture, url) {
  const jiti = createJiti(join(root, "packages/pi-mcp/index.ts"), {
    moduleCache: true,
    fsCache: false,
  });
  const load = (path) => jiti.import(join(root, "packages/pi-mcp/src", path));
  const Effect = await jiti.import("effect/Effect");
  const Layer = await jiti.import("effect/Layer");
  const { openSdkStdio } = await load("boundary/sdk-stdio.ts");
  const { McpConnector } = await load("boundary/sdk-connection.ts");
  const { McpConfigStore } = await load("config/store.ts");
  const { McpAuth } = await load("auth/service.ts");
  const { McpActivity } = await load("activity/service.ts");
  const { McpConnections } = await load("connection/service.ts");
  const { McpDiscovery } = await load("discovery/service.ts");
  const { McpResults } = await load("results/service.ts");
  const { JsonSchemaValidator } = await load("boundary/schema-validator.ts");
  const { McpExecution } = await load("tools/service.ts");
  const { DEFAULT_MCP_SETTINGS } = await load("config/schema.ts");
  const connections = new Map();
  const cleanup = new Map();
  const settings = {
    ...DEFAULT_MCP_SETTINGS,
    enabled: true,
    requestTimeoutMs: 45_000,
    idleTimeoutMs: 600_000,
  };
  const servers = Object.fromEntries(
    [
      ["filesystem", [filesystem.executable, fixture]],
      [
        "playwright",
        [
          playwright.executable,
          "--headless",
          "--isolated",
          "--browser",
          "chromium",
          "--output-dir",
          join(temporary, "output"),
        ],
      ],
    ].map(([id, args]) => [
      id,
      {
        id,
        scope: "project",
        directory: fixture,
        identity: `smoke:${temporary}:${id}`,
        enabled: true,
        definition: {
          transport: "stdio",
          command: process.execPath,
          args,
          cwd: fixture,
          environment: {},
          denyTools: [],
        },
      },
    ]),
  );
  const config = { revision: 1, trusted: true, settings, servers, diagnostics: [] };
  const forbidden = () =>
    Effect.die(
      new Error(
        "The compatibility fixture has no configuration or authentication mutation capability.",
      ),
    );
  // Only these owned application boundaries are replaced. No real config or credentials are read.
  const configLayer = Layer.succeed(McpConfigStore, {
    snapshot: Effect.succeed(config),
    subscribe: () => Effect.void,
    reload: forbidden(),
    setServer: forbidden,
    removeServer: forbidden,
    setSettings: forbidden,
  });
  const authLayer = Layer.succeed(McpAuth, {
    access: (server) =>
      server.definition.transport === "stdio" ? Effect.succeed(undefined) : forbidden(),
    status: () => Effect.succeed({ state: "none" }),
    login: forbidden,
    logout: forbidden,
    revoke: Effect.void,
  });
  const connectorLayer = Layer.succeed(McpConnector, {
    open: (server) =>
      openSdkStdio({
        command: server.definition.command,
        args: server.definition.args,
        cwd: fixture,
        environment,
        requestTimeoutMs: settings.requestTimeoutMs,
        connectTimeoutMs: 20_000,
        cleanupTimeoutMs: 5_000,
        onCleanup: (confirmed) => cleanup.set(server.id, confirmed),
      }).pipe(
        Effect.tap((connection) => Effect.sync(() => connections.set(server.id, connection))),
      ),
  });
  const activityLayer = McpActivity.layer();
  const connectionLayer = McpConnections.layer({ isTrusted: () => true }).pipe(
    Layer.provide(Layer.mergeAll(configLayer, authLayer, connectorLayer, activityLayer)),
  );
  const discoveryLayer = McpDiscovery.layer.pipe(
    Layer.provide(Layer.mergeAll(connectionLayer, activityLayer)),
  );
  const executionLayer = McpExecution.layer.pipe(
    Layer.provide(
      Layer.mergeAll(
        connectionLayer,
        discoveryLayer,
        McpResults.layer(),
        JsonSchemaValidator.layer(),
        authLayer,
      ),
    ),
  );

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const execution = yield* McpExecution;
        const request = (input, images = true) =>
          execution.execute(input, { maxOutputBytes: outputBytes, images }).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                assert.equal(result.reply.outcome, "completed", input.action);
                assert.equal(
                  result.reply.isError,
                  false,
                  `${input.action}: ${JSON.stringify(result.reply)}`,
                );
                assert.ok(
                  Buffer.byteLength(JSON.stringify(result)) <= outputBytes,
                  "Public output must be bounded.",
                );
                assert.deepEqual(result.images, [], "Text-only smoke must not return images.");
              }),
            ),
          );
        const readData = (initial) =>
          Effect.gen(function* () {
            if (initial.reply.data.result !== undefined) return initial.reply.data.result;
            assert.ok(
              initial.reply.resultId?.length > 0,
              "A limited projection must have a retained result.",
            );
            let offset = 0;
            let serialized = "";
            for (let page = 0; page < 128; page++) {
              const slice = yield* request(
                { action: "result.read", id: initial.reply.resultId, offset, limit: 8192 },
                false,
              );
              const data = slice.reply.data;
              assert.equal(data.format, "json");
              assert.equal(data.offset, offset);
              assert.ok(data.text?.length > 0, "Retained pagination must make progress.");
              serialized += data.text;
              assert.ok(
                Buffer.byteLength(serialized) <= 1024 * 1024,
                "Smoke metadata recovery is bounded to 1 MiB.",
              );
              if (data.next === null) return JSON.parse(serialized);
              assert.ok(data.next > offset, "Retained cursor must advance.");
              offset = data.next;
            }
            throw new Error("Retained metadata exceeded the smoke's 128-page bound.");
          });
        const metadata = new Map();
        const outputValidated = new Set();
        const call = (server, tool, args, images = true) =>
          request({ action: "tools.call", server, tool, arguments: args }, images).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (metadata.get(`${server}:${tool}`)?.outputSchema !== undefined) {
                  assert.equal(
                    result.reply.data.origin?.outputValidation,
                    "passed",
                    `${server}:${tool} isolated output validation`,
                  );
                  outputValidated.add(`${server}:${tool}`);
                }
              }),
            ),
          );
        const text = (result) => JSON.stringify(result.reply.data);
        for (const server of Object.keys(servers)) {
          const listed = yield* request({ action: "tools.list", server, limit: 100 });
          const items = (yield* readData(listed)).page.items;
          assert.ok(
            Array.isArray(items) && items.length > 0,
            `${server} tool discovery must produce metadata.`,
          );
          for (const tool of items) metadata.set(`${server}:${tool.name}`, tool);
          console.log(
            `${server}: discovered ${items.length} tools through McpExecution; ${items.filter((tool) => tool.outputSchema !== undefined).length} advertise output schemas`,
          );
        }

        const file = join(fixture, "written.txt");
        const invalid = yield* execution
          .execute(
            {
              action: "tools.call",
              server: "filesystem",
              tool: "write_file",
              arguments: { path: file, content: 42 },
            },
            { maxOutputBytes: outputBytes, images: true },
          )
          .pipe(Effect.result);
        assert.equal(
          invalid._tag,
          "Failure",
          "Invalid real-server input must fail before dispatch.",
        );
        assert.equal(invalid.failure.kind, "invalid-input");
        assert.equal(invalid.failure.outcome, "not-sent");
        yield* Effect.promise(async () => {
          await assert.rejects(access(file), { code: "ENOENT" });
        });
        const payload = "pi-mcp compatibility fixture\n";
        yield* call("filesystem", "write_file", { path: file, content: payload });
        const read = yield* call("filesystem", "read_text_file", { path: file }, false);
        assert.ok(text(read).includes(payload.trim()), "MCP read must return the written fixture.");
        yield* Effect.promise(async () => {
          assert.equal(await readFile(file, "utf8"), payload);
        });
        assert.ok(read.reply.resultId?.length > 0, "Completed output must be retained.");
        const retained = yield* request(
          { action: "result.read", id: read.reply.resultId, limit: 4096 },
          false,
        );
        assert.ok(
          text(retained).includes(payload.trim()),
          "Retained output must remain recoverable without replay.",
        );
        const largeFile = join(fixture, "bounded.txt");
        const largePayload = "bounded-content-".repeat(5000);
        yield* call("filesystem", "write_file", { path: largeFile, content: largePayload });
        const limited = yield* call("filesystem", "read_text_file", { path: largeFile }, false);
        assert.equal(
          limited.reply.data.truncated,
          true,
          "A real result larger than 50 KiB must be bounded.",
        );
        assert.ok(
          JSON.stringify(yield* readData(limited)).includes(largePayload),
          "Bounded slices must recover the full accepted content without another tool call.",
        );
        console.log(
          "filesystem: invalid input rejected not-sent; write_file -> read_text_file -> result.read passed; 80 KB fixture recovered through bounded slices",
        );

        yield* call("playwright", "browser_navigate", { url });
        const snapshot = yield* call("playwright", "browser_snapshot", {}, false);
        assert.ok(
          text(snapshot).includes("Owned loopback fixture"),
          "Snapshot must contain owned fixture text.",
        );
        const evaluated = yield* call(
          "playwright",
          "browser_evaluate",
          {
            function:
              "() => ({ title: document.title, text: document.querySelector('#proof').textContent })",
          },
          false,
        );
        assert.ok(
          text(evaluated).includes("pi-mcp local compatibility"),
          "Browser title must match fixture.",
        );
        assert.ok(
          text(evaluated).includes("filesystem and browser smoke"),
          "Browser text must match fixture.",
        );
        yield* call("playwright", "browser_close", {});
        console.log(
          "playwright: browser_navigate loopback -> browser_snapshot -> browser_evaluate -> browser_close passed",
        );

        for (const [server, connection] of connections) {
          assert.ok(
            connection.protocolVersion?.length > 0,
            "SDK must report its negotiated protocol version.",
          );
          console.log(`${server}: negotiated MCP ${connection.protocolVersion}`);
          const disconnected = yield* request({ action: "disconnect", server });
          assert.equal(disconnected.reply.data.result?.cleanup, "confirmed", `${server} cleanup`);
          const health = yield* connection.health;
          assert.equal(health.closed, true, `${server} closed`);
          assert.equal(health.cleanupUnconfirmed, false, `${server} cleanup confirmed`);
        }
        console.log(
          `Isolated output schemas validated: ${[...outputValidated].join(", ") || "none advertised by the exercised tools; SDK wire-result validation still applies"}`,
        );
      }).pipe(Effect.provide(executionLayer)),
    ),
    { signal: abort.signal },
  );
  assert.equal(connections.size, 2);
  for (const server of connections.keys())
    assert.equal(cleanup.get(server), true, `${server} scoped process cleanup`);
  console.log(
    "McpExecution: isolated input validation, retention, gateway/JSON projections, and SDK scope cleanup passed",
  );
}

async function cleanupTemporary() {
  for (const child of children) killGroup(child.pid, "SIGKILL");
  if (http?.listening) {
    http.closeAllConnections();
    await new Promise((done, reject) => http.close((error) => (error ? reject(error) : done())));
  }
  if (!temporary) return;
  // This also catches a browser that escaped its parent's process group. Match only
  // the unique disposable directory, never a server name or the user's browser.
  const pattern = temporary.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const owned = async () =>
    (
      await command("/usr/bin/pgrep", ["-f", pattern], {
        signal: null,
        timeout: 5_000,
        exitCodes: [0, 1],
      })
    )
      .split("\n")
      .map((line) => Number(line.trim()))
      .filter((pid) => pid > 0 && pid !== process.pid);
  let remaining = await owned();
  const leaked = remaining.length > 0;
  for (const signal of ["SIGTERM", "SIGKILL"]) {
    for (const pid of remaining) {
      try {
        process.kill(pid, signal);
      } catch (error) {
        if (error.code !== "ESRCH") throw error;
      }
    }
    if (remaining.length) await delay(500);
    remaining = await owned();
  }
  assert.deepEqual(
    remaining,
    [],
    "Owned server/browser processes must be gone before fixture removal.",
  );
  await rm(temporary, { recursive: true, force: true, maxRetries: 3 });
  await assert.rejects(access(temporary), { code: "ENOENT" });
  assert.equal(leaked, false, "Smoke required emergency process cleanup after SDK scope closure.");
  console.log(
    "cleanup: no owned server/browser processes, temporary consumer/cache/profile/fixtures removed",
  );
}

try {
  assert.equal(
    process.platform,
    "darwin",
    "This explicit smoke requires macOS stdio process-group support.",
  );
  // Darwin's usual /var/folders TMPDIR exceeds Playwright's Unix socket path
  // limit after its own suffixes. Keep all owned resources under a short root.
  temporary = await realpath(await mkdtemp("/private/tmp/pi-mcp-compat-"));
  for (const name of ["consumer", "fixture", "home", "tmp", "output", "cache", "config"])
    await mkdir(join(temporary, name));
  const npm = await npmExecutable();
  const emptyNpmConfig = join(temporary, "empty.npmrc");
  const emptyGlobalNpmConfig = join(temporary, "global.npmrc");
  await writeFile(emptyNpmConfig, "");
  await writeFile(emptyGlobalNpmConfig, "");
  await writeFile(
    join(temporary, "consumer/package.json"),
    JSON.stringify({ private: true, type: "module" }),
  );
  environment = {
    PATH: `${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`,
    HOME: join(temporary, "home"),
    TMPDIR: join(temporary, "tmp"),
    XDG_CACHE_HOME: join(temporary, "cache"),
    XDG_CONFIG_HOME: join(temporary, "config"),
    npm_config_userconfig: emptyNpmConfig,
    npm_config_globalconfig: emptyGlobalNpmConfig,
    npm_config_cache: join(temporary, "npm-cache"),
    npm_config_update_notifier: "false",
    PLAYWRIGHT_BROWSERS_PATH: join(temporary, "browsers"),
    CI: "1",
  };
  // The fixed validation helper inherits this process's environment. Strip host
  // credentials and config paths before any application modules or helpers load.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, environment);
  console.log(
    `Installing explicit disposable server pins: ${Object.entries(pins)
      .map(([name, version]) => `${name}@${version}`)
      .join(", ")}`,
  );
  console.log(
    (
      await command(
        process.execPath,
        [
          npm,
          "install",
          "--ignore-scripts",
          "--no-audit",
          "--no-fund",
          "--package-lock=false",
          ...Object.entries(pins).map(([name, version]) => `${name}@${version}`),
        ],
        { cwd: join(temporary, "consumer"), timeout: 240_000 },
      )
    ).trim(),
  );
  const filesystem = await installedPackage(
    "@modelcontextprotocol/server-filesystem",
    pins["@modelcontextprotocol/server-filesystem"],
  );
  const playwright = await installedPackage("@playwright/mcp", pins["@playwright/mcp"]);
  const playwrightVersion = playwright.manifest.dependencies.playwright;
  assert.match(
    playwrightVersion,
    /^\d+\.\d+\.\d+(?:-[\w.-]+)?$/,
    "MCP must pin its Playwright dependency exactly.",
  );
  const playwrightManifestPath = createRequire(playwright.manifestPath).resolve(
    "playwright/package.json",
  );
  const playwrightManifest = JSON.parse(await readFile(playwrightManifestPath, "utf8"));
  assert.equal(playwrightManifest.version, playwrightVersion);
  console.log(`Downloading isolated Chromium with Playwright ${playwrightVersion}`);
  console.log(
    (
      await command(
        process.execPath,
        [join(dirname(playwrightManifestPath), "cli.js"), "install", "chromium"],
        { timeout: 360_000 },
      )
    ).trim(),
  );
  await verifyGateway(filesystem, playwright, join(temporary, "fixture"), await fixturePage());
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  try {
    await cleanupTemporary();
  } catch (error) {
    console.error("Cleanup failed:", error);
    process.exitCode = 1;
  }
  clearTimeout(deadline);
  process.removeListener("SIGINT", interrupt);
  process.removeListener("SIGTERM", interrupt);
}
