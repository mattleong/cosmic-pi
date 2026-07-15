import { mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test, vi } from "vitest";
import { resetCapabilitiesCache, setCapabilities, visibleWidth } from "@earendil-works/pi-tui";
import sharp from "sharp";
import { _test } from "../index.ts";
import {
  type CodexPetPackage,
  type LoadedCodexPet,
  type PetFrame,
  type PetSpriteVersion,
  animationFrameAt,
  codexHome,
  CodexPetKittyManager,
  deleteCodexPetKittyImage,
  deleteCodexPetKittyPlacement,
  describeCodexPetSelectionIssue,
  formatCodexPetsHelp,
  formatCodexPetsListMessage,
  formatNoReadyCodexPetsMessage,
  listCodexPets,
  loadCodexPet,
  nextAnimationFrameDelayMs,
  openAIPetsArgumentCompletions,
  PET_ANIMATION_ROWS,
  renderCodexPetFrame,
} from "../src/pets.ts";

afterEach(() => {
  resetCapabilitiesCache();
  _test.petsTest.clearPetCatalogCache();
  vi.restoreAllMocks();
});

function firstKittyImageId(value: string): number | undefined {
  const sequenceStart = value.indexOf("\x1b_G");
  if (sequenceStart === -1) return undefined;
  const paramsStart = sequenceStart + "\x1b_G".length;
  const paramsEnd = value.indexOf(";", paramsStart);
  if (paramsEnd === -1) return undefined;
  const params = value.slice(paramsStart, paramsEnd);
  const imageId = params
    .split(",")
    .map((param) => param.split("=", 2))
    .find(([key]) => key === "i")?.[1];
  return imageId ? Number(imageId) : undefined;
}

type RgbaColor = { r: number; g: number; b: number; alpha: number };

type SpritesheetOptions = {
  width?: number;
  height?: number;
  background?: RgbaColor;
};

const DEFAULT_SPRITESHEET_BACKGROUND: RgbaColor = { r: 255, g: 0, b: 0, alpha: 1 };

async function createSpritesheetBuffer({
  width = 1536,
  height = 1872,
  background = DEFAULT_SPRITESHEET_BACKGROUND,
}: SpritesheetOptions = {}): Promise<Buffer> {
  return sharp({
    create: {
      width,
      height,
      channels: 4,
      background,
    },
  })
    .webp()
    .toBuffer();
}

async function writeValidSpritesheet(
  path: string,
  options: { background?: RgbaColor; spriteVersionNumber?: PetSpriteVersion } = {},
): Promise<void> {
  const { background, spriteVersionNumber = 1 } = options;
  const height = spriteVersionNumber === 2 ? 2288 : 1872;
  writeFileSync(path, await createSpritesheetBuffer({ background, height }));
}

async function withTempDir<T>(prefix: string, run: (tempDir: string) => Promise<T>): Promise<T> {
  const tempDir = await mkdtemp(join(tmpdir(), prefix));
  try {
    return await run(tempDir);
  } finally {
    rmSync(tempDir, { recursive: true, force: true });
  }
}

function petPackage(
  slug: string,
  name: string,
  overrides: Partial<CodexPetPackage> = {},
): CodexPetPackage {
  return {
    slug,
    name,
    spriteVersionNumber: 1,
    dir: `/tmp/${slug}`,
    spritesheetPath: "spritesheet.webp",
    hasSpritesheet: true,
    ...overrides,
  };
}

function kittyFrame(kittyImageId: number, rgba = [0, 0, 0, 255]): PetFrame {
  return {
    rawRgbaData: Buffer.from(rgba).toString("base64"),
    kittyImageId,
    mimeType: "image/png",
    durationMs: 100,
    widthPx: 1,
    heightPx: 1,
  };
}

function loadedPetWithIdleFrames(slug: string, name: string, frames: PetFrame[]): LoadedCodexPet {
  return {
    pet: petPackage(slug, name),
    states: { idle: frames } as LoadedCodexPet["states"],
  };
}

describe("Codex pets helpers", () => {
  test("resolves Codex home and pets directory", () => {
    expect(codexHome({ CODEX_HOME: "/tmp/codex" }, "/home/user")).toBe("/tmp/codex");
    expect(codexHome({}, "/home/user")).toBe("/home/user/.codex");
    expect(_test.petsTest.codexPetsDir("/tmp/codex")).toBe("/tmp/codex/pets");
  });

  test("lists valid local custom pets", async () => {
    await withTempDir("pi-better-openai-pets-", async (tempDir) => {
      const petsDir = join(tempDir, "pets");
      const petDir = join(petsDir, "stacky-plus");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(
        join(petDir, "pet.json"),
        JSON.stringify({
          id: "stacky-plus",
          displayName: "Stacky Plus",
          description: "A stack of helpful tokens.",
          spritesheetPath: "spritesheet.webp",
        }),
      );
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"));

      mkdirSync(join(petsDir, "broken"), { recursive: true });
      writeFileSync(join(petsDir, "broken", "spritesheet.webp"), "webp");

      const pets = await listCodexPets(tempDir);
      expect(pets).toHaveLength(2);
      expect(pets.find((pet) => pet.slug === "stacky-plus")).toMatchObject({
        slug: "stacky-plus",
        name: "Stacky Plus",
        description: "A stack of helpful tokens.",
        id: "stacky-plus",
        hasSpritesheet: true,
      });
      expect(pets.find((pet) => pet.slug === "broken")).toMatchObject({
        hasSpritesheet: false,
        spritesheetIssue: expect.stringContaining("invalid pet.json"),
      });
      expect(_test.petsTest.selectPet(pets, "Stacky Plus")?.slug).toBe("stacky-plus");
      expect(_test.petsTest.selectPet(pets, "STACKY_PLUS")?.slug).toBe("stacky-plus");
    });
  });

  test("lists and loads version 2 pets while preserving the standard animation rows", async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    await withTempDir("pi-better-openai-pets-v2-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "sevro");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(
        join(petDir, "pet.json"),
        JSON.stringify({
          id: "sevro",
          displayName: "Sevro",
          spriteVersionNumber: 2,
          spritesheetPath: "spritesheet.webp",
        }),
      );
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"), {
        spriteVersionNumber: 2,
      });

      const pets = await listCodexPets(tempDir);
      expect(pets).toHaveLength(1);
      expect(pets[0]).toMatchObject({
        slug: "sevro",
        name: "Sevro",
        spriteVersionNumber: 2,
        hasSpritesheet: true,
      });

      const loaded = await loadCodexPet("sevro", tempDir);
      expect(loaded?.pet.spriteVersionNumber).toBe(2);
      expect(Object.keys(loaded?.states ?? {})).toEqual(Object.keys(PET_ANIMATION_ROWS));
      expect(loaded?.states.idle).toHaveLength(6);
      expect(loaded?.states["running-right"]).toHaveLength(8);
      expect(loaded?.states.review).toHaveLength(6);
    });
  });

  test("ignores pet lookup requests with no alphanumeric key", () => {
    const pets = [petPackage("!!!", "!!!")];

    expect(_test.petsTest.findCodexPet(pets, "!!!")).toBeUndefined();
    expect(_test.petsTest.findReadyCodexPet(pets, "!!!")).toBeUndefined();
  });

  test("looks up Unicode pet names and prioritizes exact slugs over aliases", () => {
    const unicodePet = petPackage("猫", "猫");
    expect(_test.petsTest.findReadyCodexPet([unicodePet], "猫")).toBe(unicodePet);
    expect(_test.petsTest.petLookupKey("E\u0301lan 猫")).toBe("élan猫");

    const alias = petPackage("foobar", "Alias");
    const exact = petPackage("foo-bar", "Exact");
    expect(_test.petsTest.findReadyCodexPet([alias, exact], "foo-bar")).toBe(exact);
    expect(_test.petsTest.findReadyCodexPet([exact, alias], "foo bar")).toBeUndefined();
  });

  test("returns empty lists and actionable setup text when no pets exist", async () => {
    await withTempDir("pi-better-openai-pets-empty-", async (tempDir) => {
      expect(await listCodexPets(tempDir)).toEqual([]);
      const missingDirMessage = formatNoReadyCodexPetsMessage([], tempDir);
      expect(missingDirMessage).toContain("No custom Codex pets found.");
      expect(missingDirMessage).toContain(join(tempDir, "pets"));
      expect(missingDirMessage).toContain("$skill-installer hatch-pet");

      mkdirSync(join(tempDir, "pets"), { recursive: true });
      expect(await listCodexPets(tempDir)).toEqual([]);
      expect(formatCodexPetsListMessage([], tempDir)).toContain("Expected folder:");
    });
  });

  test("reports custom pets with malformed pet.json as not ready", async () => {
    await withTempDir("pi-better-openai-pets-json-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "bad-json");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), "{not json", "utf8");

      const pets = await listCodexPets(tempDir);

      expect(pets).toHaveLength(1);
      expect(pets[0]).toMatchObject({
        slug: "bad-json",
        name: "bad-json",
        hasSpritesheet: false,
      });
      expect(pets[0]?.spritesheetIssue).toContain("invalid pet.json");
      expect(formatCodexPetsListMessage(pets, tempDir)).toContain(
        "bad-json (bad-json) — invalid pet.json",
      );
    });
  });

  test("reports custom pets that are missing spritesheets as not ready", async () => {
    await withTempDir("pi-better-openai-pets-broken-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "ghost");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Ghost" }));

      const pets = await listCodexPets(tempDir);
      expect(pets).toHaveLength(1);
      expect(pets[0]).toMatchObject({
        slug: "ghost",
        hasSpritesheet: false,
        spritesheetIssue: "missing spritesheet.webp",
      });
      expect(formatCodexPetsListMessage(pets, tempDir)).toContain(
        "Ghost (ghost) — missing spritesheet.webp",
      );

      const issue = describeCodexPetSelectionIssue(pets, "ghost", tempDir);
      expect(issue.short).toBe('Pet "Ghost" is not ready.');
      expect(issue.message).toContain("exists but is not ready");
      expect(issue.message).toContain("Problem: missing spritesheet.webp");
    });
  });

  test("sanitizes control characters from displayed pet slugs", async () => {
    await withTempDir("pi-better-openai-pets-slug-", async (tempDir) => {
      const rawSlug = "bad\u001b[31m\nslug";
      const petDir = join(tempDir, "pets", rawSlug);
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Bad Slug" }));
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"));

      const pets = await listCodexPets(tempDir);
      const message = formatCodexPetsListMessage(pets, tempDir);

      expect(pets).toHaveLength(1);
      expect(pets[0]?.slug).toBe("bad slug");
      expect(message).toContain("Bad Slug (bad slug) — ready");
      expect(message).not.toContain("\u001b");
      expect(message).not.toContain("\nslug");
    });
  });

  test("rejects non-file or invalid spritesheets as not ready", async () => {
    await withTempDir("pi-better-openai-pets-invalid-", async (tempDir) => {
      const dirSheetPet = join(tempDir, "pets", "dir-sheet");
      mkdirSync(join(dirSheetPet, "spritesheet.webp"), { recursive: true });
      writeFileSync(join(dirSheetPet, "pet.json"), JSON.stringify({ name: "Dir Sheet" }));

      const garbagePet = join(tempDir, "pets", "garbage");
      mkdirSync(garbagePet, { recursive: true });
      writeFileSync(join(garbagePet, "pet.json"), JSON.stringify({ name: "Garbage" }));
      writeFileSync(join(garbagePet, "spritesheet.webp"), "not a webp");

      const wrongSizePet = join(tempDir, "pets", "wrong-size");
      mkdirSync(wrongSizePet, { recursive: true });
      writeFileSync(join(wrongSizePet, "pet.json"), JSON.stringify({ name: "Wrong Size" }));
      const wrongSizeSheet = await createSpritesheetBuffer({
        width: 1,
        height: 1,
        background: { r: 0, g: 0, b: 255, alpha: 1 },
      });
      writeFileSync(join(wrongSizePet, "spritesheet.webp"), wrongSizeSheet);

      const pets = await listCodexPets(tempDir);
      expect(pets.find((pet) => pet.slug === "dir-sheet")).toMatchObject({
        hasSpritesheet: false,
        spritesheetIssue: "spritesheet.webp is not a file",
      });
      expect(pets.find((pet) => pet.slug === "garbage")?.hasSpritesheet).toBe(false);
      expect(pets.find((pet) => pet.slug === "garbage")?.spritesheetIssue).toContain(
        "could not read spritesheet.webp",
      );
      expect(pets.find((pet) => pet.slug === "wrong-size")).toMatchObject({
        hasSpritesheet: false,
        spritesheetIssue: "invalid atlas dimensions: 1x1; expected 1536x1872 for sprite version 1",
      });
      const message = formatCodexPetsListMessage(pets, tempDir);
      expect(message).toContain("Dir Sheet (dir-sheet) — spritesheet.webp is not a file");
      expect(message).toContain("Garbage (garbage) — could not read spritesheet.webp");
      expect(message).toContain(
        "Wrong Size (wrong-size) — invalid atlas dimensions: 1x1; expected 1536x1872 for sprite version 1",
      );
    });
  });

  test("validates atlas dimensions against the declared sprite version", async () => {
    await withTempDir("pi-better-openai-pets-versioned-size-", async (tempDir) => {
      const cases = [
        {
          slug: "v2-with-v1-sheet",
          manifest: { name: "V2 With V1 Sheet", spriteVersionNumber: 2 },
          sheetVersion: 1 as const,
          expected: "invalid atlas dimensions: 1536x1872; expected 1536x2288 for sprite version 2",
        },
        {
          slug: "v1-with-v2-sheet",
          manifest: { name: "V1 With V2 Sheet" },
          sheetVersion: 2 as const,
          expected: "invalid atlas dimensions: 1536x2288; expected 1536x1872 for sprite version 1",
        },
        {
          slug: "explicit-v1",
          manifest: { name: "Explicit V1", spriteVersionNumber: 1 },
          sheetVersion: 1 as const,
          expected: undefined,
        },
      ];
      for (const fixture of cases) {
        const petDir = join(tempDir, "pets", fixture.slug);
        mkdirSync(petDir, { recursive: true });
        writeFileSync(join(petDir, "pet.json"), JSON.stringify(fixture.manifest));
        await writeValidSpritesheet(join(petDir, "spritesheet.webp"), {
          spriteVersionNumber: fixture.sheetVersion,
        });
      }

      const pets = await listCodexPets(tempDir);
      for (const fixture of cases) {
        const pet = pets.find((candidate) => candidate.slug === fixture.slug);
        expect(pet?.hasSpritesheet).toBe(fixture.expected === undefined);
        expect(pet?.spritesheetIssue).toBe(fixture.expected);
      }
    });
  });

  test("rejects invalid sprite version manifest values", async () => {
    await withTempDir("pi-better-openai-pets-invalid-version-", async (tempDir) => {
      for (const [slug, spriteVersionNumber] of [
        ["string-version", "2"],
        ["future-version", 3],
        ["null-version", null],
      ] as const) {
        const petDir = join(tempDir, "pets", slug);
        mkdirSync(petDir, { recursive: true });
        writeFileSync(
          join(petDir, "pet.json"),
          JSON.stringify({ name: slug, spriteVersionNumber }),
        );
        await writeValidSpritesheet(join(petDir, "spritesheet.webp"), {
          spriteVersionNumber: 2,
        });
      }

      const pets = await listCodexPets(tempDir);
      expect(pets).toHaveLength(3);
      for (const pet of pets) {
        expect(pet).toMatchObject({
          spriteVersionNumber: 1,
          hasSpritesheet: false,
          spritesheetIssue: "invalid spriteVersionNumber; expected 1 or 2",
        });
      }
      const message = formatNoReadyCodexPetsMessage(pets, tempDir);
      expect(message).toContain("v1 uses 1536x1872");
      expect(message).toContain("v2 uses 1536x2288 with spriteVersionNumber set to 2");
    });
  });

  test("rejects symlinked spritesheets as not ready when the platform supports symlinks", async () => {
    await withTempDir("pi-better-openai-pets-symlink-", async (tempDir) => {
      const petsDir = join(tempDir, "pets");
      const petDir = join(petsDir, "link-pet");
      const outsideDir = join(tempDir, "outside");
      mkdirSync(petDir, { recursive: true });
      mkdirSync(outsideDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Link Pet" }));
      await writeValidSpritesheet(join(outsideDir, "spritesheet.webp"));
      try {
        symlinkSync(join(outsideDir, "spritesheet.webp"), join(petDir, "spritesheet.webp"));
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === "EPERM" || code === "EACCES" || code === "ENOTSUP") return;
        throw error;
      }

      const pets = await listCodexPets(tempDir);

      expect(pets).toHaveLength(1);
      expect(pets[0]).toMatchObject({
        slug: "link-pet",
        hasSpritesheet: false,
        spritesheetIssue: "spritesheet.webp must not be a symlink",
      });
    });
  });

  test("reuses cached pet catalog metadata for repeated completions", async () => {
    await withTempDir("pi-better-openai-pets-cache-", async (tempDir) => {
      for (const slug of ["alpha", "beta"]) {
        const petDir = join(tempDir, "pets", slug);
        mkdirSync(petDir, { recursive: true });
        writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: slug }));
        await writeValidSpritesheet(join(petDir, "spritesheet.webp"));
      }
      const metadataSpy = vi.spyOn(sharp.prototype, "metadata");

      await openAIPetsArgumentCompletions("wake ", tempDir);
      await openAIPetsArgumentCompletions("wake a", tempDir);

      expect(metadataSpy).toHaveBeenCalledTimes(2);
    });
  });

  test("loads a selected pet without validating unrelated pet spritesheets", async () => {
    await withTempDir("pi-better-openai-pets-direct-load-", async (tempDir) => {
      for (const slug of ["target", "other-one", "other-two"]) {
        const petDir = join(tempDir, "pets", slug);
        mkdirSync(petDir, { recursive: true });
        writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: slug }));
        await writeValidSpritesheet(join(petDir, "spritesheet.webp"));
      }
      const metadataSpy = vi.spyOn(sharp.prototype, "metadata");

      const loaded = await loadCodexPet("target", tempDir);

      expect(loaded?.pet.slug).toBe("target");
      expect(metadataSpy).toHaveBeenCalledTimes(2);
    });
  });

  test("can refresh explicit pet listing diagnostics beyond the cache", async () => {
    await withTempDir("pi-better-openai-pets-refresh-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "refresh-me");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Refresh Me" }));

      const first = await listCodexPets(tempDir);
      expect(first[0]).toMatchObject({ hasSpritesheet: false });

      await writeValidSpritesheet(join(petDir, "spritesheet.webp"));
      const cached = await listCodexPets(tempDir);
      expect(cached[0]).toMatchObject({ hasSpritesheet: false });

      const refreshed = await listCodexPets(tempDir, { refresh: true });
      expect(refreshed[0]).toMatchObject({ hasSpritesheet: true });
    });
  });

  test("sanitizes pet metadata before display", () => {
    const info = _test.petsTest.petInfoFromJson(
      {
        id: "stacky\x1b[31m",
        displayName: "Stacky\x1b]0;bad\x07\nPlus",
        description: "Line One\r\n\x1b[31mLine Two\x1b[0m",
        spritesheetPath: "spritesheet.webp\x1b[31m",
      },
      "fallback",
    );

    expect(info).toEqual({
      id: "stacky",
      name: "Stacky Plus",
      description: "Line One Line Two",
      spriteVersionNumber: 1,
      spriteVersionIssue: undefined,
      spritesheetPath: "spritesheet.webp",
    });
    expect(JSON.stringify(info)).not.toContain("\x1b");
  });

  test("explains requested pet slugs that do not match a ready pet", () => {
    const pets = [petPackage("stacky-plus", "Stacky Plus")];

    const issue = describeCodexPetSelectionIssue(pets, "missing", "/tmp/codex");
    expect(issue.short).toBe('No ready pet matching "missing".');
    expect(issue.message).toContain("Ready pets:");
    expect(issue.message).toContain("stacky-plus");
  });

  test("formats /pets select prompts with only ready pets as choices", () => {
    const pets = [
      petPackage("ready", "Ready"),
      petPackage("broken", "Broken", { hasSpritesheet: false }),
    ];

    expect(_test.formatPetSelectPrompt(pets, "/tmp/codex")).toEqual({
      message:
        "Choose one with /pets select <slug>:\n- ready (Ready)\n\nNot ready:\n- broken (Broken) — missing spritesheet.webp",
      level: "info",
    });

    const noReadyPrompt = _test.formatPetSelectPrompt([pets[1]!], "/tmp/codex");
    expect(noReadyPrompt.level).toBe("warning");
    expect(noReadyPrompt.message).toContain("Found custom Codex pets, but none are ready.");
  });

  test("uses the official Codex atlas row order and frame durations", () => {
    expect(Object.entries(PET_ANIMATION_ROWS)).toEqual([
      ["idle", { row: 0, durations: [280, 110, 110, 140, 140, 320] }],
      ["running-right", { row: 1, durations: [120, 120, 120, 120, 120, 120, 120, 220] }],
      ["running-left", { row: 2, durations: [120, 120, 120, 120, 120, 120, 120, 220] }],
      ["waving", { row: 3, durations: [140, 140, 140, 280] }],
      ["jumping", { row: 4, durations: [140, 140, 140, 140, 280] }],
      ["failed", { row: 5, durations: [140, 140, 140, 140, 140, 140, 140, 240] }],
      ["waiting", { row: 6, durations: [150, 150, 150, 150, 150, 260] }],
      ["running", { row: 7, durations: [120, 120, 120, 120, 120, 220] }],
      ["review", { row: 8, durations: [150, 150, 150, 150, 150, 280] }],
    ]);
  });

  test("loads and slices a Codex pet spritesheet", async () => {
    await withTempDir("pi-better-openai-pet-load-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "tiny");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Tiny" }));
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"));

      const loaded = await loadCodexPet("tiny", tempDir);
      expect(loaded?.pet.name).toBe("Tiny");
      expect(loaded?.states.idle).toHaveLength(6);
      expect(loaded?.states.idle[0]).toMatchObject({
        mimeType: "image/png",
        durationMs: 280,
        widthPx: 192,
        heightPx: 208,
      });
      expect(animationFrameAt(loaded?.states.idle ?? [], 0)?.durationMs).toBe(280);
      expect(animationFrameAt(loaded?.states.idle ?? [], 559)?.durationMs).toBe(140);
      expect(animationFrameAt(loaded?.states.idle ?? [], 559, 2)?.durationMs).toBe(280);
      expect(nextAnimationFrameDelayMs(loaded?.states.idle ?? [], 0)).toBe(280);
      expect(nextAnimationFrameDelayMs(loaded?.states.idle ?? [], 279)).toBe(1);
      expect(nextAnimationFrameDelayMs(loaded?.states.idle ?? [], 280)).toBe(110);
    });
  });

  test("precomputes Kitty uploads for loaded pet frames", async () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    await withTempDir("pi-better-openai-pet-kitty-load-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "precomputed");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Precomputed" }));
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"));

      const loaded = await loadCodexPet("precomputed", tempDir, { sizeCells: 1 });
      const firstFrame = loaded?.states.idle[0];
      expect(firstFrame?.rawRgbaData).toBeUndefined();
      expect(firstFrame?.kittyUpload).toContain("a=t");

      const rendered = renderCodexPetFrame(
        loaded!,
        "idle",
        8,
        { fg: (_color, value) => value },
        {
          sizeCells: 1,
          imageId: 9,
          now: 0,
          kittyManager: new CodexPetKittyManager(9),
        },
      ).join("");
      expect(rendered).toContain(firstFrame!.kittyUpload!);
    });
  });

  test("avoids per-frame image encoding and animation output when terminal images are unsupported", async () => {
    setCapabilities({ images: null, trueColor: true, hyperlinks: false });
    await withTempDir("pi-better-openai-pet-no-images-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "fallback");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(join(petDir, "pet.json"), JSON.stringify({ name: "Fallback" }));
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"), {
        background: {
          r: 0,
          g: 255,
          b: 0,
          alpha: 1,
        },
      });

      const loaded = await loadCodexPet("fallback", tempDir);
      const firstFrame = loaded?.states.idle[0];
      expect(firstFrame?.data).toBeUndefined();
      expect(firstFrame?.rawRgbaData).toBeUndefined();
      expect(firstFrame).toMatchObject({ widthPx: 192, heightPx: 208 });

      const rendered = renderCodexPetFrame(
        loaded!,
        "idle",
        12,
        { fg: (_color, value) => value },
        {
          sizeCells: 10,
          imageId: 1,
          now: 0,
        },
      );
      expect(rendered[0]).toContain("[Image");
      expect(visibleWidth(rendered[0] ?? "")).toBeLessThanOrEqual(12);
    });
  });

  test("deletes stale Kitty placements before placing a pet frame", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const frame = kittyFrame(42);
    const loaded = loadedPetWithIdleFrames("kitty-cleanup", "Kitty Cleanup", [frame]);
    const manager = new CodexPetKittyManager(7);

    const firstRender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 7, now: 0, kittyManager: manager },
    ).join("");
    expect(firstRender).toContain(deleteCodexPetKittyPlacement(42));
    expect(firstKittyImageId(firstRender)).toBe(7);
    expect(firstRender).toContain("a=t");
    expect(firstRender).toContain("C=1");
    expect(firstRender).toContain("\x1b[1A");
    expect(firstRender).toContain("\x1b[1B");

    const secondRender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 7, now: 0, kittyManager: manager },
    ).join("");
    expect(secondRender).toContain(deleteCodexPetKittyPlacement(42));
    expect(firstKittyImageId(secondRender)).not.toBe(42);
    expect(secondRender).toContain("a=t");
  });

  test("reuploads Kitty frames when animation loops back to a prior frame", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const frames = [kittyFrame(101), kittyFrame(102, [255, 0, 0, 255])];
    const loaded = loadedPetWithIdleFrames("kitty-loop", "Kitty Loop", frames);
    const manager = new CodexPetKittyManager(10);

    const first = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      {
        sizeCells: 4,
        imageId: 10,
        now: 0,
        kittyManager: manager,
      },
    ).join("");
    const second = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      {
        sizeCells: 4,
        imageId: 10,
        now: 100,
        kittyManager: manager,
      },
    ).join("");
    const looped = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      {
        sizeCells: 4,
        imageId: 10,
        now: 200,
        kittyManager: manager,
      },
    ).join("");

    expect(first).toContain("i=101");
    expect(first).toContain("a=t");
    expect(second).toContain("i=102");
    expect(second).toContain("a=t");
    expect(looped).toContain("i=101");
    expect(looped).toContain("a=t");
  });

  test("centralizes Kitty frame upload and cleanup lifecycle", () => {
    setCapabilities({ images: "kitty", trueColor: true, hyperlinks: true });
    const loaded = loadedPetWithIdleFrames("kitty-manager", "Kitty Manager", [kittyFrame(84)]);
    const manager = new CodexPetKittyManager(9);

    const firstRender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 9, now: 0, kittyManager: manager },
    ).join("");
    expect(firstKittyImageId(firstRender)).toBe(9);
    expect(firstRender).toContain("a=t");

    const secondRender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 9, now: 0, kittyManager: manager },
    ).join("");
    expect(secondRender).toContain("a=t");

    manager.invalidate(loaded);
    const cleanup = manager.takeCleanupSequence();
    expect(cleanup.startsWith(deleteCodexPetKittyPlacement(9))).toBe(true);
    expect(firstKittyImageId(cleanup)).toBeUndefined();
    expect(cleanup).toContain(deleteCodexPetKittyImage(84));

    const rerender = renderCodexPetFrame(
      loaded,
      "idle",
      8,
      { fg: (_color, value) => value },
      { sizeCells: 4, imageId: 9, now: 0, kittyManager: manager },
    ).join("");
    expect(rerender).toContain("a=t");
  });

  test("completes pet names for wake and select subcommands", async () => {
    await withTempDir("pi-better-openai-pet-complete-", async (tempDir) => {
      const petDir = join(tempDir, "pets", "metalgarurumon");
      mkdirSync(petDir, { recursive: true });
      writeFileSync(
        join(petDir, "pet.json"),
        JSON.stringify({
          id: "metalgarurumon",
          displayName: "MetalGarurumon",
          description: "Cyber wolf",
        }),
      );
      await writeValidSpritesheet(join(petDir, "spritesheet.webp"));

      expect(await openAIPetsArgumentCompletions("w", tempDir)).toEqual([
        { value: "wake", label: "wake", description: "Render a footer pet" },
      ]);
      expect(await openAIPetsArgumentCompletions("wake M", tempDir)).toEqual([
        {
          value: "wake metalgarurumon",
          label: "MetalGarurumon",
          description: "metalgarurumon — Cyber wolf",
        },
      ]);
      expect(await openAIPetsArgumentCompletions("select metal", tempDir)).toEqual([
        {
          value: "select metalgarurumon",
          label: "MetalGarurumon",
          description: "metalgarurumon — Cyber wolf",
        },
      ]);
    });
  });

  test("builds pet settings picker values for ready pets", () => {
    const pets = [
      petPackage("stacky-plus", "Stacky Plus"),
      petPackage("broken", "Broken", { hasSpritesheet: false }),
    ];
    const cfg = { pets: { slug: "" } } as Parameters<typeof _test.petConfigPickerValue>[0];

    expect(_test.readyPetPickerValues(pets)).toEqual(["stacky-plus"]);
    expect(_test.petConfigPickerValue(cfg)).toBe(_test.PET_EMPTY_VALUE);
    expect(_test.petSlugFromPickerValue(_test.PET_EMPTY_VALUE)).toBe("");
    expect(_test.petPickerDescription(cfg, pets)).toContain("No pet selected.");

    cfg.pets.slug = "stacky-plus";
    expect(_test.petConfigPickerValue(cfg)).toBe("stacky-plus");
    expect(_test.petPickerDescription(cfg, pets)).toContain("Selected: Stacky Plus (stacky-plus)");
  });

  test("formats setup help", () => {
    const help = formatCodexPetsHelp("/tmp/codex");
    expect(help).toContain("$skill-installer hatch-pet");
    expect(help).toContain("/tmp/codex/pets/<pet-name>/");
    expect(help).toContain("/pets list");
  });
});
