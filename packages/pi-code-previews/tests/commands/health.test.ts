import { afterEach, expect } from "vitest";
import { it } from "@effect/vitest";
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { extensionContextFixture } from "pi-cosmic-core/testing";
import { healthSubcommand } from "../../src/commands/health";
import { defaultCodePreviewSettings } from "../../src/config/defaults";
import { codePreviewSettings, setCodePreviewSettings } from "../../src/config/state";
import { resetCodePreviewToolStatuses, setCodePreviewToolStatus } from "../../src/tools/status";

const saved = codePreviewSettings;
afterEach(() => {
  setCodePreviewSettings(saved);
  resetCodePreviewToolStatuses(new Set());
});

const healthReport = Effect.fnUntraced(function* () {
  const notices: string[] = [];
  const ctx = extensionContextFixture({
    mode: "rpc",
    ui: { notify: (message: string) => notices.push(message) },
  });
  yield* Effect.promise(() => Promise.resolve(healthSubcommand.handler("", ctx)));
  return Str.split(Arr.join(notices, "\n"), "\n");
});

const toolRow = (lines: readonly string[], tool: string) =>
  Option.getOrUndefined(
    Arr.findFirst(lines, (line) => Fn.pipe(Str.trim(line), Str.startsWith(`${tool}:`))),
  );

it.effect("health gives each tool its own row and says which changes wait for a reload", () =>
  Effect.gen(function* () {
    setCodePreviewSettings({ ...defaultCodePreviewSettings, tools: ["bash", "read"] });
    resetCodePreviewToolStatuses(new Set(["read", "grep"]));
    setCodePreviewToolStatus("read", { state: "installed" });
    const lines = yield* healthReport();
    expect(toolRow(lines, "bash")).toContain("/reload");
    expect(toolRow(lines, "grep")).toContain("/reload");
    expect(toolRow(lines, "read")).not.toContain("/reload");
    expect(toolRow(lines, "write")).not.toContain("/reload");
  }),
);
