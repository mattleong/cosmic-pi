import assert from "node:assert/strict";
import { test } from "vitest";
import { getBashWarnings } from "../../src/warnings/bash";

test("getBashWarnings detects destructive command categories", () => {
  for (const [command, warningCount] of [
    ["sudo rm -rf build", 2],
    ["rm -Rf build", 1],
    ["git reset --hard && git clean -fd", 2],
    ["chmod -R 755 build && chown --recursive user build", 2],
    ["docker system prune --all --force", 1],
    ["printf hosts >> /etc/hosts", 1],
  ] as const) {
    assert.equal(getBashWarnings(command).length, warningCount, command);
  }
  assert.equal(getBashWarnings("echo hi").length, 0);
});

test("getBashWarnings flags option tokens and absolute system paths, not lookalike operands", () => {
  for (const command of [
    "rm -rf dir",
    "rm -fr dir",
    "rm -r -f dir",
    "rm --recursive --force dir",
    "/bin/rm -Rf dir",
    "echo 127.0.0.1 > /etc/hosts",
    "printf x >> '/usr/local/etc/app.conf'",
    "git clean --force",
    "git clean -e '*.log' -fd",
  ])
    assert.equal(getBashWarnings(command).length, 1, command);
  for (const command of [
    "git clean --dry-run -d",
    "git clean -nd",
    "git clean -fn",
    "docker run --rm image pytest -rf tests",
    "rm notes-rf.md",
    "rm -r build",
    "rm build-r.log",
    "make > bin/build.log",
    "echo x > var.txt",
    "echo x > ./etc/app.conf",
    "rm tmp.txt\ngrep -r needle .",
  ])
    assert.deepEqual(getBashWarnings(command), [], command);
});
