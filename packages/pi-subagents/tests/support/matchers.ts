import { expect } from "vitest";

export const anyString = () => {
  const matcher: unknown = expect.any(String);
  return matcher;
};

export const anyNumber = () => {
  const matcher: unknown = expect.any(Number);
  return matcher;
};

export const stringContaining = (expected: string) => {
  const matcher: unknown = expect.stringContaining(expected);
  return matcher;
};

export const objectContaining = (expected: Parameters<typeof expect.objectContaining>[0]) => {
  const matcher: unknown = expect.objectContaining(expected);
  return matcher;
};

export const stringMatching = (expected: RegExp) => {
  const matcher: unknown = expect.stringMatching(expected);
  return matcher;
};

export const anything = () => {
  const matcher: unknown = expect.anything();
  return matcher;
};

export const anyFunction = () => {
  const matcher: unknown = expect.any(Function);
  return matcher;
};
