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
  "pi-background-terminals",
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
      `Expected core, ask-user, xAI, OpenAI, Cosmic UI, code-mode, code-preview, directory-model, advisor, background terminal, and subagent tarballs, found: ${tarballs.join(", ")}.`,
    );
  }
  const tarballPath = (packageName) => join(temporaryDirectory, tarballNames.get(packageName));
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
          "pi-ask-user": `file:${tarballPath("pi-ask-user")}`,
          "pi-better-openai": `file:${tarballPath("pi-better-openai")}`,
          "pi-better-xai": `file:${tarballPath("pi-better-xai")}`,
          "pi-cosmic-core": `file:${tarballPath("pi-cosmic-core")}`,
          "pi-cosmic-ui": `file:${tarballPath("pi-cosmic-ui")}`,
          "pi-code-mode": `file:${tarballPath("pi-code-mode")}`,
          "pi-code-previews": `file:${tarballPath("pi-code-previews")}`,
          "pi-directory-models": `file:${tarballPath("pi-directory-models")}`,
          "pi-advisor": `file:${tarballPath("pi-advisor")}`,
          "pi-background-terminals": `file:${tarballPath("pi-background-terminals")}`,
          "pi-subagents": `file:${tarballPath("pi-subagents")}`,
        },
        pnpm: {
          overrides: {
            "pi-ask-user": `file:${tarballPath("pi-ask-user")}`,
            "pi-cosmic-core": `file:${tarballPath("pi-cosmic-core")}`,
            "pi-cosmic-ui": `file:${tarballPath("pi-cosmic-ui")}`,
            "pi-better-openai": `file:${tarballPath("pi-better-openai")}`,
            "pi-better-xai": `file:${tarballPath("pi-better-xai")}`,
            "pi-code-mode": `file:${tarballPath("pi-code-mode")}`,
            "pi-code-previews": `file:${tarballPath("pi-code-previews")}`,
            "pi-directory-models": `file:${tarballPath("pi-directory-models")}`,
            "pi-background-terminals": `file:${tarballPath("pi-background-terminals")}`,
            "pi-subagents": `file:${tarballPath("pi-subagents")}`,
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
  const sourceImportSmoke = `
    import { createJiti } from "jiti/static";
    import { join } from "node:path";
    const load = (specifier) => createJiti(import.meta.url, { moduleCache: false }).import(specifier);
    const api = await load("pi-cosmic-core");
    const testing = await load("pi-cosmic-core/testing");
    const askUser = await load("pi-ask-user");
    const xai = await load("pi-better-xai");
    const openai = await load("pi-better-openai");
    const cosmicUi = await load("pi-cosmic-ui");
    const directoryModels = await load("pi-directory-models");
    const advisor = await load("pi-advisor");
    const terminals = await load("pi-background-terminals");
    const subagents = await load("pi-subagents");
    const codeMode = await load("pi-code-mode");
    const protocol = await load("pi-cosmic-ui/protocol");
    const client = await load("pi-cosmic-ui/client");
    const manager = await load("pi-cosmic-ui/manager");
    const fastModels = await load("pi-better-openai/fast-models");
    const previews = await load("pi-code-previews");
    const runtime = await load(join(process.cwd(), "node_modules/pi-code-mode/runtime/src/index.ts"));
    if (!api.PiApi || !api.makePiRuntime || !api.JsonDocumentStore || !api.JsonHttpClient || !api.nodePlatformLayer) throw new Error("missing core exports");
    if (typeof testing.makeInMemoryDocuments !== "function" || typeof testing.makeCapturedTracer !== "function") throw new Error("missing core testing exports");
    if (typeof askUser.default !== "function") throw new Error("missing ask-user extension export");
    if (typeof xai.default !== "function") throw new Error("missing xAI extension export");
    if (typeof openai.default !== "function") throw new Error("missing OpenAI extension export");
    if (typeof cosmicUi.default !== "function") throw new Error("missing Cosmic UI extension export");
    if (typeof directoryModels.default !== "function") throw new Error("missing directory-model extension export");
    if (typeof advisor.default !== "function") throw new Error("missing advisor extension export");
    if (typeof terminals.default !== "function") throw new Error("missing background terminals extension export");
    if (typeof subagents.default !== "function") throw new Error("missing subagents extension export");
    if (typeof codeMode.default !== "function") throw new Error("missing code-mode extension export");
    if (typeof previews.default !== "function" || typeof previews.loadCodePreviewSettings !== "function" || typeof previews.withCodePreviewShell !== "function") throw new Error("missing code-preview public exports");
    if (typeof runtime.CodeMode?.make !== "function" || typeof runtime.Tool?.make !== "function") throw new Error("missing source-loaded Code Mode runtime exports");
    if (protocol.COSMIC_UI_PROTOCOL_VERSION !== 1 || typeof protocol.isCosmicFooterUpsertEvent !== "function") throw new Error("missing Cosmic UI protocol exports");
    if (typeof client.createCosmicFooterClient !== "function") throw new Error("missing Cosmic UI client export");
    if (typeof manager.renderResponsiveManagerFooter !== "function") throw new Error("missing Cosmic UI manager export");
    if (typeof fastModels.supportsFastModel !== "function") throw new Error("missing OpenAI fast-model export");
  `;
  run(process.execPath, ["--input-type=module", "--eval", sourceImportSmoke], temporaryDirectory);

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
