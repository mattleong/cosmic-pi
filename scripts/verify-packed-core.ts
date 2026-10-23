import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import * as Arr from "effect/Array";
import * as Match from "effect/Match";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";
import { parse as parseYaml } from "yaml";

import { decodePackageManifest, type PackageManifest } from "./package-manifest.ts";
import { workspacePackageDirectories } from "./workspace-manifest-paths.ts";

const root = resolve(import.meta.dirname, "..");
const WorkspaceDocument = Schema.Struct({ catalog: Schema.Record(Schema.String, Schema.String) });
const { catalog } = Schema.decodeUnknownSync(WorkspaceDocument)(
  // The failsafe schema keeps bare-number catalog versions as strings.
  parseYaml(await readFile(join(root, "pnpm-workspace.yaml"), "utf8"), { schema: "failsafe" }),
);
const catalogVersion = (name: string): string => {
  const version = catalog[name];
  if (version === undefined) throw new Error(`Missing ${name} from the pnpm catalog.`);
  return version;
};
const expectedEffectVersion = catalogVersion("effect");
// Every public workspace package is packed; private packages never reach consumers.
const manifests = new Map(
  Arr.filterMap(
    await Promise.all(
      (await workspacePackageDirectories(root)).map(async (directory) =>
        decodePackageManifest(await readFile(join(directory, "package.json"), "utf8")),
      ),
    ),
    (manifest) =>
      manifest.private === true
        ? Result.failVoid
        : Result.succeed<[string, PackageManifest]>([manifest.name, manifest]),
  ),
);
const packageNames = [...manifests.keys()];
const extensionPackages = packageNames.filter((packageName) => packageName !== "pi-cosmic-core");
// Code Previews loads through Pi's resource loader below rather than a bare default import.
const directlyLoadedExtensions = extensionPackages.filter(
  (packageName) => packageName !== "pi-code-previews",
);
const sourceManifest = (packageName: string): PackageManifest => {
  const manifest = manifests.get(packageName);
  if (manifest === undefined) throw new Error(`Missing ${packageName} source manifest.`);
  return manifest;
};
const coreManifest = sourceManifest("pi-cosmic-core");
const piVersion = catalogVersion("@earendil-works/pi-coding-agent");
const tuiVersion = catalogVersion("@earendil-works/pi-tui");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cosmic-pi-pack-"));

interface RunOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly timeout?: number;
  readonly killSignal?: NodeJS.Signals;
}

function run(
  command: string,
  args: readonly string[],
  cwd: string,
  options: RunOptions = {},
): string {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    ...options,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

const workspaceStoreDir = run("pnpm", ["store", "path"], root).trim();

function assertPackedProtocolsResolved(packageName: string, manifest: PackageManifest): void {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"] as const) {
    for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
      if (/^(?:catalog:|workspace:)/.test(version)) {
        throw new Error(
          `Packed ${packageName} retains unresolved ${section}.${dependency} = ${version}.`,
        );
      }
    }
  }
}

try {
  for (const packageName of packageNames) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", temporaryDirectory], root);
  }
  const tarballs = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".tgz"));
  const tarballNames = new Map<string, string>();
  for (const packageName of packageNames) {
    const tarball = tarballs.find(
      (name) => name === `${packageName}-${sourceManifest(packageName).version}.tgz`,
    );
    if (tarball !== undefined) tarballNames.set(packageName, tarball);
  }
  if (tarballs.length !== packageNames.length || tarballNames.size !== packageNames.length) {
    throw new Error(
      `Expected ${packageNames.length} workspace tarballs, found: ${tarballs.join(", ")}.`,
    );
  }
  const tarballPath = (packageName: string): string => {
    const tarball = tarballNames.get(packageName);
    if (tarball === undefined) throw new Error(`Missing ${packageName} workspace tarball.`);
    return join(temporaryDirectory, tarball);
  };
  const tarballDependencies = Object.fromEntries(
    packageNames.map((packageName) => [packageName, `file:${tarballPath(packageName)}`]),
  );
  await writeFile(
    join(temporaryDirectory, "package.json"),
    `${JSON.stringify(
      {
        name: "cosmic-pi-pack-smoke",
        private: true,
        type: "module",
        dependencies: {
          "@earendil-works/pi-ai": catalogVersion("@earendil-works/pi-ai"),
          "@earendil-works/pi-coding-agent": piVersion,
          "@earendil-works/pi-tui": tuiVersion,
          jiti: "2.7.0",
          typebox: catalogVersion("typebox"),
          effect: expectedEffectVersion,
          ...tarballDependencies,
        },
        pnpm: {
          overrides: {
            ...tarballDependencies,
            "@effect/platform-node-shared": expectedEffectVersion,
          },
        },
      },
      null,
      2,
    )}\n`,
    "utf8",
  );

  run(
    "pnpm",
    [
      "install",
      "--prefer-offline",
      "--ignore-scripts",
      "--config.engine-strict=true",
      `--config.store-dir=${workspaceStoreDir}`,
    ],
    temporaryDirectory,
  );
  await writeFile(
    join(temporaryDirectory, "mcp-fixture.ts"),
    await readFile(join(root, "scripts/fixtures/native-mcp-server.ts")),
  );
  const agentDirectory = join(temporaryDirectory, "agent");
  const fixtureDirectory = join(temporaryDirectory, "mcp-project");
  const consumerEnvironment = {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: join(temporaryDirectory, "home"),
    TMPDIR: join(temporaryDirectory, "tmp"),
    PI_CODING_AGENT_DIR: agentDirectory,
    PI_OFFLINE: "1",
    PI_TELEMETRY: "0",
  };
  await Promise.all(
    [
      join(agentDirectory, "extensions"),
      fixtureDirectory,
      consumerEnvironment.HOME,
      consumerEnvironment.TMPDIR,
    ].map((directory) => mkdir(directory, { recursive: true })),
  );
  await writeFile(
    join(agentDirectory, "mcp.json"),
    JSON.stringify({
      mcpServers: {
        fixture: {
          command: process.execPath,
          args: [
            join(temporaryDirectory, "mcp-fixture.ts"),
            join(temporaryDirectory, "mcp-fixture-state.json"),
          ],
          cwd: fixtureDirectory,
          env: {},
        },
      },
    }),
  );
  const sourceImportSmoke = String.raw`
    import { createJiti } from "jiti/static";
    import { readFile, realpath } from "node:fs/promises";
    import { join } from "node:path";
    const jiti = createJiti(import.meta.url, { moduleCache: true, fsCache: false });
    const load = (specifier) => jiti.import(specifier);
    const api = await load("pi-cosmic-core");
    const testing = await load("pi-cosmic-core/testing");
    const toolArguments = await load("pi-cosmic-core/tool-arguments");
    for (const packageName of ${JSON.stringify(directlyLoadedExtensions)}) {
      const extension = await load(packageName);
      if (typeof extension.default !== "function") throw new Error("missing " + packageName + " extension export");
    }
    const protocol = await load("pi-cosmic-ui/protocol");
    const client = await load("pi-cosmic-ui/client");
    const manager = await load("pi-cosmic-ui/manager");
    const fastModels = await load("pi-better-openai/fast-models");
    const previews = await load("pi-code-previews");
    if (!api.PiApi || !api.makePiRuntime || !api.JsonDocumentStore || !api.JsonHttpClient || !api.nodePlatformLayer) throw new Error("missing core exports");
    if (typeof testing.makeInMemoryDocuments !== "function" || typeof testing.makeCapturedTracer !== "function") throw new Error("missing core testing exports");
    const { Type } = await import("typebox");
    const prepareSmoke = toolArguments.toolArgumentPreparer("smoke", Type.Object({ task: Type.String(), name: Type.Optional(Type.String()) }), () => true);
    if (JSON.stringify(prepareSmoke({ task: 1, name: " " })) !== '{"task":"1"}') throw new Error("packed core tool-argument preparation is unavailable");
    if (typeof previews.default !== "function" || typeof previews.loadCodePreviewSettings !== "function" || typeof previews.withCodePreviewShell !== "function" || typeof previews.withCodePreviewRenderers !== "function") throw new Error("missing code-preview public exports");
    const previewTesting = await load("pi-code-previews/testing");
    if (protocol.COSMIC_UI_PROTOCOL_VERSION !== 2) throw new Error("missing Cosmic UI v2 protocol exports");
    if (typeof client.createCosmicFooterClient !== "function") throw new Error("missing Cosmic UI client export");
    if (typeof manager.renderResponsiveManagerFooter !== "function") throw new Error("missing Cosmic UI manager export");
    if (typeof fastModels.supportsFastModel !== "function") throw new Error("missing OpenAI fast-model export");

    // Load packed Code Previews beside independently owned builtin MCP through Pi's public SDK.
    // No production manager factory is intercepted or replaced. No prompt/model call is made,
    // and the real local stdio fixture is the only configured server.
    const Pi = await import("@earendil-works/pi-coding-agent");
    const { fauxAssistantMessage, fauxToolCall } = await import("@earendil-works/pi-ai");
    const agentDir = process.env.PI_CODING_AGENT_DIR;
    if (Pi.getAgentDir() !== agentDir) throw new Error("Packed smoke must use its disposable agent directory.");
    const cwd = join(process.cwd(), "mcp-project");
    const previewRoot = await realpath(join(process.cwd(), "node_modules/pi-code-previews"));
    const previewManifest = JSON.parse(await readFile(join(previewRoot, "package.json"), "utf8"));
    let nativeCodemode;
    // Capture only the fresh definition produced by our own public native factory; never retrieve
    // a foreign loaded definition. Codemode is model-only, so it cannot nest itself through executeTool.
    const nativeFactory = Pi.createCodemodeExtension({ models: false });
    const resourceLoader = new Pi.DefaultResourceLoader({
      cwd, agentDir,
      additionalExtensionPaths: [join(previewRoot, previewManifest.pi.extensions[0])],
      noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
      extensionFactories: [
        { name: "codemode", builtin: true, replaceable: true, factory: (pi) => nativeFactory({
          ...pi, registerTool: (definition) => { nativeCodemode = definition; pi.registerTool(definition); },
        }) },
        { name: "mcp", factory: Pi.createMcpExtension(), builtin: true, replaceable: true },
      ],
    });
    await resourceLoader.reload();
    const loaded = resourceLoader.getExtensions();
    if (loaded.errors.length !== 0) throw new Error("Packed Code Previews failed to load: " + JSON.stringify(loaded.errors));
    const previewExtension = loaded.extensions.find((extension) => extension.path.startsWith(previewRoot));
    if (previewExtension?.toolRenderers?.length !== 1 ||
        [...previewExtension.tools.keys()].some((name) => name !== "write") ||
        previewExtension.commands.has("mcp") ||
        !loaded.extensions.some((extension) => extension.path === "builtin:mcp")) {
      throw new Error("Packed Code Previews must register one renderer resolver beside independent native MCP.");
    }
    const settingsManager = Pi.SettingsManager.create(cwd, agentDir);
    const modelRuntime = await Pi.ModelRuntime.create({
      authPath: join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: join(agentDir, "models-cache.json"),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    const sessionManager = Pi.SessionManager.inMemory(cwd);
    sessionManager.appendMessage(fauxAssistantMessage(
      fauxToolCall("codemode", {}, { id: "packed-native-smoke" }), { stopReason: "toolUse" },
    ));
    const { session } = await Pi.createAgentSession({
      cwd, agentDir, resourceLoader, settingsManager, modelRuntime, sessionManager,
    });
    const errors = [];
    try {
      await session.bindExtensions({ mode: "print", onError: (error) => errors.push(error) });
      // Native headless /mcp status waits for background connections without polling or changing
      // the active set. SDK startup alone does not await non-direct servers.
      const managerCommand = session.extensionRunner.getRegisteredCommands()
        .find((command) => command.invocationName === "mcp");
      if (managerCommand?.sourceInfo?.source !== "builtin" ||
          managerCommand.sourceInfo.path !== "builtin:mcp") {
        throw new Error("Packed native MCP manager is not independently builtin-owned.");
      }
      await managerCommand.handler("", session.extensionRunner.createCommandContext());
      const signal = AbortSignal.timeout(30_000);
      const input = {
        code: 'const result = await tools.mcp__fixture__echo({text:"packed MCP"}); text(result); image(result.content[1]);',
      };
      // Drive the public top-level tool-call hook: native MCP waits for the named server before
      // codemode receives its callable tools. No model prompt or forced activation is involved.
      const blocked = await session.extensionRunner.emitToolCall({
        type: "tool_call", toolCallId: "packed-native-smoke", toolName: "codemode", input,
      });
      if (blocked?.block || !session.getActiveToolNames().includes("codemode")) {
        throw new Error("Native MCP did not make default-exposure tools reachable: " + JSON.stringify({
          blocked, active: session.getActiveToolNames(), errors,
        }));
      }
      const context = session.extensionRunner.createToolContext("packed-native-smoke", signal);
      const called = await nativeCodemode.execute("packed-native-smoke", input, signal, undefined, context);
      const textBlocks = called.content.filter((block) => block.type === "text").map((block) => block.text).join("\n");
      const image = called.content.find((block) => block.type === "image");
      if (!textBlocks.includes('"text":"packed MCP"') ||
          !textBlocks.includes('"structuredContent":{"echoed":"packed MCP"}') ||
          !textBlocks.includes('"isError":false') || image?.mimeType !== "image/png" ||
          image.data !== "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=") {
        throw new Error("Packed native MCP content, structured evidence, or image was changed: " + JSON.stringify(called));
      }
      const resource = await context.executeTool("read_mcp_resource", {server:"fixture",uri:"fixture://packed"});
      if (resource.isError || !JSON.stringify(resource.result.content).includes("packed resource")) {
        throw new Error("Packed native MCP resource execution failed.");
      }
      const definitions = session.getAllTools();
      const echo = definitions.find((tool) => tool.name === "mcp__fixture__echo");
      if (echo?.sourceInfo?.source !== "builtin" || echo.sourceInfo.path !== "builtin:mcp") {
        throw new Error("Native fixture execution was not independently builtin-owned.");
      }
      const standalone = await context.executeTool("mcp__fixture__echo", {text:"standalone packed MCP"});
      const renderers = session.extensionRunner.resolveToolRenderers("mcp__fixture__echo", () => undefined);
      if (standalone.isError || !renderers) {
        throw new Error("Packed standalone native MCP presentation is unavailable.");
      }
      const snapshot = JSON.stringify(standalone.result);
      const nativeImage = standalone.result.content.find((block) => block.type === "image");
      const presentation = previewTesting.createToolPresentationHarness(renderers, {cwd, width:200});
      presentation.call({text:"standalone packed MCP"}, {expanded:true});
      presentation.result(standalone.result, {expanded:true, showImages:false});
      const rendered = presentation.render().join("\n");
      // Pi's own MCP renderer has no Arguments section; Code Previews' expanded call does.
      if (!rendered.includes("Arguments")) {
        throw new Error("Packed standalone native MCP presentation is unavailable.");
      }
      if (!rendered.includes("standalone packed MCP") ||
          JSON.stringify(standalone.result) !== snapshot ||
          standalone.result.content.find((block) => block.type === "image") !== nativeImage ||
          nativeImage?.data !== image.data) {
        throw new Error("Packed native MCP rendering changed output or native image evidence.");
      }
      const programRenderers = session.extensionRunner.resolveToolRenderers("codemode", () => undefined);
      // With no base definition, only the Code Previews resolver presents codemode.
      if (!programRenderers) {
        throw new Error("Packed native codemode renderer is unavailable after MCP activation.");
      }
      if (errors.length !== 0) throw new Error("Packed Code Previews/native MCP lifecycle errors: " + JSON.stringify(errors));
    } finally {
      // SDK embeddings own shutdown emission; dispose alone removes listeners.
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    }
    const marker = JSON.parse(await readFile(join(process.cwd(), "mcp-fixture-state.json"), "utf8"));
    if (marker.state !== "closed") throw new Error("Native MCP fixture did not receive shutdown.");
    try {
      process.kill(marker.pid, 0);
      throw new Error("Native MCP fixture survived manager cleanup.");
    } catch (error) {
      if (error.code !== "ESRCH") throw error;
    }
  `;
  const sourceImportPath = join(temporaryDirectory, "source-import-smoke.mjs");
  await writeFile(sourceImportPath, sourceImportSmoke, "utf8");
  run(process.execPath, [sourceImportPath], temporaryDirectory, {
    env: consumerEnvironment,
    timeout: 90_000,
    killSignal: "SIGKILL",
  });

  const packedSupervisorHelper = join(
    temporaryDirectory,
    "node_modules/pi-subagents/src/boundary/supervisor-mcp-helper.mjs",
  );
  const helperSmoke = spawnSync(process.execPath, [packedSupervisorHelper], {
    cwd: temporaryDirectory,
    env: consumerEnvironment,
    encoding: "utf8",
  });
  if (
    helperSmoke.status !== 2 ||
    !helperSmoke.stderr.includes("Private supervisor helper configuration argument is invalid.")
  ) {
    throw new Error(
      `Packed supervisor helper did not execute its typed source through the package launcher:\n${helperSmoke.stdout ?? ""}${helperSmoke.stderr ?? ""}`,
    );
  }

  const packedSharpDecoder = join(
    temporaryDirectory,
    "node_modules/pi-better-openai/src/boundary/sharp-decoder.mjs",
  );
  const sharpSmoke = spawnSync(process.execPath, [packedSharpDecoder], {
    cwd: temporaryDirectory,
    env: {},
    input: Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aD1sAAAAASUVORK5CYII=",
      "base64",
    ),
    encoding: "utf8",
    timeout: 30_000,
    killSignal: "SIGKILL",
    maxBuffer: 256,
  });
  if (
    sharpSmoke.status !== 0 ||
    sharpSmoke.stdout !== '{"format":"png"}' ||
    sharpSmoke.stderr !== ""
  ) {
    throw new Error("Packed Sharp decoder could not validate a tiny PNG in a clean consumer.");
  }

  await Promise.all(
    [
      "pi-cosmic-core/index.ts",
      "pi-cosmic-core/testing.ts",
      "pi-cosmic-core/src/runtime/runtime.ts",
      "pi-code-previews/index.ts",
      "pi-code-previews/src/extension.ts",
      "pi-code-previews/src/application/tool-renderers.ts",
      "pi-code-previews/src/tools/preview-admission.ts",
      "pi-code-previews/src/tools/native-mcp-render.ts",
    ].map((source) => readFile(join(temporaryDirectory, "node_modules", source))),
  );
  const exclusions = await Promise.all(
    [
      "pi-code-previews/tests",
      "pi-code-previews/tsconfig.json",
      "pi-cosmic-core/dist",
      "pi-code-previews/dist",
    ].map(async (excluded) => ({
      excluded,
      present: await stat(join(temporaryDirectory, "node_modules", excluded)).then(
        () => true,
        () => false,
      ),
    })),
  );
  const shipped = exclusions.find((exclusion) => exclusion.present);
  if (shipped !== undefined) {
    throw new Error(`Packed source package ships forbidden path: ${shipped.excluded}.`);
  }

  const packedCoreManifest = decodePackageManifest(
    await readFile(join(temporaryDirectory, "node_modules/pi-cosmic-core/package.json"), "utf8"),
  );
  assertPackedProtocolsResolved("pi-cosmic-core", packedCoreManifest);
  if (
    packedCoreManifest.dependencies?.effect !== expectedEffectVersion ||
    packedCoreManifest.dependencies["@effect/platform-node"] !== expectedEffectVersion
  ) {
    throw new Error("Packed pi-cosmic-core dependencies do not use the pinned Effect version.");
  }
  const packedManifests = await Promise.all(
    extensionPackages.map(async (packageName) => ({
      packageName,
      packedManifest: decodePackageManifest(
        await readFile(
          join(temporaryDirectory, "node_modules", packageName, "package.json"),
          "utf8",
        ),
      ),
    })),
  );
  for (const { packageName, packedManifest } of packedManifests) {
    const source = sourceManifest(packageName);
    assertPackedProtocolsResolved(packageName, packedManifest);
    if (
      packedManifest.dependencies?.effect !== expectedEffectVersion ||
      packedManifest.dependencies["pi-cosmic-core"] !== coreManifest.version ||
      packedManifest.version !== source.version
    ) {
      throw new Error(`Packed ${packageName} dependencies are not synchronized.`);
    }
    for (const [dependency, version] of Object.entries(source.dependencies ?? {})) {
      const expected = Match.value(version).pipe(
        Match.when("catalog:", () => catalogVersion(dependency)),
        Match.when("workspace:*", () => manifests.get(dependency)?.version),
        Match.orElse(() => version),
      );
      if (expected === undefined || packedManifest.dependencies[dependency] !== expected) {
        throw new Error(
          `Packed ${packageName} dependency ${dependency} does not match its source manifest.`,
        );
      }
    }
    if (
      packageName === "pi-code-previews" &&
      (packedManifest.private === true ||
        packedManifest.exports?.["."] !== "./index.ts" ||
        packedManifest.pi?.extensions?.length !== 1 ||
        packedManifest.pi.extensions[0] !== source.pi?.extensions?.[0] ||
        packedManifest.pi.extensions[0]?.endsWith(".ts") !== true)
    ) {
      throw new Error("Packed pi-code-previews must be a public source-only Pi extension.");
    }
  }

  console.log(
    "Packed TypeScript source resolves through Jiti in a clean consumer; Code Previews renders independently builtin-owned native MCP/codemode with unchanged execution, results, images, and confirmed fixture cleanup.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
