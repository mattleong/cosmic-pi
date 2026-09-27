import { expect, it } from "@effect/vitest";
import { formatDisplayPath } from "../src/platform/paths.ts";

it("shows paths relative to the working directory, then the home directory", () => {
  const home = "/home/user";
  expect(formatDisplayPath("/tmp/project/src/file.ts", "/tmp/project", home)).toBe("src/file.ts");
  expect(formatDisplayPath("/tmp/project", "/tmp/project", home)).toBe(".");
  expect(formatDisplayPath("src/file.ts", "/tmp/project", home)).toBe("src/file.ts");
  expect(formatDisplayPath("/home/user/notes/a.md", "/tmp/project", home)).toBe("~/notes/a.md");
  expect(formatDisplayPath("/home/user", "/tmp/project", home)).toBe("~");
  expect(formatDisplayPath("/var/log/a", "/tmp/project", home)).toBe("/var/log/a");
});

it("treats dot-prefixed child names as inside the working directory", () => {
  expect(formatDisplayPath("/tmp/project/..foo/file.ts", "/tmp/project", "/h")).toBe(
    "..foo/file.ts",
  );
  expect(formatDisplayPath("/tmp/project/../sibling/file.ts", "/tmp/project", "/h")).toBe(
    "/tmp/project/../sibling/file.ts",
  );
});
