// The Context key intentionally retains its pre-move public identity.
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { ProjectionError } from "pi-cosmic-core";
import { CodePreviewSettingsService } from "../config/store";
import type { CodePreviewSettings } from "../config/schema";
import { CodePreviewSyntaxService } from "../syntax/service";

export interface CodePreviewSessionContract {
  readonly loadSettings: (
    cwd: string,
    projectTrusted: boolean,
  ) => Effect.Effect<CodePreviewSettings, ProjectionError>;
  readonly initializeSyntax: (theme: string) => Effect.Effect<void>;
}

export class CodePreviewSession extends Context.Service<
  CodePreviewSession,
  CodePreviewSessionContract
>()("pi-code-previews/application/service/CodePreviewSession") {
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
