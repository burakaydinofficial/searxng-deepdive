// Shared helper: stream-read an HTTP body up to `cap` bytes, reporting whether
// the cap was hit before the stream ended. Buffering an unbounded body from a
// misconfigured or adversarial upstream would balloon memory regardless of any
// Content-Length lie, so both the URL reader and the SearXNG client cap here.
export async function readTextWithCap(
  body: AsyncIterable<Buffer | Uint8Array | string>,
  cap: number,
): Promise<{ text: string; truncated: boolean }> {
  let total = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of body) {
    const buf =
      typeof chunk === "string"
        ? Buffer.from(chunk)
        : Buffer.isBuffer(chunk)
          ? chunk
          : Buffer.from(chunk);
    if (total + buf.length > cap) {
      const remaining = cap - total;
      if (remaining > 0) chunks.push(buf.subarray(0, remaining));
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(buf);
    total += buf.length;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}
