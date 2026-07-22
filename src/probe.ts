/**
 * The cheap path, tried before anything else.
 *
 * Plenty of documents that the Drive UI presents as view-only will still hand over their
 * bytes on /uc?export=download. When that works it replaces the entire render pipeline,
 * so it costs one request to ask.
 *
 * The trap: Google answers blocked downloads with HTTP 200 and an HTML page (virus-scan
 * interstitial, sign-in wall, quota notice). Status and even a successful read prove
 * nothing. Only a PDF content-type plus the %PDF- magic bytes do, which is why this
 * module exists rather than being three lines at the call site.
 */

const DOWNLOAD_ENDPOINT = 'https://drive.google.com/uc?export=download&id=';

/** Beyond this a "quick probe" is no longer quick, and the render path is the better bet. */
const MAX_BYTES = 500 * 1024 * 1024;

/**
 * Covers the whole request including body streaming, since fetch's signal cannot be
 * detached after the headers arrive. Generous enough for a large genuine PDF.
 */
const TIMEOUT_MS = 5 * 60_000;

/** "%PDF-" */
const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d]);

function startsWithMagic(head: Uint8Array): boolean {
  if (head.length < PDF_MAGIC.length) return false;
  return PDF_MAGIC.every((byte, i) => head[i] === byte);
}

/**
 * Returns the file's bytes if Drive genuinely served a PDF, otherwise null.
 * Never throws: a refused probe is the expected outcome and must fall through quietly.
 */
export async function tryDirectDownload(fileId: string): Promise<Uint8Array | null> {
  try {
    const response = await fetch(`${DOWNLOAD_ENDPOINT}${encodeURIComponent(fileId)}`, {
      redirect: 'follow',
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    if (!response.ok || !response.body) {
      await response.body?.cancel();
      return null;
    }

    const contentType = (response.headers.get('content-type') ?? '').toLowerCase();
    if (!contentType.includes('pdf')) {
      // Almost always the HTML interstitial. Drop the body rather than buffer a web page.
      await response.body.cancel();
      return null;
    }

    const declared = Number(response.headers.get('content-length'));
    if (Number.isFinite(declared) && declared > MAX_BYTES) {
      await response.body.cancel();
      return null;
    }

    // Streamed rather than buffered via arrayBuffer() so the size cap and the magic-byte
    // check can abort a bad body instead of holding all of it in memory first.
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    let magicChecked = false;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;

      chunks.push(value);
      total += value.length;

      if (total > MAX_BYTES) {
        await reader.cancel();
        return null;
      }

      // Check the header as soon as five bytes exist, so a mislabelled HTML body is
      // abandoned on the first chunk instead of being downloaded in full.
      if (!magicChecked && total >= PDF_MAGIC.length) {
        if (!startsWithMagic(chunks.length === 1 ? chunks[0]! : concat(chunks, total))) {
          await reader.cancel();
          return null;
        }
        magicChecked = true;
      }
    }

    if (!magicChecked) return null;
    return concat(chunks, total);
  } catch {
    // Network error, timeout, malformed redirect chain: all equivalent to "no fast path".
    return null;
  }
}

function concat(chunks: Uint8Array[], total: number): Uint8Array {
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}
