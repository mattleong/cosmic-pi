import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Stdio from "effect/Stdio";
import * as Stream from "effect/Stream";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Str from "effect/String";
import * as Option from "effect/Option";
import { plainTheme } from "pi-cosmic-core/testing";
import { renderSyntaxHighlightedDiff } from "../src/diff/render";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { renderedWordEmphasisSpans } from "../tests/support/rendered-word-emphasis";
import { wordEmphasisTelemetry } from "../tests/support/word-emphasis-telemetry";
import { benchLog } from "./helpers";

const readInput = Effect.gen(function* () {
  const stdio = yield* Stdio.Stdio;
  const args = yield* stdio.args;
  const file = Option.getOrUndefined(
    Arr.findFirst(args, (arg) => !Fn.pipe(arg, Str.startsWith("--"))),
  );
  const text =
    file === undefined
      ? yield* stdio.stdin.pipe(Stream.decodeText, Stream.mkString)
      : yield* FileSystem.FileSystem.pipe(Effect.flatMap((fs) => fs.readFileString(file)));
  return {
    mode: args.includes("--smart") ? ("smart" as const) : ("all" as const),
    diff: Fn.pipe(text, Str.replace(/\r?\n$/, "")),
  };
});

const { mode, diff } = await Effect.runPromise(readInput.pipe(Effect.provide(NodeServices.layer)));

setCodePreviewSettings({ ...codePreviewSettings, wordEmphasis: mode });

const lineLimit = Math.max(1, Str.split(diff, /\r?\n/).length);
const rendered = Str.split(
  renderSyntaxHighlightedDiff(diff, undefined, plainTheme, lineLimit),
  "\n",
);
const spans = Arr.map(rendered, renderedWordEmphasisSpans);

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
