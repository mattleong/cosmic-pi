// Real-smoke isolation checks exercise filesystem aliases without touching Herdr.
// @effect-diagnostics effect/nodeBuiltinImport:off
// @effect-diagnostics effect/processEnv:off
// @effect-diagnostics effect/asyncFunction:off
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  canonicalSmokePath,
  normalHerdrConfigPath,
  validateDisposableHerdrSelection,
} from "./herdr-real-smoke-safety.ts";

const directories: string[] = [];

const setup = async () => {
  const root = await fs.mkdtemp(join(tmpdir(), "pi-subagents-herdr-smoke-safety-"));
  directories.push(root);
  const protectedSocket = join(root, "protected.sock");
  const disposableSocket = join(root, "disposable.sock");
  const xdgConfigHome = join(root, "normal-xdg");
  const normalConfig = join(xdgConfigHome, "herdr", "config.toml");
  const disposableConfig = join(root, "disposable", "config.toml");
  await fs.mkdir(join(root, "nested"));
  await fs.mkdir(join(xdgConfigHome, "herdr"), { recursive: true });
  await fs.mkdir(join(root, "disposable"), { recursive: true });
  await Promise.all([
    fs.writeFile(protectedSocket, "socket-fixture"),
    fs.writeFile(disposableSocket, "socket-fixture"),
    fs.writeFile(normalConfig, "config-fixture"),
    fs.writeFile(disposableConfig, "config-fixture"),
  ]);
  return { root, protectedSocket, disposableSocket, xdgConfigHome, normalConfig, disposableConfig };
};

afterEach(async () => {
  await Promise.all(
    directories.splice(0).map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("real Herdr smoke isolation", () => {
  it("uses Herdr's config precedence and refuses dot-segment aliases", async () => {
    const fixture = await setup();
    expect(
      normalHerdrConfigPath({
        HERDR_CONFIG_PATH: fixture.disposableConfig,
        XDG_CONFIG_HOME: fixture.xdgConfigHome,
        HOME: fixture.root,
      }),
    ).toBe(canonicalSmokePath(fixture.disposableConfig));
    expect(
      normalHerdrConfigPath({ XDG_CONFIG_HOME: fixture.xdgConfigHome, HOME: fixture.root }),
    ).toBe(canonicalSmokePath(fixture.normalConfig));
    expect(normalHerdrConfigPath({ HOME: fixture.root })).toBe(
      canonicalSmokePath(join(fixture.root, ".config", "herdr", "config.toml")),
    );

    expect(() =>
      validateDisposableHerdrSelection(
        join(fixture.root, "nested", "..", "protected.sock"),
        fixture.disposableConfig,
        {
          HERDR_SOCKET_PATH: fixture.protectedSocket,
          XDG_CONFIG_HOME: fixture.xdgConfigHome,
        },
      ),
    ).toThrow(/refuses the inherited socket/u);
    expect(
      validateDisposableHerdrSelection(fixture.disposableSocket, fixture.disposableConfig, {
        HERDR_SOCKET_PATH: fixture.protectedSocket,
        XDG_CONFIG_HOME: fixture.xdgConfigHome,
      }),
    ).toEqual({
      socket: canonicalSmokePath(fixture.disposableSocket),
      configPath: canonicalSmokePath(fixture.disposableConfig),
    });
  });

  it.skipIf(process.platform === "win32")(
    "refuses symlink aliases for protected socket and normal config",
    async () => {
      const fixture = await setup();
      const socketAlias = join(fixture.root, "socket-alias");
      const configAlias = join(fixture.root, "config-alias");
      await fs.symlink(fixture.protectedSocket, socketAlias);
      await fs.symlink(fixture.normalConfig, configAlias);
      const inherited = {
        HERDR_SOCKET_PATH: fixture.protectedSocket,
        XDG_CONFIG_HOME: fixture.xdgConfigHome,
      };

      expect(() =>
        validateDisposableHerdrSelection(socketAlias, fixture.disposableConfig, inherited),
      ).toThrow(/refuses the inherited socket/u);
      expect(() =>
        validateDisposableHerdrSelection(fixture.disposableSocket, configAlias, inherited),
      ).toThrow(/normal Herdr config/u);
    },
  );

  it("requires inherited socket evidence before accepting a disposable target", async () => {
    const fixture = await setup();
    expect(() =>
      validateDisposableHerdrSelection(fixture.disposableSocket, fixture.disposableConfig, {
        XDG_CONFIG_HOME: fixture.xdgConfigHome,
      }),
    ).toThrow(/requires inherited HERDR_SOCKET_PATH evidence/u);
  });
});
