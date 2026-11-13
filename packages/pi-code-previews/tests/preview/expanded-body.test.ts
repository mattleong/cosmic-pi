import assert from "node:assert/strict";
import * as Arr from "effect/Array";
import * as Fn from "effect/Function";
import * as Option from "effect/Option";
import * as Str from "effect/String";
import { plainTheme } from "pi-cosmic-core/testing";
import { test } from "vitest";
import {
  expandedAuthoredText,
  expandedBody,
  expandedDetails,
  expandedFields,
  expandedText,
} from "../../src/preview/expanded-body";

const words = (lines: readonly string[]) =>
  Fn.pipe(Arr.join(lines, " "), Str.split(/\s+/u), Arr.filter(Str.isNonEmpty));

test("an expanded body keeps every field value at phone and desktop widths", () => {
  const command = "pnpm vitest run tests/auth.test.ts --reporter verbose --bail";
  const body = expandedBody(
    expandedFields(plainTheme, [
      { label: "Command", lines: [command, "echo done"] },
      { label: "Notify", lines: ["when it finishes"] },
      { label: "Empty", lines: [] },
    ]),
    expandedText(plainTheme, "Output", ["ok", { text: "boom", tone: "error" }]),
    expandedDetails(plainTheme, ["task-1 · /project", "  pid 4"]),
  );
  for (const width of [180, 57, 24]) {
    const text = words(body.render(width));
    for (const word of [
      ...Str.split(command, " "),
      "echo",
      "done",
      "Notify",
      "boom",
      "task-1",
      "pid",
    ])
      assert.ok(Arr.contains(text, word), `${word} at ${width}`);
    assert.ok(!Arr.contains(text, "Empty"), `an empty field is omitted at ${width}`);
  }
});

test("absent and empty parts take no space", () => {
  const body = expandedBody(
    undefined,
    expandedFields(plainTheme, []),
    expandedText(plainTheme, "Output", []),
    expandedDetails(plainTheme, ["", "   "]),
    expandedAuthoredText(plainTheme, "Message", "  \n "),
  );
  assert.deepEqual(body.render(57), []);
});

test("expanded authored text keeps every line beyond the collapsed budget", () => {
  const text = Arr.join(
    Arr.makeBy(30, (index) => `line ${index + 1}`),
    "\n\n",
  );
  const rows = expandedAuthoredText(plainTheme, "Reply", text).render(57);
  assert.ok(Arr.some(rows, Str.includes("line 30")));
  assert.ok(!Arr.some(rows, Str.includes("more lines")));
});

test("controls in field values are made visible instead of reaching the terminal", () => {
  const rows = expandedFields(plainTheme, [
    { label: "Command", lines: ["echo \u001b[2Jhi"] },
  ]).render(80);
  assert.ok(!Arr.some(rows, Str.includes("\u001b")));
});

test("a wrapped line of facts breaks between whole facts and never ends with a separator", () => {
  const facts =
    "auth-review: agent-1 · reviewer → openai-codex/gpt-5.6-sol:high · 84k tokens · $0.61 · 4m 30s";
  const body = expandedBody(
    expandedDetails(plainTheme, [facts]),
    expandedFields(plainTheme, [{ label: "Run", lines: [facts] }]),
  );
  for (const width of [100, 57, 40]) {
    const rows = Arr.map(body.render(width), Str.trimEnd);
    assert.ok(
      Arr.every(rows, (row) => !/[·→]$/u.test(row)),
      `no row ends with a separator at ${width}`,
    );
    for (const fact of ["84k tokens", "$0.61", "4m 30s"])
      assert.ok(
        Arr.some(rows, (row) => Fn.pipe(row, Str.includes(fact))),
        `${fact} stays whole at ${width}`,
      );
  }
});

test("a value that would wrap past three rows beside its label stacks beneath it", () => {
  const command = Arr.join(
    Arr.makeBy(20, (index) => `--include=package-${index}`),
    " ",
  );
  const rows = expandedFields(plainTheme, [
    { label: "Command", lines: [command] },
    { label: "Notify", lines: ["when it finishes"] },
  ]).render(57);
  const label = Option.getOrThrow(Arr.findFirst(rows, Str.includes("Command")));
  assert.equal(Str.trim(label), "Command");
  assert.deepEqual(
    Arr.filter(words(rows), (word) => Fn.pipe(word, Str.startsWith("--"))),
    Str.split(command, " "),
  );
  // A short value still sits beside its label.
  assert.ok(
    Arr.some(
      rows,
      (row) => Fn.pipe(row, Str.includes("Notify")) && Fn.pipe(row, Str.includes("when")),
    ),
  );
});
