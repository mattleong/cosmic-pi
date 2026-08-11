import { describe, expect, test } from "vitest";
import type { FooterHostProjection } from "../src/boundary/host-footer-projection.ts";
import { DEFAULT_CONFIG, type ResolvedCosmicUiConfig } from "../src/config/schema.ts";
import {
  applyTextDecorations,
  builtinContributions,
  orderedContributions,
} from "../src/footer/builtin-contributions.ts";
import type {
  CosmicFooterStatusContribution,
  CosmicFooterTextContribution,
} from "../src/protocol/protocol.ts";

const emptyTotals = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 };

const host = (
  extensionStatuses: ReadonlyArray<{ readonly id: string; readonly text: string }>,
): FooterHostProjection => ({
  model: undefined,
  contextUsage: undefined,
  cwd: "/project",
  branch: null,
  sessionName: undefined,
  subscription: false,
  thinking: "off",
  providerCount: 1,
  extensionStatuses,
});

const placements = (
  ...entries: CosmicFooterStatusContribution[]
): ReadonlyMap<string, CosmicFooterStatusContribution> =>
  new Map(entries.map((entry) => [entry.id, entry]));

const config = (footer?: Partial<ResolvedCosmicUiConfig["footer"]>): ResolvedCosmicUiConfig => ({
  configPath: "/config.json",
  projectConfigPath: "/project/.pi/cosmic-ui.json",
  globalConfigPath: "/global/cosmic-ui.json",
  footer: { ...DEFAULT_CONFIG.footer, ...footer },
});

describe("status placement declarations", () => {
  test("places status entries by their declared placement", () => {
    const entries = builtinContributions(
      host([{ id: "pi-advisor", text: "advising…" }]),
      emptyTotals,
      undefined,
      undefined,
      undefined,
      placements({
        kind: "status",
        id: "pi-advisor",
        region: "identity",
        align: "right",
        priority: 100,
        order: 1000,
      }),
    );
    expect(entries.find((entry) => entry.id === "extension.pi-advisor")).toMatchObject({
      kind: "text",
      region: "identity",
      text: "advising…",
      align: "right",
      priority: 100,
      order: 1000,
    });
  });

  test("applies generic defaults to undeclared status entries", () => {
    const entries = builtinContributions(
      host([
        { id: "declared", text: "declared status" },
        { id: "unknown-extension", text: "unknown status" },
      ]),
      emptyTotals,
      undefined,
      undefined,
      undefined,
      placements({ kind: "status", id: "declared", region: "details", order: 1000 }),
    );
    expect(entries.find((entry) => entry.id === "extension.unknown-extension")).toMatchObject({
      region: "details",
      priority: 20,
      order: 1020,
    });
    const ordered = orderedContributions(
      entries.filter((entry) => entry.id.startsWith("extension.")),
      config(),
    );
    expect(ordered.map((entry) => entry.id)).toEqual([
      "extension.declared",
      "extension.unknown-extension",
    ]);
  });

  test("hides every status entry when extensions are hidden, regardless of region", () => {
    const entries = builtinContributions(
      host([
        { id: "pi-advisor", text: "advising…" },
        { id: "unknown-extension", text: "unknown status" },
      ]),
      emptyTotals,
      undefined,
      undefined,
      undefined,
      placements({ kind: "status", id: "pi-advisor", region: "identity", order: 1000 }),
    );
    const ordered = orderedContributions(entries, config({ hidden: ["extensions"] }));
    expect(ordered.some((entry) => entry.id.startsWith("extension."))).toBe(false);
  });
});

describe("applyTextDecorations", () => {
  const effort: CosmicFooterTextContribution = {
    kind: "text",
    id: "effort",
    region: "identity",
    text: "high",
    priority: 95,
    order: 100,
  };
  const decorator: CosmicFooterTextContribution = {
    kind: "text",
    id: "openai.fast",
    region: "identity",
    text: "⚡",
    compactText: "⚡",
    decorates: "effort",
    priority: 80,
    order: 110,
  };

  test("prefixes the decorator text onto the target and consumes the decorator", () => {
    const decorated = applyTextDecorations([effort, decorator]);
    expect(decorated).toHaveLength(1);
    expect(decorated[0]).toMatchObject({ id: "effort", text: "⚡high" });
    expect(decorated[0]?.compactText).toBeUndefined();
  });

  test("decorates the target compact text only when the target declares one", () => {
    const decorated = applyTextDecorations([{ ...effort, compactText: "hi" }, decorator]);
    expect(decorated[0]).toMatchObject({ text: "⚡high", compactText: "⚡hi" });
  });

  test("renders the decorator standalone when its target is absent", () => {
    const decorated = applyTextDecorations([decorator]);
    expect(decorated).toHaveLength(1);
    expect(decorated[0]).toMatchObject({ id: "openai.fast", text: "⚡", order: 110 });
  });

  test("leaves undecorated entries untouched and preserves ordering", () => {
    const model: CosmicFooterTextContribution = {
      kind: "text",
      id: "model",
      region: "identity",
      text: "model",
      order: 0,
    };
    const decorated = applyTextDecorations([model, effort, decorator]);
    expect(decorated.map((entry) => entry.id)).toEqual(["model", "effort"]);
    expect(decorated[0]).toBe(model);
  });
});
