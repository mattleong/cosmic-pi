import { describe, expect, it } from "vitest";
import { acquireProjectionOwnership } from "../../src/shared/projection-ownership";
import {
  clearSyntaxProjection,
  installSyntaxRequests,
  publishSyntaxProjection,
  requestSyntaxInitialize,
  requestSyntaxLanguage,
  syntaxProjection,
  type CodePreviewSyntaxSnapshot,
} from "../../src/syntax/projection";

const snapshot = (theme: string): CodePreviewSyntaxSnapshot => ({
  theme,
  highlighter: undefined,
  loadedLanguages: [],
  status: {
    initialized: false,
    loadedLanguages: 0,
    pendingLanguages: 0,
    statusVersion: 0,
  },
});

describe("syntax projection ownership", () => {
  it("routes projection and requests only to the newest overlapping session", () => {
    const stale = acquireProjectionOwnership("syntax-stale");
    const current = acquireProjectionOwnership("syntax-current");
    const calls: string[] = [];
    const install = (owner: typeof stale, label: string) =>
      installSyntaxRequests(owner, {
        initialize: () => calls.push(`${label}-initialize`),
        language: () => calls.push(`${label}-language`),
      });
    publishSyntaxProjection(stale, snapshot("stale"));
    install(stale, "stale");

    publishSyntaxProjection(current, snapshot("current"));
    install(current, "current");
    publishSyntaxProjection(stale, snapshot("late-stale"));
    install(stale, "late-stale");
    clearSyntaxProjection(stale);

    requestSyntaxInitialize("theme");
    requestSyntaxLanguage("typescript");
    expect(syntaxProjection()?.theme).toBe("current");
    expect(calls).toEqual(["current-initialize", "current-language"]);
    clearSyntaxProjection(current);

    publishSyntaxProjection(stale, snapshot("after-current-clear"));
    install(stale, "retired");
    requestSyntaxInitialize("theme");
    expect(syntaxProjection()).toBeUndefined();
    expect(calls).toEqual(["current-initialize", "current-language"]);
  });
});
