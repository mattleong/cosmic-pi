import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { LocalProcess } from "../../src/boundary/local-process.ts";
import { normalizeConfig } from "../../src/config/options.ts";
import type { BackgroundTaskConfig } from "../../src/config/schema.ts";
import { BackgroundTaskConfigStore } from "../../src/config/store.ts";
import { BackgroundTaskService } from "../../src/task/service.ts";

export const realServiceLayer = (overrides: Partial<BackgroundTaskConfig> = {}) =>
  BackgroundTaskService.layer().pipe(
    Layer.provide(
      Layer.mergeAll(
        LocalProcess.layer,
        Layer.succeed(BackgroundTaskConfigStore, normalizeConfig(overrides)),
        Path.layer,
      ),
    ),
  );
