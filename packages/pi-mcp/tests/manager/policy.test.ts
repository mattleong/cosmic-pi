import { expect, it } from "vitest";
import { serverActions } from "../../src/manager/policy.ts";
import { managerRow } from "../fixtures/manager.ts";

const row = managerRow({ transport: "http", authType: "oauth", auth: "unchecked" });
it("unchecked credentials do not hide local logout and do not imply sign-in is required", () => {
  const actions = serverActions(row, true, true);
  expect(actions.find((choice) => choice.action === "logout")).toMatchObject({
    enabled: true,
    confirmation: expect.any(String),
  });
  expect(actions.find((choice) => choice.action === "connect")?.enabled).toBe(true);
});
it("busy disconnect and logout require confirmation while inspection remains passive", () => {
  const actions = serverActions(
    { ...row, state: "connected", active: 1, operations: 1 },
    true,
    true,
  );
  expect(actions.find((choice) => choice.action === "disconnect")?.confirmation).toBeDefined();
  expect(actions.find((choice) => choice.action === "inspect")?.confirmation).toBeUndefined();
});
it("untrusted or unresolved cleanup servers cannot reconnect or change credentials", () => {
  for (const actions of [
    serverActions(row, false, true),
    serverActions({ ...row, state: "blocked", blockedReason: "cleanup-unconfirmed" }, true, true),
  ]) {
    for (const action of ["connect", "refresh", "auth", "logout"])
      expect(actions.find((choice) => choice.action === action)?.enabled).toBe(false);
  }
});
it("settled auth suspension offers explicit recovery without silently reconnecting", () => {
  const actions = serverActions(
    { ...row, state: "blocked", blockedReason: "auth-suspended" },
    true,
    true,
  );
  expect(actions.find((choice) => choice.action === "auth")?.enabled).toBe(true);
  expect(actions.find((choice) => choice.action === "connect")?.enabled).toBe(false);
});
