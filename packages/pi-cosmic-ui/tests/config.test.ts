import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";
import { configPaths, resolveConfig, updateFooterConfig } from "../src/config/store.ts";

const dirs: string[] = [];
afterEach(() => dirs.splice(0).forEach((dir) => rmSync(dir, { recursive: true, force: true })));

describe("Cosmic UI config", () => {
  test("merges project overrides and preserves unknown fields when settings change", () => {
    const root = mkdtempSync(join(tmpdir(), "cosmic-ui-"));
    dirs.push(root);
    const cwd = join(root, "project");
    const agent = join(root, "agent");
    mkdirSync(cwd, { recursive: true });
    const paths = configPaths(cwd, agent);
    mkdirSync(join(cwd, ".pi", "extensions"), { recursive: true });
    writeFileSync(
      paths.project,
      JSON.stringify({ custom: 42, footer: { density: "compact", future: true } }),
    );

    const config = resolveConfig(cwd, agent);
    expect(config.footer.density).toBe("compact");
    updateFooterConfig(cwd, config, { enabled: false }, agent);
    const raw = JSON.parse(readFileSync(paths.project, "utf8"));
    expect(raw.custom).toBe(42);
    expect(raw.footer.future).toBe(true);
    expect(raw.footer.enabled).toBe(false);
  });
});
