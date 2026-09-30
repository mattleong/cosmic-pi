// Test/benchmark boundary intentionally exercises native Pi, Node, Promise, timer, and environment APIs.
import assert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import { provideBuiltLayer } from "pi-cosmic-core";
import { test } from "vitest";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import {
  codePreviewPerformanceConfig,
  codePreviewToolsEnvironmentValue,
  CodePreviewEnvironmentService,
  loadCodePreviewEnvironment,
  parseBoolean,
  parsePositiveInteger,
  performanceConfigFromEnvironment,
} from "../../src/config/env";

it.effect("decodes performance thresholds once through Effect Config", () =>
  Effect.gen(function* () {
    const environment = yield* loadCodePreviewEnvironment;
    const performance = performanceConfigFromEnvironment(environment);
    assert.equal(performance.asyncRenderChars, 1234);
    assert.equal(performance.cacheLimit, 192);
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromEnvRecord({
        CODE_PREVIEW_ASYNC_RENDER_CHARS: "1234",
        CODE_PREVIEW_CACHE_LIMIT: "invalid",
      }),
    ),
  ),
);

it.effect("environment overlays settings and publishes local performance projections", () =>
  CodePreviewEnvironmentService.use((service) =>
    Effect.sync(() => {
      assert.equal(service.defaults.shikiTheme, "github-dark");
      assert.equal(service.defaults.diffIntensity, "medium");
      assert.equal(service.defaults.toolCallBackground, "on");
      assert.equal(service.defaults.toolCallCollapsedStyle, "compact");
      assert.equal(service.defaults.readCollapsedLines, 27);
      assert.equal(service.defaults.readContentPreview, false);
      assert.equal(service.defaults.editCollapsedLines, "all");
      assert.equal(service.defaults.pathIcons, "nerd");
      assert.equal(codePreviewPerformanceConfig.cacheLimit, 7);
      assert.equal(codePreviewToolsEnvironmentValue, "grep");
    }),
  ).pipe(
    provideBuiltLayer(
      CodePreviewEnvironmentService.layerFrom({
        CODE_PREVIEW_THEME: "github-dark",
        CODE_PREVIEW_DIFF_INTENSITY: "MEDIUM",
        CODE_PREVIEW_TOOL_CALL_BACKGROUND: "yes",
        CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE: "COMPACT",
        CODE_PREVIEW_READ_LINES: "27",
        CODE_PREVIEW_READ_CONTENT: "off",
        CODE_PREVIEW_EDIT_LINES: "all",
        CODE_PREVIEW_PATH_ICONS: "NERD",
        CODE_PREVIEW_CACHE_LIMIT: "7",
        CODE_PREVIEW_TOOLS: "grep",
        CODE_PREVIEW_UNUSED: undefined,
      }),
    ),
  ),
);

it.effect("invalid environment themes use the authoritative default", () =>
  CodePreviewEnvironmentService.use((service) =>
    Effect.sync(() =>
      assert.equal(service.defaults.shikiTheme, defaultCodePreviewSettings.shikiTheme),
    ),
  ).pipe(
    provideBuiltLayer(
      CodePreviewEnvironmentService.layerFrom({ CODE_PREVIEW_THEME: "private-theme-token" }),
    ),
  ),
);

it.effect("missing or invalid collapsed style environment defaults keep previews", () =>
  Effect.gen(function* () {
    for (const value of [undefined, "invalid", "", "preview"]) {
      yield* CodePreviewEnvironmentService.use((service) =>
        Effect.sync(() => assert.equal(service.defaults.toolCallCollapsedStyle, "preview")),
      ).pipe(
        provideBuiltLayer(
          CodePreviewEnvironmentService.layerFrom({
            CODE_PREVIEW_TOOL_CALL_COLLAPSED_STYLE: value,
          }),
        ),
      );
    }
  }),
);

it.effect("the native MCP startup default is off unless explicitly enabled", () =>
  Effect.gen(function* () {
    const cases: ReadonlyArray<readonly [string | undefined, boolean]> = [
      [undefined, false],
      ["invalid", false],
      ["off", false],
      ["on", true],
      [" yes ", true],
    ];
    for (const [value, expected] of cases) {
      yield* CodePreviewEnvironmentService.use((service) =>
        Effect.sync(() => assert.equal(service.startupDefaults.nativeMcpPreviews, expected)),
      ).pipe(
        provideBuiltLayer(
          CodePreviewEnvironmentService.layerFrom({ CODE_PREVIEW_NATIVE_MCP: value }),
        ),
      );
    }
  }),
);

test("boolean environment values recognize explicit true and false forms", () => {
  for (const value of ["1", "true", "ON", " yes "]) assert.equal(parseBoolean(value), true);
  for (const value of ["0", "false", "OFF", " no "]) assert.equal(parseBoolean(value), false);
});

test("invalid boolean environment values produce no decision", () => {
  for (const value of ["invalid", "", " ", undefined]) assert.equal(parseBoolean(value), undefined);
});

test("positive integer environment values reject fractions and unsafe integers", () => {
  assert.equal(parsePositiveInteger("2"), 2);
  assert.equal(parsePositiveInteger("0.5"), undefined);
  assert.equal(parsePositiveInteger("1.5"), undefined);
  assert.equal(parsePositiveInteger("0"), undefined);
  assert.equal(parsePositiveInteger(String(Number.MAX_SAFE_INTEGER + 1)), undefined);
});
