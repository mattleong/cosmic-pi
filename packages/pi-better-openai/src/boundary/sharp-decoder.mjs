import sharp from "sharp";

// This fixed one-shot process is the native cancellation boundary. Nothing loads
// Sharp in the parent, and no native error or raw pixel leaves this process.
sharp.cache(false);
sharp.concurrency(1);

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.byteLength;
    if (size > 60 * 1024 * 1024) throw new Error("input limit");
    chunks.push(chunk);
  }
  if (size === 0) throw new Error("empty input");
  const bytes = Buffer.concat(chunks, size);
  chunks.length = 0;
  const input = sharp(bytes, {
    animated: true,
    failOn: "error",
    limitInputPixels: 40_000_000,
    sequentialRead: true,
  });
  const { format } = await input.metadata();
  if (!["png", "jpeg", "jpg", "webp", "gif"].includes(format))
    throw new Error("unsupported format");
  // sRGB plus uchar bounds raw output to at most four bytes per pixel, including
  // animation pages. timeout is secondary and cooperative, not cancellation.
  await input.toColourspace("srgb").raw({ depth: "uchar" }).timeout({ seconds: 30 }).toBuffer();
  process.stdout.write(JSON.stringify({ format }));
} catch {
  process.exitCode = 1;
}
