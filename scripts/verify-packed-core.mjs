import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";

const root = resolve(import.meta.dirname, "..");
const workspace = await readFile(join(root, "pnpm-workspace.yaml"), "utf8");
const expectedEffectVersion = /\n  effect: ([^\n]+)/.exec(workspace)?.[1];
if (!expectedEffectVersion) throw new Error("Missing Effect version from the pnpm catalog.");
const coreManifest = JSON.parse(
  await readFile(join(root, "packages/pi-cosmic-core/package.json"), "utf8"),
);
const xaiManifest = JSON.parse(
  await readFile(join(root, "packages/pi-better-xai/package.json"), "utf8"),
);
const openaiManifest = JSON.parse(
  await readFile(join(root, "packages/pi-better-openai/package.json"), "utf8"),
);
const cosmicUiManifest = JSON.parse(
  await readFile(join(root, "packages/pi-cosmic-ui/package.json"), "utf8"),
);
const codePreviewsManifest = JSON.parse(
  await readFile(join(root, "packages/pi-code-previews/package.json"), "utf8"),
);
const advisorManifest = JSON.parse(
  await readFile(join(root, "packages/pi-advisor/package.json"), "utf8"),
);
const piVersion = coreManifest.devDependencies["@earendil-works/pi-coding-agent"];
const tuiVersion = xaiManifest.peerDependencies["@earendil-works/pi-tui"];
const temporaryDirectory = await mkdtemp(join(tmpdir(), "cosmic-pi-pack-"));

function run(command, args, cwd) {
  const result = spawnSync(command, args, {
    cwd,
    encoding: "utf8",
    env: process.env,
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout ?? ""}${result.stderr ?? ""}`,
    );
  }
  return result;
}

try {
  for (const packageName of [
    "pi-cosmic-core",
    "pi-better-xai",
    "pi-better-openai",
    "pi-cosmic-ui",
    "pi-code-previews",
    "pi-advisor",
  ]) {
    run("pnpm", ["--filter", packageName, "pack", "--pack-destination", temporaryDirectory], root);
  }
  const tarballs = (await readdir(temporaryDirectory)).filter((name) => name.endsWith(".tgz"));
  const coreTarballName = tarballs.find((name) => name.startsWith("pi-cosmic-core-"));
  const xaiTarballName = tarballs.find((name) => name.startsWith("pi-better-xai-"));
  const openaiTarballName = tarballs.find((name) => name.startsWith("pi-better-openai-"));
  const cosmicUiTarballName = tarballs.find((name) => name.startsWith("pi-cosmic-ui-"));
  const codePreviewsTarballName = tarballs.find((name) => name.startsWith("pi-code-previews-"));
  const advisorTarballName = tarballs.find((name) => name.startsWith("pi-advisor-"));
  if (
    !coreTarballName ||
    !xaiTarballName ||
    !openaiTarballName ||
    !cosmicUiTarballName ||
    !codePreviewsTarballName ||
    !advisorTarballName ||
    tarballs.length !== 6
  ) {
    throw new Error(
      `Expected core, xAI, OpenAI, Cosmic UI, code-preview, and advisor tarballs, found: ${tarballs.join(", ")}.`,
    );
  }

  const coreTarball = join(temporaryDirectory, coreTarballName);
  const xaiTarball = join(temporaryDirectory, xaiTarballName);
  const openaiTarball = join(temporaryDirectory, openaiTarballName);
  const cosmicUiTarball = join(temporaryDirectory, cosmicUiTarballName);
  const codePreviewsTarball = join(temporaryDirectory, codePreviewsTarballName);
  const advisorTarball = join(temporaryDirectory, advisorTarballName);
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
          "pi-better-openai": `file:${openaiTarball}`,
          "pi-better-xai": `file:${xaiTarball}`,
          "pi-cosmic-core": `file:${coreTarball}`,
          "pi-cosmic-ui": `file:${cosmicUiTarball}`,
          "pi-code-previews": `file:${codePreviewsTarball}`,
          "pi-advisor": `file:${advisorTarball}`,
        },
        pnpm: {
          overrides: {
            "pi-cosmic-core": `file:${coreTarball}`,
            "pi-better-openai": `file:${openaiTarball}`,
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
    ["install", "--offline", "--ignore-scripts", "--config.engine-strict=true"],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "const api = await import('pi-cosmic-core'); if (!api.PiApi || !api.makePiRuntime || !api.JsonDocumentStore || !api.JsonHttpClient || !api.nodePlatformLayer) throw new Error('missing core exports');",
    ],
    temporaryDirectory,
  );
  run(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      "import { createJiti } from 'jiti'; const jiti = createJiti(import.meta.url); const xai = await jiti.import('pi-better-xai'); const openai = await jiti.import('pi-better-openai'); const cosmicUi = await jiti.import('pi-cosmic-ui'); const advisor = await jiti.import('pi-advisor'); const protocol = await jiti.import('pi-cosmic-ui/protocol'); const previews = await import('pi-code-previews'); if (typeof xai.default !== 'function') throw new Error('missing xAI extension export'); if (typeof openai.default !== 'function') throw new Error('missing OpenAI extension export'); if (typeof cosmicUi.default !== 'function') throw new Error('missing Cosmic UI extension export'); if (typeof advisor.default !== 'function') throw new Error('missing advisor extension export'); if (typeof previews.default !== 'function' || typeof previews.loadCodePreviewSettings !== 'function' || typeof previews.withCodePreviewShell !== 'function') throw new Error('missing code-preview public exports'); if (protocol.COSMIC_UI_PROTOCOL_VERSION !== 1 || typeof protocol.isCosmicFooterUpsertEvent !== 'function') throw new Error('missing Cosmic UI protocol exports');",
    ],
    temporaryDirectory,
  );

  const packedCoreManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-cosmic-core/package.json"), "utf8"),
  );
  if (
    packedCoreManifest.dependencies.effect !== expectedEffectVersion ||
    packedCoreManifest.dependencies["@effect/platform-node"] !== expectedEffectVersion
  ) {
    throw new Error("Packed pi-cosmic-core dependencies do not use the pinned Effect beta.");
  }
  const packedXaiManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-better-xai/package.json"), "utf8"),
  );
  if (
    packedXaiManifest.dependencies.effect !== expectedEffectVersion ||
    packedXaiManifest.dependencies["pi-cosmic-core"] !== coreManifest.version
  ) {
    throw new Error("Packed pi-better-xai dependencies are not synchronized.");
  }
  const packedOpenaiManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-better-openai/package.json"), "utf8"),
  );
  if (
    packedOpenaiManifest.dependencies.effect !== expectedEffectVersion ||
    packedOpenaiManifest.dependencies["pi-cosmic-core"] !== coreManifest.version ||
    packedOpenaiManifest.version !== openaiManifest.version
  ) {
    throw new Error("Packed pi-better-openai dependencies are not synchronized.");
  }

  const packedCosmicUiManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-cosmic-ui/package.json"), "utf8"),
  );
  if (
    packedCosmicUiManifest.dependencies.effect !== expectedEffectVersion ||
    packedCosmicUiManifest.dependencies["pi-cosmic-core"] !== coreManifest.version ||
    packedCosmicUiManifest.version !== cosmicUiManifest.version
  ) {
    throw new Error("Packed pi-cosmic-ui dependencies are not synchronized.");
  }

  const packedCodePreviewsManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-code-previews/package.json"), "utf8"),
  );
  if (
    packedCodePreviewsManifest.dependencies.effect !== expectedEffectVersion ||
    packedCodePreviewsManifest.dependencies["pi-cosmic-core"] !== coreManifest.version ||
    packedCodePreviewsManifest.version !== codePreviewsManifest.version
  ) {
    throw new Error("Packed pi-code-previews dependencies are not synchronized.");
  }

  const packedAdvisorManifest = JSON.parse(
    await readFile(join(temporaryDirectory, "node_modules/pi-advisor/package.json"), "utf8"),
  );
  if (
    packedAdvisorManifest.dependencies.effect !== expectedEffectVersion ||
    packedAdvisorManifest.dependencies["pi-cosmic-core"] !== coreManifest.version ||
    packedAdvisorManifest.version !== advisorManifest.version
  ) {
    throw new Error("Packed pi-advisor dependencies are not synchronized.");
  }

  console.log(
    "Packed core, xAI, OpenAI, Cosmic UI, code-preview, and advisor packages install and import in a clean consumer.",
  );
} finally {
  await rm(temporaryDirectory, { recursive: true, force: true });
}
