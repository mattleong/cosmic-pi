import { plainTheme } from "pi-cosmic-core/testing";
import { renderSyntaxHighlightedDiff } from "../src/diff/render";
import { codePreviewSettings, setCodePreviewSettings } from "../src/config/state";
import { renderedWordEmphasisSpans } from "../tests/support/rendered-word-emphasis";
import { wordEmphasisTelemetry } from "../tests/support/word-emphasis-telemetry";
import { benchLog } from "./helpers";

const nodeFsModule = process.getBuiltinModule("node:fs");
if (!nodeFsModule) throw new Error("Node fs builtin is unavailable.");
const { readFileSync } = nodeFsModule;

const args = process.argv.slice(2);
const mode = args.includes("--smart") ? "smart" : "all";
const file = args.find((arg) => !arg.startsWith("--"));
const diff = (file ? readFileSync(file, "utf8") : readFileSync(0, "utf8")).replace(/\r?\n$/, "");

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
