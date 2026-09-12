/** Byte accounting only. The official SDK still decodes and parses SSE/JSON. */
export const makeSseBudget = (maximum: number) => {
  let lineBytes = 0;
  let eventBytes = 0;
  let afterCr = false;
  let comment = false;
  return (chunk: Uint8Array): boolean => {
    for (const byte of chunk) {
      if (afterCr && byte === 10) {
        afterCr = false;
        continue;
      }
      afterCr = false;
      if (byte === 10 || byte === 13) {
        if (lineBytes === 0) eventBytes = 0;
        else if (!comment) eventBytes += lineBytes + 1;
        lineBytes = 0;
        comment = false;
        afterCr = byte === 13;
      } else {
        if (lineBytes === 0) comment = byte === 58;
        lineBytes++;
      }
      if (lineBytes > maximum || eventBytes + (comment ? 0 : lineBytes) > maximum) return false;
    }
    return true;
  };
};
