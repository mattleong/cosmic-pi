import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import { JsonDocumentStore } from "pi-cosmic-core";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import { ShikiAdapter } from "./boundary/shiki";
import { loadCodePreviewSettingsEffect } from "./settings/bootstrap";
import type { CodePreviewSettings } from "./settings/types";
import { disposeShikiEffect, initializeShikiEffect } from "./syntax/shiki";

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
      const documents = yield* JsonDocumentStore;
      const path = yield* Path.Path;
      const shiki = yield* ShikiAdapter;
      const service = CodePreviewSession.of({
        loadSettings: (cwd, projectTrusted) =>
          loadCodePreviewSettingsEffect(cwd, projectTrusted).pipe(
            Effect.provideService(JsonDocumentStore, documents),
            Effect.provideService(Path.Path, path),
          ),
        initializeSyntax: (theme) =>
          initializeShikiEffect(theme).pipe(Effect.provideService(ShikiAdapter, shiki)),
      });
      return yield* Effect.acquireRelease(Effect.succeed(service), () => disposeShikiEffect);
    }),
  );
}
