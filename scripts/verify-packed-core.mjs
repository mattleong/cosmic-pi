import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
if (!expectedEffectVersion) throw new Error("Missing Effect version from the pnpm catalog.");
const extensionPackages = [
  "pi-ask-user",
  "pi-better-xai",
  "pi-better-openai",
  "pi-cosmic-ui",
  "pi-code-mode",
  "pi-code-previews",
  "pi-directory-models",
  "pi-advisor",
  "pi-background-task",
  "pi-subagents",
];
const packageNames = ["pi-cosmic-core", ...extensionPackages];
const manifests = new Map();
for (const packageName of packageNames) {
  const path = join(root, "packages", packageName, "package.json");
  manifests.set(packageName, JSON.parse(await readFile(path, "utf8")));
}
const coreManifest = manifests.get("pi-cosmic-core");
const catalogVersion = (name) => {
  const escaped = name.replaceAll(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const version = new RegExp(`\\n  "?${escaped}"?: ([^\\n]+)`).exec(workspace)?.[1];
  if (!version) throw new Error(`Missing ${name} from the pnpm catalog.`);
  return version;
};
const piVersion = catalogVersion("@earendil-works/pi-coding-agent");
const piServerVersion = catalogVersion("@earendil-works/pi-server");
const tuiVersion = catalogVersion("@earendil-works/pi-tui");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cosmic-pi-pack-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result.stdout ?? "";
}

/**
 * The clean consumer lives outside the workspace, so pnpm would resolve a different package
 * store for it. Reusing the workspace's store keeps the smoke reproducible from already
 * fetched packages (unchanged for normal setups, where this is the global store anyway).
 */
const workspaceStoreDir = run("pnpm", ["store", "path"], root).trim();

function assertPackedProtocolsResolved(packageName, manifest) {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
      if (String(version) === version && /^(?:catalog:|workspace:)/.test(version)) {
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
  const tarballNames = new Map(
    packageNames.map((packageName) => [
      packageName,
      tarballs.find((name) => name.startsWith(`${packageName}-`)),
    ]),
  );
  if (tarballs.length !== packageNames.length || [...tarballNames.values()].some((name) => !name)) {
    throw new Error(
      `Expected core, ask-user, xAI, OpenAI, Cosmic UI, code-mode, code-preview, directory-model, advisor, background task, and subagent tarballs, found: ${tarballs.join(", ")}.`,
    );
  }
  const tarballPath = (packageName) => join(temporaryDirectory, tarballNames.get(packageName));
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
          "@earendil-works/pi-coding-agent": piVersion,
          "@earendil-works/pi-tui": tuiVersion,
          jiti: "2.7.0",
          ...tarballDependencies,
        },
        pnpm: {
          packageExtensions: {
            [`@earendil-works/pi-coding-agent@${piVersion}`]: {
              dependencies: {
                "@earendil-works/pi-server": piServerVersion,
              },
            },
          },
          overrides: Object.fromEntries(
            Object.entries(tarballDependencies).filter(
              ([packageName]) => packageName !== "pi-advisor",
            ),
          ),
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
  const sourceImportSmoke = `
    import { createJiti } from "jiti/static";
    import { join } from "node:path";
    const load = (specifier) => createJiti(import.meta.url, { moduleCache: false }).import(specifier);
    const api = await load("pi-cosmic-core");
    const testing = await load("pi-cosmic-core/testing");
    for (const packageName of ${JSON.stringify(extensionPackages.filter((name) => name !== "pi-code-previews"))}) {
      const extension = await load(packageName);
      if (typeof extension.default !== "function") throw new Error("missing " + packageName + " extension export");
    }
    const protocol = await load("pi-cosmic-ui/protocol");
    const client = await load("pi-cosmic-ui/client");
    const manager = await load("pi-cosmic-ui/manager");
    const fastModels = await load("pi-better-openai/fast-models");
    const previews = await load("pi-code-previews");
    const runtime = await load(join(process.cwd(), "node_modules/pi-code-mode/runtime/src/index.ts"));
    if (!api.PiApi || !api.makePiRuntime || !api.JsonDocumentStore || !api.JsonHttpClient || !api.nodePlatformLayer) throw new Error("missing core exports");
    if (typeof testing.makeInMemoryDocuments !== "function" || typeof testing.makeCapturedTracer !== "function") throw new Error("missing core testing exports");
    if (typeof previews.default !== "function" || typeof previews.loadCodePreviewSettings !== "function" || typeof previews.withCodePreviewShell !== "function") throw new Error("missing code-preview public exports");
    if (typeof runtime.CodeMode?.make !== "function" || typeof runtime.Tool?.make !== "function") throw new Error("missing source-loaded Code Mode runtime exports");
    if (protocol.COSMIC_UI_PROTOCOL_VERSION !== 2) throw new Error("missing Cosmic UI v2 protocol exports");
    if (typeof client.createCosmicFooterClient !== "function") throw new Error("missing Cosmic UI client export");
    if (typeof manager.renderResponsiveManagerFooter !== "function") throw new Error("missing Cosmic UI manager export");
    if (typeof fastModels.supportsFastModel !== "function") throw new Error("missing OpenAI fast-model export");
  `;
  run(process.execPath, ["--input-type=module", "--eval", sourceImportSmoke], temporaryDirectory);

  const packedSupervisorHelper = join(
    temporaryDirectory,
    "node_modules/pi-subagents/src/boundary/supervisor-mcp-helper.mjs",
  );
  const helperSmoke = spawnSync(process.execPath, [packedSupervisorHelper], {
    cwd: temporaryDirectory,
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

  // Pi and the clean-consumer smoke load TypeScript source directly through Jiti.
  for (const source of [
    "pi-cosmic-core/index.ts",
    "pi-cosmic-core/testing.ts",
    "pi-cosmic-core/src/runtime/runtime.ts",
    "pi-code-previews/index.ts",
    "pi-code-previews/src/extension.ts",
    "pi-code-mode/runtime/src/index.ts",
    "pi-code-mode/runtime/src/codemode.ts",
  ]) {
    await readFile(join(temporaryDirectory, "node_modules", source));
  }
  for (const notice of ["LICENSE", "THIRD_PARTY_NOTICES.md", "PROVENANCE.md"]) {
    await readFile(join(temporaryDirectory, "node_modules/pi-code-mode/runtime", notice));
  }
  // Runtime source ships by value, but its workspace manifest, tests, and build tooling remain
  // repository-only. No source-hosted package may regain a generated dist dependency.
  for (const excluded of [
    "pi-cosmic-core/dist",
    "pi-cosmic-core/tsdown.config.ts",
    "pi-code-previews/dist",
    "pi-code-previews/tsdown.config.ts",
    "pi-code-mode/runtime/dist",
    "pi-code-mode/runtime/tests",
    "pi-code-mode/runtime/node_modules",
    "pi-code-mode/runtime/package.json",
    "pi-code-mode/runtime/tsconfig.json",
    "pi-code-mode/runtime/tsdown.config.ts",
  ]) {
    const excludedPath = join(temporaryDirectory, "node_modules", excluded);
    const present = await stat(excludedPath).then(
      () => true,
      () => false,
    );
    if (present) throw new Error(`Packed source package ships forbidden path: ${excluded}.`);
  }

  const packedCoreManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-cosmic-core/package.json"), "utf8"),
  );
  assertPackedProtocolsResolved("pi-cosmic-core", packedCoreManifest);
  if (
    packedCoreManifest.dependencies.effect !== expectedEffectVersion ||
    packedCoreManifest.dependencies["@effect/platform-node"] !== expectedEffectVersion
  ) {
    throw new Error("Packed pi-cosmic-core dependencies do not use the pinned Effect beta.");
  }
  for (const packageName of extensionPackages) {
    const packedManifest = JSON.parse(
      await readFile(join(temporaryDirectory, "node_modules", packageName, "package.json"), "utf8"),
    );
    const sourceManifest = manifests.get(packageName);
    assertPackedProtocolsResolved(packageName, packedManifest);
    if (
      packedManifest.dependencies.effect !== expectedEffectVersion ||
      packedManifest.dependencies["pi-cosmic-core"] !== coreManifest.version ||
      packedManifest.version !== sourceManifest.version
    ) {
      throw new Error(`Packed ${packageName} dependencies are not synchronized.`);
    }
  }

  console.log(
    "Packed TypeScript source for core, extensions, previews, and Code Mode runtime installs and imports through Jiti in a clean consumer.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
