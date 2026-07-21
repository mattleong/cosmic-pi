type ProfileSide = "added" | "removed";

export function profileLine(logicalIndex: number, placement: string, side: ProfileSide): string {
  const code = profileIdentifierCode(logicalIndex);
  const changedArguments =
    side === "removed" ? "oldRecord, legacyOptions" : "newAccount, modernSettings, metadata";
  return `const profile${code} = build${code}Profile(profile${code}Type, slot("${placement}"), rank("${placement}"), ${changedArguments});`;
}

export function profilePlacement(position: number, count: number): string {
  if (position * 2 === count - 1) return "center";
  const index = position * 2 < count - 1 ? position : count - position - 1;
  return `${position * 2 < count - 1 ? "cold" : "warm"}${profileIdentifierCode(index).toLowerCase()}`;
}

function profileIdentifierCode(index: number): string {
  return `${String.fromCharCode(65 + Math.floor(index / 26))}${String.fromCharCode(97 + (index % 26))}`;
}
