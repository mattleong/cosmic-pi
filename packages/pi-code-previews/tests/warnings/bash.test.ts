import assert from "node:assert/strict";
import { test } from "vitest";
import { getBashWarnings } from "../../src/warnings/bash";

test("getBashWarnings detects destructive command categories", () => {
  for (const [command, warningCount] of [
    ["sudo rm -rf build", 2],
    ["rm -r -f build", 1],
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
