/** Fast total JSON syntax probe for synchronous render-time language detection. */
export function isValidJsonSyntax(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}
