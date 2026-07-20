// Test/benchmark boundary intentionally reports native timing.
// @effect-diagnostics effect/globalConsole:off
import { synchronousNow as previewNow } from "../src/boundary/clock";
import { resolvePreviewLanguage } from "../src/syntax/language";
import { printBenchHeader, printLayerSummary, runBench } from "./helpers";

printBenchHeader("render boundaries");
const cases = [
  runBench("synchronous clock", "render", "native-boundary", () => {
    previewNow();
  }),
  runBench("small JSON language probe", "render", "pure-boundary", () => {
    resolvePreviewLanguage({ content: '{"name":"preview","values":[1,2,3]}' });
  }),
  runBench("invalid JSON language probe", "render", "pure-boundary", () => {
    resolvePreviewLanguage({ content: '{"name":}' });
  }),
];
printLayerSummary(cases);

const clock = cases[0];
const json = cases[1];
if (!clock || clock.p95Ms > 0.002)
  throw new Error(`Synchronous clock p95 exceeded 0.002ms: ${clock?.p95Ms ?? "missing"}`);
if (!json || json.p95Ms > 0.01)
  throw new Error(`JSON language probe p95 exceeded 0.01ms: ${json?.p95Ms ?? "missing"}`);
