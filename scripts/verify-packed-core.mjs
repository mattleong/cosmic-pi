import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
if (!expectedEffectVersion) throw new Error("Missing Effect version from the pnpm catalog.");
const extensionPackages = [
  "pi-better-xai",
  "pi-better-openai",
  "pi-cosmic-ui",
  "pi-code-previews",
  "pi-directory-models",
  "pi-advisor",
  "pi-background-terminals",
  "pi-herdr",
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
}

function assertPackedProtocolsResolved(packageName, manifest) {
  for (const section of ["dependencies", "peerDependencies", "optionalDependencies"]) {
    for (const [dependency, version] of Object.entries(manifest[section] ?? {})) {
      if (typeof version === "string" && /^(?:catalog:|workspace:)/.test(version)) {
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
      `Expected core, xAI, OpenAI, Cosmic UI, code-preview, directory-model, advisor, background terminal, Herdr, and subagent tarballs, found: ${tarballs.join(", ")}.`,
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
          "pi-better-openai": `file:${tarballPath("pi-better-openai")}`,
          "pi-better-xai": `file:${tarballPath("pi-better-xai")}`,
          "pi-cosmic-core": `file:${tarballPath("pi-cosmic-core")}`,
          "pi-cosmic-ui": `file:${tarballPath("pi-cosmic-ui")}`,
          "pi-code-previews": `file:${tarballPath("pi-code-previews")}`,
          "pi-directory-models": `file:${tarballPath("pi-directory-models")}`,
          "pi-advisor": `file:${tarballPath("pi-advisor")}`,
          "pi-background-terminals": `file:${tarballPath("pi-background-terminals")}`,
          "pi-herdr": `file:${tarballPath("pi-herdr")}`,
          "pi-subagents": `file:${tarballPath("pi-subagents")}`,
        },
        pnpm: {
          overrides: {
            "pi-cosmic-core": `file:${tarballPath("pi-cosmic-core")}`,
            "pi-cosmic-ui": `file:${tarballPath("pi-cosmic-ui")}`,
            "pi-better-openai": `file:${tarballPath("pi-better-openai")}`,
            "pi-better-xai": `file:${tarballPath("pi-better-xai")}`,
            "pi-code-previews": `file:${tarballPath("pi-code-previews")}`,
            "pi-directory-models": `file:${tarballPath("pi-directory-models")}`,
            "pi-background-terminals": `file:${tarballPath("pi-background-terminals")}`,
            "pi-herdr": `file:${tarballPath("pi-herdr")}`,
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
    ["install", "--prefer-offline", "--ignore-scripts", "--config.engine-strict=true"],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const api = await import('pi-cosmic-core'); const testing = await import('pi-cosmic-core/testing'); if (!api.PiApi || !api.makePiRuntime || !api.JsonDocumentStore || !api.JsonHttpClient || !api.nodePlatformLayer) throw new Error('missing core exports'); if (typeof testing.makeInMemoryDocuments !== 'function' || typeof testing.makeCapturedTracer !== 'function') throw new Error('missing core testing exports');",
    ],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { createJiti } from 'jiti'; const jiti = createJiti(import.meta.url); const xai = await jiti.import('pi-better-xai'); const openai = await jiti.import('pi-better-openai'); const cosmicUi = await jiti.import('pi-cosmic-ui'); const directoryModels = await jiti.import('pi-directory-models'); const advisor = await jiti.import('pi-advisor'); const terminals = await jiti.import('pi-background-terminals'); const herdr = await jiti.import('pi-herdr'); const subagents = await jiti.import('pi-subagents'); const protocol = await jiti.import('pi-cosmic-ui/protocol'); const client = await jiti.import('pi-cosmic-ui/client'); const manager = await jiti.import('pi-cosmic-ui/manager'); const fastModels = await jiti.import('pi-better-openai/fast-models'); const previews = await import('pi-code-previews'); if (typeof xai.default !== 'function') throw new Error('missing xAI extension export'); if (typeof openai.default !== 'function') throw new Error('missing OpenAI extension export'); if (typeof cosmicUi.default !== 'function') throw new Error('missing Cosmic UI extension export'); if (typeof directoryModels.default !== 'function') throw new Error('missing directory-model extension export'); if (typeof advisor.default !== 'function') throw new Error('missing advisor extension export'); if (typeof terminals.default !== 'function') throw new Error('missing background terminals extension export'); if (typeof herdr.default !== 'function') throw new Error('missing herdr extension export'); if (typeof subagents.default !== 'function') throw new Error('missing subagents extension export'); if (typeof previews.default !== 'function' || typeof previews.loadCodePreviewSettings !== 'function' || typeof previews.withCodePreviewShell !== 'function') throw new Error('missing code-preview public exports'); if (protocol.COSMIC_UI_PROTOCOL_VERSION !== 1 || typeof protocol.isCosmicFooterUpsertEvent !== 'function') throw new Error('missing Cosmic UI protocol exports'); if (typeof client.createCosmicFooterClient !== 'function') throw new Error('missing Cosmic UI client export'); if (typeof manager.renderResponsiveManagerFooter !== 'function') throw new Error('missing Cosmic UI manager export'); if (typeof fastModels.supportsFastModel !== 'function') throw new Error('missing OpenAI fast-model export');",
    ],
    temporaryDirectory,
  );

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
    "Packed core, xAI, OpenAI, Cosmic UI, code-preview, directory-model, advisor, background terminal, Herdr, and subagent packages install and import in a clean consumer.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
