import * as ConfigProvider from "effect/ConfigProvider";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import {
  loadCodePreviewEnvironment,
  performanceConfigFromEnvironment,
  publishCodePreviewEnvironmentProjection,
  type CodePreviewEnvironment,
  type CodePreviewPerformanceConfig,
} from "../config/env";
import { defaultsFromEnvironment } from "./defaults";
import type { CodePreviewSettings } from "./schema";

export interface CodePreviewEnvironmentShape {
  readonly values: CodePreviewEnvironment;
  readonly defaults: CodePreviewSettings;
  readonly performance: CodePreviewPerformanceConfig;
}

export class CodePreviewEnvironmentService extends Context.Service<
  CodePreviewEnvironmentService,
  CodePreviewEnvironmentShape
>()("pi-code-previews/settings/environment-service/CodePreviewEnvironmentService") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const values = yield* loadCodePreviewEnvironment;
      const service = CodePreviewEnvironmentService.of({
        values,
        defaults: Object.freeze(defaultsFromEnvironment(values)),
        performance: performanceConfigFromEnvironment(values),
      });
      publishCodePreviewEnvironmentProjection(service.performance, values.CODE_PREVIEW_TOOLS);
      return service;
    }),
  );

  static readonly layerFrom = (environment: Readonly<Record<string, string>>) =>
    this.layer.pipe(
      Layer.provide(
        Layer.succeed(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: environment })),
      ),
    );
}
