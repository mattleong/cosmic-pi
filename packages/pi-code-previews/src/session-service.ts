import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { CodePreviewSettingsService } from "./settings/service";
import type { CodePreviewSettings } from "./settings/types";
import { CodePreviewSyntaxService } from "./syntax/service";

export interface CodePreviewSessionShape {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
  ) => Effect.Effect<CodePreviewSettings>;
  readonly initializeSyntax: (theme: string) => Effect.Effect<void>;
}

export class CodePreviewSession extends Context.Service<
  CodePreviewSession,
  CodePreviewSessionShape
>()("pi-code-previews/session-service/CodePreviewSession") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const settings = yield* CodePreviewSettingsService;
      const syntax = yield* CodePreviewSyntaxService;
      return CodePreviewSession.of({
        loadSettings: (cwd, projectTrusted) => settings.load({ projectCwd: cwd, projectTrusted }),
        initializeSyntax: syntax.initialize,
      });
    }),
  );
}
