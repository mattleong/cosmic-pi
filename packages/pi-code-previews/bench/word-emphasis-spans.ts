import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderSyntaxHighlightedDiff } from "../src/diff/render";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { renderedWordEmphasisSpans } from "../tests/support/rendered-word-emphasis";
import { wordEmphasisTelemetry } from "../tests/support/word-emphasis-telemetry";
import { benchLog } from "./helpers";

const readInput = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const file = args.find((arg) => !arg.startsWith("--"));
  const text =
    file === undefined
      ? yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString)
      : yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(file)));
  return {
    mode: args.includes("--smart") ? ("smart" as const) : ("all" as const),
    diff: text.replace(/\r?\n$/, ""),
  };
});

const { mode, diff } = await Effect.runPromise(readInput.pipe(Effect.provide(NodeServices.layer)));

setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: mode });

const lineLimit = Math.max(1, diff.split(/\r?\n/).length);
const rendered = renderSyntaxHighlightedDiff(diff, undefined, plainTheme, lineLimit).split("\n");
const spans = rendered.map(renderedWordEmphasisSpans);

benchLog(
  JSON.stringify(
    {
      mode,
      spans,
      telemetry: wordEmphasisTelemetry(diff, lineLimit, mode),
    },
    null,
    2,
  ),
);
